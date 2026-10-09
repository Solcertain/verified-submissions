import { eq, desc } from "drizzle-orm";
import { db, leadOutcomesTable, leadSubmissionsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { normalize_certificate_url } from "./trustedform_client.js";

// Records the fate of a lead so the authenticity model can eventually be
// measured rather than asserted. See docs/MVP_STATUS.md — without labels the
// scoring weights are informed guesses and cannot be validated.

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

function first_string(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
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
  const lead = (typeof nested === "object" && nested !== null ? nested : raw) as Record<
    string,
    unknown
  >;

  const merged: Record<string, unknown> = { ...lead, ...raw };

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
    supplier: first_string(merged, ["supplier", "supplier_name", "lp_supplier_id"]),
    raw,
  };
}

export interface StoredOutcome {
  id: string;
  analysis_id: string | null;
}

export async function save_outcome(payload: OutcomePayload): Promise<StoredOutcome | null> {
  // Link to an existing analysis when we have one. Normalizing first matters:
  // Lead Prosper stores the certificate URL as the publisher sent it, which may
  // carry the browser path we strip at claim time.
  let analysis_id: string | null = null;
  const normalized_url = payload.certificate_url
    ? normalize_certificate_url(payload.certificate_url)
    : null;

  if (normalized_url) {
    try {
      const rows = await db
        .select({ id: leadSubmissionsTable.id })
        .from(leadSubmissionsTable)
        .where(eq(leadSubmissionsTable.certificate_url, normalized_url))
        .orderBy(desc(leadSubmissionsTable.received_at))
        .limit(1);
      analysis_id = rows[0]?.id ?? null;
    } catch (err) {
      // An unlinked label is still a label. Never lose one over a lookup.
      logger.warn({ err }, "Could not look up analysis for outcome");
    }
  }

  try {
    const inserted = await db
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
