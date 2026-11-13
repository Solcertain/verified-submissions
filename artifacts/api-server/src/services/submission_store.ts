import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { and, eq, or, sql } from "drizzle-orm";
import { SOLCERTAIN_CUSTOMER_ID } from "./customer_tables.js";
import pg from "pg";
import { logger } from "../lib/logger.js";

const { Pool } = pg;

export const leadSubmissionsTable = pgTable(
  "lead_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    certificate_url: text("certificate_url"),
    certificate_id: text("certificate_id"),
    raw_payload_json: jsonb("raw_payload_json"),
    trustedform_raw_json: jsonb("trustedform_raw_json"),
    parsed_submission_json: jsonb("parsed_submission_json"),
    score_json: jsonb("score_json"),
    status: text("status"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    customer_id: uuid("customer_id").default(SOLCERTAIN_CUSTOMER_ID),
  },
  (table) => [
    // The certificate cache is per customer (migration 0003).
    uniqueIndex("lead_submissions_customer_certificate_idx").on(table.customer_id, table.certificate_url),
  ],
);

const schema = { leadSubmissionsTable };

export type LeadSubmission = typeof leadSubmissionsTable.$inferSelect;
export type InsertLeadSubmission = typeof leadSubmissionsTable.$inferInsert;

let db: NodePgDatabase<typeof schema> | undefined;

function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema });
  return db;
}

export type SaveSubmissionInput = {
  // Whose lead this is. Defaults to Solcertain, which owns every row written
  // before customer accounts.
  customer_id?: string;
  certificate_url?: string;
  certificate_id?: string;
  raw_payload_json?: Record<string, unknown>;
  trustedform_raw_json?: Record<string, unknown>;
  parsed_submission_json?: Record<string, unknown>;
  score_json?: Record<string, unknown>;
  status?: string;
  processed_at?: Date;
};

// Upsert a lead submission row.
// If this customer already has a row for the certificate_url, update it in-place.
// If no certificate_url is provided (e.g. from-text route), always insert a new row.
// Storage errors are caught and logged so callers never see an exception.
export async function save_submission(
  input: SaveSubmissionInput,
): Promise<LeadSubmission | null> {
  try {
    const client = getDb();
    const row: InsertLeadSubmission = {
      customer_id: input.customer_id ?? SOLCERTAIN_CUSTOMER_ID,
      certificate_url: input.certificate_url ?? null,
      certificate_id: input.certificate_id ?? null,
      raw_payload_json: input.raw_payload_json ?? null,
      trustedform_raw_json: input.trustedform_raw_json ?? null,
      parsed_submission_json: input.parsed_submission_json ?? null,
      score_json: input.score_json ?? null,
      status: input.status ?? null,
      processed_at: input.processed_at ?? new Date(),
    };

    if (input.certificate_url) {
      // Upsert — dedup on (customer_id, certificate_url)
      const [saved] = await client
        .insert(leadSubmissionsTable)
        .values(row)
        .onConflictDoUpdate({
          target: [leadSubmissionsTable.customer_id, leadSubmissionsTable.certificate_url],
          set: {
            certificate_id: row.certificate_id,
            raw_payload_json: row.raw_payload_json,
            trustedform_raw_json: row.trustedform_raw_json,
            parsed_submission_json: row.parsed_submission_json,
            score_json: row.score_json,
            status: row.status,
            processed_at: row.processed_at,
          },
        })
        .returning();
      return saved ?? null;
    } else {
      // No cert URL (from-text) — always insert a fresh row
      const [saved] = await client
        .insert(leadSubmissionsTable)
        .values(row)
        .returning();
      return saved ?? null;
    }
  } catch (err) {
    logger.error({ err }, "submission_store: save_submission failed");
    return null;
  }
}

// Look up a previously processed submission by certificate URL or certificate ID,
// among this customer's rows only: one customer's analysis is never served to
// another. Returns null if not found or if the DB call fails.
export async function get_submission_by_certificate(
  customer_id: string,
  certificate_url?: string,
  certificate_id?: string,
): Promise<LeadSubmission | null> {
  if (!certificate_url && !certificate_id) return null;

  try {
    const client = getDb();
    const conditions = [];
    if (certificate_url) {
      conditions.push(eq(leadSubmissionsTable.certificate_url, certificate_url));
    }
    if (certificate_id) {
      conditions.push(eq(leadSubmissionsTable.certificate_id, certificate_id));
    }

    const [row] = await client
      .select()
      .from(leadSubmissionsTable)
      .where(
        and(
          eq(leadSubmissionsTable.customer_id, customer_id),
          conditions.length === 1 ? conditions[0]! : or(...conditions),
        ),
      )
      .limit(1);

    return row ?? null;
  } catch (err) {
    logger.error({ err }, "submission_store: get_submission_by_certificate failed");
    return null;
  }
}

// Other leads for this customer whose phone or email matches, on a different
// certificate, within the last window_days. Compares the normalized values the
// certificate-reuse check already keeps in raw_payload_json (last ten digits of
// the phone, lowercased email). Returns undefined when there is nothing to
// compare or the lookup fails: a storage problem never costs a lead points.
export async function find_prior_submissions(
  customer_id: string,
  certificate_url: string,
  phone: string | null,
  email: string | null,
  window_days: number,
): Promise<{ count: number; days_since_last: number } | undefined> {
  const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
  const p = digits.length === 10 ? digits : "";
  const e = (email ?? "").trim().toLowerCase();
  if (!p && !e) return undefined;
  try {
    const client = getDb();
    const result = await client.execute(sql`
      select count(distinct certificate_url)::int as count,
             extract(epoch from (now() - max(received_at))) / 86400 as days
        from lead_submissions
       where customer_id = ${customer_id}
         and certificate_url is distinct from ${certificate_url}
         and received_at > now() - make_interval(days => ${window_days})
         and (
           (${p}::text <> '' and right(regexp_replace(coalesce(raw_payload_json->>'phone', ''), '[^0-9]', '', 'g'), 10) = ${p}::text)
           or (${e}::text <> '' and lower(trim(coalesce(raw_payload_json->>'email', ''))) = ${e}::text)
         )`);
    const row = result.rows[0] as { count: number; days: string | number | null } | undefined;
    if (!row || !row.count) return undefined;
    return { count: Number(row.count), days_since_last: Number(row.days ?? 0) };
  } catch (err) {
    logger.error({ err }, "submission_store: find_prior_submissions failed");
    return undefined;
  }
}
