import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

// The weekly list of leads a person should confirm as fraud or genuine. Labels
// are what calibrate the engine, so the queue is built to give the most
// information per minute of review:
//   - every lead the engine held back (did it hold back a real person?)
//   - every return whose buyer reason sounds like fraud (did it let one through?)
//   - a few random approved leads as a control (is "approved" trustworthy?)
// Leads already labelled never reappear. No contact details are returned; the
// buyer's return text is, because it is the evidence the reviewer judges.

let db: NodePgDatabase | undefined;
function getDb(): NodePgDatabase {
  if (db) return db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set");
  db = drizzle(new pg.Pool({ connectionString: url }));
  return db;
}

// Buyer return wording that points at a lead the person never submitted, or a
// person who is not real. Kept broad: a false entry here costs one click.
export const FRAUD_RETURN_PATTERN =
  "(did ?n.?t|never) (submit|fill|request|sign)|not a real (person|number)|fake|not the home ?owner|does not own|wrong (number|person)|no one by that name|never heard";

export const CONTROL_SAMPLE = 5;

export type QueueReason = "held_back" | "fraud_return" | "control";

export interface QueueItem {
  analysis_id: string;
  reason: QueueReason;
  received_at: string;
  score: number | null;
  status: string | null;
  flags: string[];
  shadow_flags: string[];
  evidence: string[];
  device: string | null;
  is_mobile: boolean | null;
  kpm: number | null;
  wpm: number | null;
  seconds_on_page: number | null;
  outcome: string | null;
  return_reason: string | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function shadow_flags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((f) => (f as { flag?: unknown }).flag).filter((f): f is string => typeof f === "string");
}

// Held-back leads first, then fraud-sounding returns, then the control sample.
// A lead that qualifies twice appears once, under its first reason.
export function assemble_queue(
  held_back: QueueItem[],
  fraud_returns: QueueItem[],
  control: QueueItem[],
): QueueItem[] {
  const seen = new Set<string>();
  const out: QueueItem[] = [];
  for (const item of [...held_back, ...fraud_returns, ...control]) {
    if (seen.has(item.analysis_id)) continue;
    seen.add(item.analysis_id);
    out.push(item);
  }
  return out;
}

export async function load_label_queue(days: number, customer_id?: string): Promise<QueueItem[]> {
  const only_customer = customer_id ? sql` and l.customer_id = ${customer_id}::uuid` : sql``;
  // The control sample is ordered by a hash of the id and the ISO week, so it is
  // stable while the reviewer works through it and changes week to week.
  const r = await getDb().execute(sql`
    with recent as (
      select l.id, l.received_at, l.certificate_url, l.status, l.score_json, l.trustedform_raw_json
        from lead_submissions l
       where l.received_at > now() - make_interval(days => ${days})${only_customer}
         and not exists (
           select 1 from lead_outcomes o
            where o.analysis_id = l.id and o.outcome in ('confirmed_fraud', 'confirmed_genuine'))
    ),
    with_outcome as (
      select r.*,
             (select string_agg(distinct o.outcome, ',') from lead_outcomes o
               where (o.analysis_id = r.id or o.certificate_url = r.certificate_url)
                 and o.outcome in ('sold', 'unsold', 'returned')) as outcome,
             (select string_agg(o.return_reason, ' | ') from lead_outcomes o
               where (o.analysis_id = r.id or o.certificate_url = r.certificate_url)
                 and o.outcome = 'returned') as return_reason
        from recent r
    ),
    tagged as (
      select w.*,
             case
               when w.status in ('review', 'reject') then 'held_back'
               when w.return_reason ~* ${FRAUD_RETURN_PATTERN} then 'fraud_return'
               else null
             end as reason,
             row_number() over (
               partition by (w.status = 'approved' and w.return_reason is null)
               order by md5(w.id::text || to_char(now(), 'IYYY-IW'))
             ) as control_rank
        from with_outcome w
    )
    select id, received_at, status, outcome, return_reason,
           coalesce(reason, 'control') as reason,
           score_json->>'value' as score,
           score_json->'risk_flags' as flags,
           score_json->'shadow_findings' as shadow,
           score_json->'explanations' as evidence,
           trustedform_raw_json->'insights'->'properties'->'os'->>'full' as device,
           trustedform_raw_json->'insights'->'properties'->'os'->>'is_mobile' as is_mobile,
           trustedform_raw_json->'insights'->'properties'->>'form_input_kpm' as kpm,
           trustedform_raw_json->'insights'->'properties'->>'form_input_wpm' as wpm,
           trustedform_raw_json->'insights'->'properties'->>'seconds_on_page' as seconds
      from tagged
     where reason is not null
        or (status = 'approved' and return_reason is null and control_rank <= ${CONTROL_SAMPLE})
     order by received_at desc`);

  const items = (r.rows as Record<string, unknown>[]).map(
    (row): QueueItem => ({
      analysis_id: String(row["id"]),
      reason: row["reason"] as QueueReason,
      received_at: new Date(String(row["received_at"])).toISOString(),
      score: num(row["score"]),
      status: (row["status"] as string) ?? null,
      flags: strings(row["flags"]),
      shadow_flags: shadow_flags(row["shadow"]),
      evidence: strings(row["evidence"]),
      device: (row["device"] as string) ?? null,
      is_mobile: row["is_mobile"] == null ? null : row["is_mobile"] === "true",
      kpm: num(row["kpm"]),
      wpm: num(row["wpm"]),
      seconds_on_page: num(row["seconds"]),
      outcome: (row["outcome"] as string) ?? null,
      return_reason: (row["return_reason"] as string) ?? null,
    }),
  );
  return assemble_queue(
    items.filter((i) => i.reason === "held_back"),
    items.filter((i) => i.reason === "fraud_return"),
    items.filter((i) => i.reason === "control"),
  );
}
