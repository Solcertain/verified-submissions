
// Normalizes a TrustedForm v4 claim response into a typed feature object.
//
// `null` throughout means "TrustedForm did not report this", and is never
// interchangeable with `false`. A certificate that reports no consent and a
// certificate we could not read are different facts, and the scoring engine has
// to be able to tell them apart.
//
// Shape verified against live responses on 2026-10-08; see
// docs/TRUSTEDFORM_FEATURE_MAP.md. Everything hangs off `insights.properties`,
// `insights.scans` and `verify` — not the top level, and not a `cert` object.

export interface BehaviouralFeatures {
  // Authenticity
  bot_detected: boolean | null;
  input_methods: string[] | null;
  typed: boolean | null;
  autofilled: boolean | null;
  pasted: boolean | null;
  seconds_on_page: number | null;

  // Consent
  form_submitted: boolean | null;
  consent_verified: boolean | null;
  consent_language_approved: boolean | null;
  consent_one_to_one: boolean | null;
  consent_opt_in_satisfied: boolean | null;
  consent_terms_found: string[] | null;
  consent_terms_missing: string[] | null;

  // Provenance and environment
  domain: string | null;
  page_url: string | null;
  is_framed: boolean | null;
  is_mobile: boolean | null;
  browser_name: string | null;
  os_name: string | null;
  ip: string | null;
  geo_state: string | null;
  geo_postal_code: string | null;
  geo_country_code: string | null;

  // Certificate lifecycle
  certificate_created_at: string | null;
  age_seconds: number | null;

  // Captured but NOT for scoring. Observed values are not physically meaningful
  // as keystrokes/words per minute (9651 kpm over a 133s session), and the ratio
  // between them is not constant across certificates, so no threshold rule can
  // be trusted until ActiveProspect confirms the units.
  form_input_kpm: number | null;
  form_input_wpm: number | null;

  parse_notes: string[];
}

function as_record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function as_boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function as_number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function as_string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function as_string_array(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

// Membership is only knowable when TrustedForm reported the array at all.
// Absent array → null for every derived flag, not false.
function includes_method(methods: string[] | null, name: string): boolean | null {
  return methods === null ? null : methods.includes(name);
}

export function empty_features(note: string): BehaviouralFeatures {
  return {
    bot_detected: null,
    input_methods: null,
    typed: null,
    autofilled: null,
    pasted: null,
    seconds_on_page: null,
    form_submitted: null,
    consent_verified: null,
    consent_language_approved: null,
    consent_one_to_one: null,
    consent_opt_in_satisfied: null,
    consent_terms_found: null,
    consent_terms_missing: null,
    domain: null,
    page_url: null,
    is_framed: null,
    is_mobile: null,
    browser_name: null,
    os_name: null,
    ip: null,
    geo_state: null,
    geo_postal_code: null,
    geo_country_code: null,
    certificate_created_at: null,
    age_seconds: null,
    form_input_kpm: null,
    form_input_wpm: null,
    parse_notes: [note],
  };
}

export function extract_features(payload: unknown): BehaviouralFeatures {
  const root = as_record(payload);
  if (!root) return empty_features("Claim response was not an object");

  const parse_notes: string[] = [];

  const insights = as_record(root["insights"]);
  const properties = insights ? as_record(insights["properties"]) : null;
  const verify_result = (() => {
    const verify = as_record(root["verify"]);
    return verify ? as_record(verify["result"]) : null;
  })();

  if (!insights) parse_notes.push("No insights block — was the insights operation requested?");
  if (insights && !properties) parse_notes.push("insights present but carried no properties");
  if (!verify_result) parse_notes.push("No verify block — consent could not be evaluated");

  // Scans are only meaningful when required terms were sent on the request.
  const scan_result = (() => {
    const scans = insights ? as_record(insights["scans"]) : null;
    const result = scans ? as_record(scans["result"]) : null;
    return result ? as_record(result["required"]) : null;
  })();
  if (!scan_result) {
    parse_notes.push("No scan results — required_scan_terms were not sent or not evaluated");
  }

  const input_methods = properties ? as_string_array(properties["form_input_method"]) : null;

  const os = properties ? as_record(properties["os"]) : null;
  const browser = properties ? as_record(properties["browser"]) : null;
  const geo = properties ? as_record(properties["approx_ip_geo"]) : null;

  const features: BehaviouralFeatures = {
    bot_detected: properties ? as_boolean(properties["bot_detected"]) : null,
    input_methods,
    typed: includes_method(input_methods, "typing"),
    autofilled: includes_method(input_methods, "autofill"),
    pasted: includes_method(input_methods, "paste"),
    seconds_on_page: properties ? as_number(properties["seconds_on_page"]) : null,

    form_submitted: verify_result ? as_boolean(verify_result["form_submitted"]) : null,
    consent_verified: verify_result ? as_boolean(verify_result["success"]) : null,
    consent_language_approved: verify_result
      ? as_boolean(verify_result["language_approved"])
      : null,
    consent_one_to_one: verify_result ? as_boolean(verify_result["one_to_one"]) : null,
    consent_opt_in_satisfied: verify_result
      ? as_boolean(verify_result["opt_in_types_satisfied"])
      : null,
    consent_terms_found: scan_result ? as_string_array(scan_result["found"]) : null,
    consent_terms_missing: scan_result ? as_string_array(scan_result["not_found"]) : null,

    domain: properties ? as_string(properties["domain"]) : null,
    page_url: properties ? as_string(properties["page_url"]) : null,
    is_framed: properties ? as_boolean(properties["is_framed"]) : null,
    is_mobile: os ? as_boolean(os["is_mobile"]) : null,
    browser_name: browser ? as_string(browser["name"]) : null,
    os_name: os ? as_string(os["name"]) : null,
    ip: properties ? as_string(properties["ip"]) : null,
    geo_state: geo ? as_string(geo["state"]) : null,
    geo_postal_code: geo ? as_string(geo["postal_code"]) : null,
    geo_country_code: geo ? as_string(geo["country_code"]) : null,

    certificate_created_at: properties ? as_string(properties["created_at"]) : null,
    age_seconds: properties ? as_number(properties["age_seconds"]) : null,

    form_input_kpm: properties ? as_number(properties["form_input_kpm"]) : null,
    form_input_wpm: properties ? as_number(properties["form_input_wpm"]) : null,

    parse_notes,
  };

  if (features.bot_detected === null && properties) {
    parse_notes.push("bot_detected absent — property may not be contracted on this account");
  }


  return features;
}
