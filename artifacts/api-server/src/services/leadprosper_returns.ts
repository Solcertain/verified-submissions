import type { OutcomePayload } from "./outcome_store.js";

// Returns are the most valuable label the engine can get: a buyer telling us a
// lead was bad, and why. Lead Prosper trigger conditions have no "Returned"
// status, so returns are pulled from its API instead of pushed.

const LP_BASE = "https://api.leadprosper.io/public";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 50;

// What a return reason says about the lead. Only some categories bear on
// verification; the rest are real people a buyer could not use, and must never
// be fed to the authenticity model as negatives.
export type ReturnCategory =
  | "fraud" // fake, bot, made-up details
  | "contact_invalid" // wrong number, disconnected, bad email
  | "consent_dispute" // the person says they never asked
  | "duplicate" // the same consumer sold before
  | "lead_quality" // real but unsellable: credit, renter, out of area, not interested
  | "other";

// Bears on authenticity or consent. These are the negative labels calibration uses.
export const VERIFICATION_CATEGORIES: readonly ReturnCategory[] = [
  "fraud",
  "contact_invalid",
  "consent_dispute",
];

// First match wins, so the most serious readings are checked first.
// Tuned on the 33 real returns pulled 2026-10-17 (Aug 18 - Oct 17, campaign
// 23668). Buyers write freely, with typos: test new phrasings against
// leadprosper_returns.test.ts before relying on them.
const RULES: [ReturnCategory, RegExp][] = [
  ["fraud", /\b(fraud|fake|bot|scam|spam|bogus|made[- ]?up|fictitious|test lead|gibberish|nonsense|not a real (person|lead|customer|name))\b/i],
  ["consent_dispute", /\b(never (filled|submitted|requested|signed|asked|applied)|didn'?t (fill|request|submit|ask|apply)|did not (fill|request|submit|ask|apply)|no recollection|not requested|unsolicited|consent|dnc|do not call|stop calling|tcpa|litigat|opted? ?out|unsubscrib)/i],
  ["contact_invalid", /\b(wrong (number|person|phone|email)|disconnected|invalid (phone|number|email)|bad (phone|number|email)|not in service|no such|unreachable|non[- ]?working|not a working|voicemail full|number (not|doesn'?t) (work|exist)|(number|phone) (is )?(associated|belongs) (with|to))/i],
  ["duplicate", /\b(dup(e|licate)?s?|repeat(ed)?|same lead|received this (same )?lead)\b/i],
  ["lead_quality", /\b(credit|renter|rent(s|ing)?|not (a |the )?home ?owner|(does ?n[o']t|doesnt) own|owned by|not interested|territor\w*|coverage|zip|not in (my |our |the )?area|out of (my|our|the) \w+|out of (area|state|range)|outside|hours? from|utility|power company|electric company|has solar|already (has|have)|shade|roof|budget|price|condo|apartment|mobile home|manufactured|too (small|low)|bill|disqualif|unqualified)/i],
];

export function categorize_return_reason(reason: string | null | undefined): ReturnCategory {
  const text = (reason ?? "").trim();
  if (!text) return "other";
  for (const [category, pattern] of RULES) if (pattern.test(text)) return category;
  return "other";
}

interface LpBuyer {
  name?: string;
  sell_price?: number;
  returned?: boolean;
  return_reason?: string;
}

export interface LpLead {
  id?: string;
  lead_date_ms?: string;
  revenue?: number;
  returned?: boolean;
  return_reason?: string;
  lead_data?: { trustedform_cert_url?: string; vs_analysis_id?: string; vs_score?: string; vs_model_version?: string };
  supplier?: { name?: string };
  buyers?: LpBuyer[];
}

// Builds the outcome row for a returned lead. Only identifiers, the reason and
// what the engine said at the time are kept — never the consumer's details.
export function to_return_outcome(lead: LpLead): OutcomePayload {
  const buyer = (lead.buyers ?? []).find((b) => b.returned) ?? null;
  const reason = buyer?.return_reason || lead.return_reason || null;
  const category = categorize_return_reason(reason);
  return {
    lp_lead_id: lead.id ?? null,
    certificate_url: lead.lead_data?.trustedform_cert_url ?? null,
    outcome: "returned",
    buyer: buyer?.name ?? null,
    sell_price: buyer?.sell_price != null ? String(buyer.sell_price) : lead.revenue != null ? String(lead.revenue) : null,
    return_reason: reason,
    supplier: lead.supplier?.name ?? null,
    raw: {
      source: "leadprosper_returns_sync",
      return_category: category,
      bears_on_verification: VERIFICATION_CATEGORIES.includes(category),
      lead_date_ms: lead.lead_date_ms ?? null,
      vs_analysis_id: lead.lead_data?.vs_analysis_id ?? null,
      vs_score: lead.lead_data?.vs_score ?? null,
      vs_model_version: lead.lead_data?.vs_model_version ?? null,
    },
  };
}

// Only what this module uses of a fetch response, declared here rather than
// relying on the global Response type, which the Vercel build does not provide.
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortController["signal"] },
) => Promise<FetchResponse>;

const default_fetch = fetch as unknown as Fetch;

async function lp_get(path: string, api_key: string, fetch_impl: Fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch_impl(LP_BASE + path, {
      headers: { Authorization: `Bearer ${api_key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Lead Prosper responded ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetch_returned_leads(
  params: { campaign: string; start_date: string; end_date: string },
  api_key: string,
  fetch_impl: Fetch = default_fetch,
): Promise<LpLead[]> {
  const returned: LpLead[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      campaign: params.campaign,
      start_date: params.start_date,
      end_date: params.end_date,
      limit: "100",
    });
    if (cursor) q.set("search_after", cursor);
    const data = await lp_get(`/leads?${q.toString()}`, api_key, fetch_impl);
    const leads = (Array.isArray(data["leads"]) ? data["leads"] : []) as LpLead[];
    for (const lead of leads) if (lead.returned === true) returned.push(lead);
    cursor = typeof data["search_after"] === "string" && data["search_after"] ? (data["search_after"] as string) : null;
    if (!cursor || leads.length === 0) break;
  }
  return returned;
}
