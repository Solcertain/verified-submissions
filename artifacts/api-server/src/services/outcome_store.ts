import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { and, eq, desc, ne, sql } from "drizzle-orm";
import pg from "pg";
import { logger } from "../lib/logger.js";
import { leadSubmissionsTable } from "./submission_store.js";
import { normalize_certificate_url } from "./trustedform_client.js";
import { scrub_pii } from "./pii.js";
import { SOLCERTAIN_CUSTOMER_ID } from "@workspace/db/schema";

const { Pool } = pg;

// Records the fate of a lead so the authenticity model can eventually be
// measured rather than asserted. See docs/MVP_STATUS.md — without labels the
// scoring weights are informed guesses and cannot be validated.
//
// The table is declared here rather than imported from @workspace/db, matching
// submission_store. That package builds a connection pool at module scope, so
// importing it crashes the whole function at import time on any serverless
// invocation where the connection cannot be made. Connections are lazy here.
// lib/db/src/schema stays the source of truth for migrations.

export const leadOutcomesTable = pgTable(
  "lead_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    lp_lead_id: text("lp_lead_id"),
    certificate_url: text("certificate_url"),
    outcome: text("outcome"),
    buyer: text("buyer"),
    sell_price: numeric("sell_price"),
    return_reason: text("return_reason"),
    supplier: text("supplier"),
    raw_payload_json: jsonb("raw_payload_json"),
    analysis_id: uuid("analysis_id"),
    customer_id: uuid("customer_id").default(SOLCERTAIN_CUSTOMER_ID),
  },
  (table) => [
    index("lead_outcomes_lp_lead_id_idx").on(table.lp_lead_id),
    index("lead_outcomes_certificate_url_idx").on(table.certificate_url),
  ],
);

const schema = { leadOutcomesTable, leadSubmissionsTable };

let db: NodePgDatabase<typeof schema> | undefined;

function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }
  db = drizzle(new Pool({ connectionString: databaseUrl }), { schema });
  return db;
}

export interface OutcomePayload {
  lp_lead_id: string | null;
  certificate_url: string | null;
  outcome: string | null;
  buyer: string | null;
  sell_price: string | null;
  return_reason: string | null;
  supplier: string | null;
  raw: Record<string, unknown>;
}

