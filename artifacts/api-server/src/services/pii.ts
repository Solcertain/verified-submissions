// Outcomes need ids, statuses and prices, never the consumer. A trigger left on
// Lead Prosper's default body sends name, email, phone and address; those are
// dropped before anything is stored so a misconfigured trigger cannot fill the
// table with personal data.
const PII_KEY = /^(first_name|last_name|full_name|email|phone|phone_number|address|address2|street|city|state|zip|zip_code|postal_code|county|ip|ip_address|user_agent|dob|date_of_birth|credit_rating|net_worth_range)$/i;

export function scrub_pii(value: unknown): Record<string, unknown> {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(source)) {
    if (PII_KEY.test(key)) continue;
    out[key] = typeof v === "object" && v !== null && !Array.isArray(v) ? scrub_pii(v) : v;
  }
  return out;
}
