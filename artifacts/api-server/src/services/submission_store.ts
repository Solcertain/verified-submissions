import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { and, eq, or } from "drizzle-orm";
import { SOLCERTAIN_CUSTOMER_ID } from "@workspace/db/schema";
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