function first_string(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

// Lead Prosper's trigger payload shape is not contractually fixed and differs
// between trigger types, so every field is read from a list of plausible keys
// and a miss is recorded as null rather than guessed at.
export function normalize_outcome_payload(body: unknown): OutcomePayload {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  // Some trigger types nest the lead under lead_data.
  const nested = raw["lead_data"];
  const lead = (typeof nested === "object" && nested !== null ? nested : {}) as Record<
    string,
    unknown
  >;
  const merged: Record<string, unknown> = { ...lead, ...raw };

  // supplier arrives as either a string or an object with a name.
  const supplier_raw = merged["supplier"];
  const supplier =
    typeof supplier_raw === "object" && supplier_raw !== null
      ? first_string(supplier_raw as Record<string, unknown>, ["name", "id"])
      : first_string(merged, ["supplier", "supplier_name", "lp_supplier_id"]);

  return {
    lp_lead_id: first_string(merged, ["lp_lead_id", "lead_id", "id"]),
    certificate_url: first_string(merged, [
      "trustedform_cert_url",
      "certificate_url",
      "trustedform_url",
      "xxTrustedFormCertUrl",
    ]),
    outcome: first_string(merged, ["status", "outcome", "lead_status"]),
    buyer: first_string(merged, ["buyer", "buyer_name", "lp_buyer"]),
    sell_price: first_string(merged, ["sell_price", "lp_lead_sell_price", "revenue", "price"]),
    return_reason: first_string(merged, ["return_reason", "error_message"]),
    supplier,
    raw: scrub_pii(raw),
  };
}

export interface StoredOutcome {
  id: string;
  analysis_id: string | null;
}

// customer_id is whoever the callback token belongs to. The outcome is linked
// only to that customer's own analysis of the certificate.
export async function save_outcome(
  payload: OutcomePayload,
  customer_id: string = SOLCERTAIN_CUSTOMER_ID,
): Promise<StoredOutcome | null> {
  // Normalizing the URL matters: Lead Prosper stores the certificate URL as the
  // publisher sent it, which may carry the browser path we strip at claim time.
  const normalized_url = payload.certificate_url
    ? normalize_certificate_url(payload.certificate_url)
    : null;

  let analysis_id: string | null = null;
  if (normalized_url) {
    try {
      const rows = await getDb()
        .select({ id: leadSubmissionsTable.id })
        .from(leadSubmissionsTable)
        .where(
          and(
            eq(leadSubmissionsTable.certificate_url, normalized_url),
            eq(leadSubmissionsTable.customer_id, customer_id),
          ),
        )
        .orderBy(desc(leadSubmissionsTable.received_at))
        .limit(1);
      analysis_id = rows[0]?.id ?? null;
    } catch (err) {
      // An unlinked label is still a label. Never lose one over a lookup.
      logger.warn({ err }, "Could not look up analysis for outcome");
    }
  }

  try {
    const inserted = await getDb()
      .insert(leadOutcomesTable)
      .values({
        lp_lead_id: payload.lp_lead_id,
        certificate_url: normalized_url,
        outcome: payload.outcome,
        buyer: payload.buyer,
        sell_price: payload.sell_price,
        return_reason: payload.return_reason,
        supplier: payload.supplier,
        raw_payload_json: payload.raw,
        analysis_id,
        customer_id,
      })
      .returning({ id: leadOutcomesTable.id });

    const id = inserted[0]?.id ?? null;
    if (!id) return null;

    logger.info(
      { outcome: payload.outcome, linked: analysis_id !== null, supplier: payload.supplier },
      "Recorded lead outcome",
    );
    return { id, analysis_id };
  } catch (err) {
    logger.error({ err }, "Failed to store lead outcome");
    return null;
  }
}

// Whether this lead already has an outcome of this kind, so a repeated sync
// does not record the same return twice.
export async function has_outcome(lp_lead_id: string, outcome: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: leadOutcomesTable.id })
    .from(leadOutcomesTable)
    .where(and(eq(leadOutcomesTable.lp_lead_id, lp_lead_id), eq(leadOutcomesTable.outcome, outcome)))
    .limit(1);
  return rows.length > 0;
}

