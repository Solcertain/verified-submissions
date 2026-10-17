import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { ReportOutcome, ReportSubmission } from "./verification_report.js";
import { read_stored_features } from "./leadprosper_flat_fields.js";
import { score_authenticity } from "./authenticity_scorer.js";
import { status_for } from "./verdict.js";

// Reads exactly the columns the verification report needs — scores, flags,
// outcomes and the lead's source — and nothing personal. Connection is lazy,
// matching submission_store and outcome_store.

let db: NodePgDatabase | undefined;
function getDb(): NodePgDatabase {
  if (db) return db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set");
  db = drizzle(new pg.Pool({ connectionString: url }));
  return db;
}

function host(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function load_report_rows(
  start: Date,
  end: Date,
): Promise<{ subs: ReportSubmission[]; outcomes: ReportOutcome[] }> {
  const s = await getDb().execute(sql`
    select id, received_at,
           score_json->>'value' as score, status,
           score_json->>'classification' as classification,
           score_json->>'model_version' as model_version,
           score_json->'consent'->>'verdict' as consent_verdict,
           score_json->'risk_flags' as risk_flags,
           score_json->'shadow_findings' as shadow_findings,
           raw_payload_json->>'lead_source' as lead_source,
           parsed_submission_json->'features'->>'page_url' as page_url,
           parsed_submission_json->'features'->>'is_mobile' as is_mobile,
           case when score_json->>'model_version' is null then parsed_submission_json end as stored_for_rescore
    from lead_submissions
    where received_at >= ${start.toISOString()} and received_at < ${end.toISOString()}`);

  const subs: ReportSubmission[] = (s.rows as Record<string, unknown>[]).map((r) => {
    const legacy_version = r["model_version"] === "legacy-event-log";
    const shadow = Array.isArray(r["shadow_findings"]) ? (r["shadow_findings"] as { flag?: string }[]) : [];
    const source = (typeof r["lead_source"] === "string" && r["lead_source"]) || host(r["page_url"]) || "unknown";
    const is_mobile = r["is_mobile"] == null ? null : r["is_mobile"] === "true";

    // Rows stored before 2026-10-17 hold the legacy score, though the lead
    // was scored by the insights model at the time. Their features are
    // stored, so rescore them under the current model, as repeat requests do.
    const stored = r["stored_for_rescore"] ? read_stored_features(r["stored_for_rescore"]) : null;
    if (stored) {
      const a = score_authenticity(stored);
      return {
        id: String(r["id"]),
        received_at: new Date(String(r["received_at"])),
        score: a.score,
        status: status_for(a),
        classification: a.classification,
        model_version: a.model_version,
        consent_verdict: a.consent.verdict,
        risk_flags: a.risk_flags,
        shadow_flags: a.shadow_findings.map((f) => f.flag).filter((f): f is string => !!f),
        source,
        is_mobile,
        rescored: true,
      };
    }
    return {
      id: String(r["id"]),
      received_at: new Date(String(r["received_at"])),
      score: r["score"] == null ? null : Number(r["score"]),
      status: (r["status"] as string) ?? null,
      classification: (r["classification"] as string) ?? null,
      model_version: legacy_version ? null : ((r["model_version"] as string) ?? null),
      consent_verdict: (r["consent_verdict"] as string) ?? null,
      risk_flags: Array.isArray(r["risk_flags"]) ? (r["risk_flags"] as string[]) : [],
      shadow_flags: shadow.map((f) => f.flag).filter((f): f is string => !!f),
      source,
      is_mobile,
      rescored: false,
    };
  });

  const ids = subs.map((x) => x.id);
  if (ids.length === 0) return { subs, outcomes: [] };
  const o = await getDb().execute(sql`
    select analysis_id, outcome, raw_payload_json->>'return_category' as return_category
    from lead_outcomes
    where analysis_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);

  const outcomes: ReportOutcome[] = (o.rows as Record<string, unknown>[]).map((r) => ({
    analysis_id: (r["analysis_id"] as string) ?? null,
    outcome: (r["outcome"] as string) ?? null,
    return_category: (r["return_category"] as string) ?? null,
  }));
  return { subs, outcomes };
}
