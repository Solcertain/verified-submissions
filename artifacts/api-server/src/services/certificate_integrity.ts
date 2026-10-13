// Checks that a certificate actually belongs to the lead it arrived with. Both
// are pure so they can be tested without a database or a TrustedForm claim.

function norm_email(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

// Last ten digits, so "+14125550100" and "(412) 555-0100" compare equal.
function norm_phone(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "").slice(-10) : "";
}

function norm_id(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

// A certificate proves consent for one submission. When a second request arrives
// for a certificate we have already claimed, it is a legitimate retry only if it
// is the same lead. Any identifier that is present on both and differs means the
// certificate is being presented for a different lead. If the original carried
// no identifiers at all, nothing ties it to this lead, so that counts as reuse
// too — the Oct 2026 case was a certificate first claimed by a bare test request
// and later attached to two unrelated Lead Prosper leads.
export function is_certificate_reused(
  previous: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined,
): boolean {
  const prev = previous ?? {};
  const cur = current ?? {};

  const pairs: [string, string][] = [
    [norm_id(prev["lp_lead_id"]), norm_id(cur["lp_lead_id"])],
    [norm_email(prev["email"]), norm_email(cur["email"])],
    [norm_phone(prev["phone"]), norm_phone(cur["phone"])],
  ];

  if (pairs.some(([p, c]) => p !== "" && c !== "" && p !== c)) return true;

  const prev_has_identity = pairs.some(([p]) => p !== "");
  const cur_has_identity = pairs.some(([, c]) => c !== "");
  return !prev_has_identity && cur_has_identity;
}

// Landing-page field names a Lead Prosper data-append body may use.
const LANDING_PAGE_KEYS = ["landing_page_url", "lp_landing_page_url", "source_url"] as const;

export function read_landing_page_url(payload: Record<string, unknown> | null | undefined): string | undefined {
  for (const key of LANDING_PAGE_KEYS) {
    const v = payload?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function host_of(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// True only when both hosts are known and differ. Either side missing is
// "could not check", never a mismatch.
export function is_page_mismatch(
  certificate_page_url: string | null | undefined,
  landing_page_url: string | null | undefined,
): boolean {
  if (!certificate_page_url || !landing_page_url) return false;
  const a = host_of(certificate_page_url);
  const b = host_of(landing_page_url);
  return a !== null && b !== null && a !== b;
}