// Return categories are keyword rules that improve over time. Re-running the
// sync re-applies the current rules to returns already stored, so a category
// never stays stuck on an older rule set. Returns how many rows changed.
export async function refresh_return_category(
  lp_lead_id: string,
  category: string,
  bears_on_verification: boolean,
): Promise<number> {
  const patch = JSON.stringify({ return_category: category, bears_on_verification });
  const rows = await getDb()
    .update(leadOutcomesTable)
    .set({
      raw_payload_json: sql`coalesce(${leadOutcomesTable.raw_payload_json}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(
      and(
        eq(leadOutcomesTable.lp_lead_id, lp_lead_id),
        eq(leadOutcomesTable.outcome, "returned"),
        ne(sql`coalesce(${leadOutcomesTable.raw_payload_json}->>'return_category', '')`, category),
      ),
    )
    .returning({ id: leadOutcomesTable.id });
  return rows.length;
}

// ── Operator labels ─────────────────────────────────────────────────────────
//
// A person who has checked a lead (a buyer call, a fraud investigation) can
// confirm it as fraud or as genuine. These are the strongest labels we get and
// the evidence customers see: "the engine held this lead back at intake, and it
// was later confirmed as fraud".
//
// The engine's decision is copied into the label when it is recorded, so the
// proof does not change if the model or the stored score is updated later.

export const OPERATOR_LABELS = { fraud: "confirmed_fraud", genuine: "confirmed_genuine" } as const;
export type OperatorLabel = keyof typeof OPERATOR_LABELS;

export interface OperatorLabelInput {
  analysis_id?: string;
  certificate_url?: string;
  lp_lead_id?: string;
  label: OperatorLabel;
  reason?: string;
  labelled_by?: string;
}

export interface StoredLabel {
  id: string;
  analysis_id: string;
  outcome: string;
  already_recorded: boolean;
  engine: { score: number | null; status: string | null; flags: string[]; model_version: string | null; scored_at: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Finds the scored lead a label refers to. Returns null when nothing matches;
// a label we cannot tie to a score proves nothing, so it is not stored.
async function find_submission(input: OperatorLabelInput) {
  const t = leadSubmissionsTable;
  const cols = {
    id: t.id,
    received_at: t.received_at,
    certificate_url: t.certificate_url,
    status: t.status,
    score_json: t.score_json,
    lp_lead_id: sql<string | null>`${t.raw_payload_json}->>'lp_lead_id'`,
    supplier: sql<string | null>`${t.raw_payload_json}->>'lp_supplier_id'`,
  };
  let where;
  if (input.analysis_id) {
    if (!UUID.test(input.analysis_id)) return null;
    where = eq(t.id, input.analysis_id);
  } else if (input.certificate_url) {
    where = eq(t.certificate_url, normalize_certificate_url(input.certificate_url));
  } else if (input.lp_lead_id) {
    where = sql`${t.raw_payload_json}->>'lp_lead_id' = ${input.lp_lead_id}`;
  } else {
    return null;
  }
  const rows = await getDb().select(cols).from(t).where(where).orderBy(desc(t.received_at)).limit(1);
  return rows[0] ?? null;
}

export async function save_operator_label(input: OperatorLabelInput): Promise<StoredLabel | null> {
  const sub = await find_submission(input);
  if (!sub) return null;

  const outcome = OPERATOR_LABELS[input.label];
  const score = (sub.score_json ?? {}) as Record<string, unknown>;
  const engine = {
    score: typeof score["value"] === "number" ? (score["value"] as number) : null,
    status: sub.status ?? null,
    flags: Array.isArray(score["risk_flags"]) ? (score["risk_flags"] as string[]) : [],
    model_version: typeof score["model_version"] === "string" ? (score["model_version"] as string) : null,
    scored_at: sub.received_at.toISOString(),
  };

  // Recording the same label twice is a no-op, so a retried request or a
  // double click cannot inflate the counts.
  const existing = await getDb()
    .select({ id: leadOutcomesTable.id })
    .from(leadOutcomesTable)
    .where(and(eq(leadOutcomesTable.analysis_id, sub.id), eq(leadOutcomesTable.outcome, outcome)))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, analysis_id: sub.id, outcome, already_recorded: true, engine };

  const inserted = await getDb()
    .insert(leadOutcomesTable)
    .values({
      lp_lead_id: sub.lp_lead_id,
      certificate_url: sub.certificate_url,
      outcome,
      supplier: sub.supplier,
      analysis_id: sub.id,
      raw_payload_json: {
        source: "manual_review",
        labelled_by: input.labelled_by?.slice(0, 80) ?? "operator",
        reason: input.reason?.slice(0, 500) ?? null,
        return_category: input.label === "fraud" ? "fraud" : null,
        bears_on_verification: true,
        engine_score: engine.score,
        engine_status: engine.status,
        engine_flags: engine.flags,
        model_version: engine.model_version,
        scored_at: engine.scored_at,
      },
    })
    .returning({ id: leadOutcomesTable.id });

  const id = inserted[0]?.id;
  if (!id) return null;
  logger.info({ outcome, engine_status: engine.status }, "Recorded operator label");
  return { id, analysis_id: sub.id, outcome, already_recorded: false, engine };
}
