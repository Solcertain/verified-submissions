import { logger } from "../lib/logger.js";

const TRUSTED_FORM_DOMAIN = "https://cert.trustedform.com";
// The claim runs synchronously on the Lead Prosper intake path, so a slow or
// degraded ActiveProspect stalls lead delivery for every waiting lead. Keep this
// well under Lead Prosper's own enhancement timeout; a claim that misses the
// window degrades to an "inconclusive" result rather than blocking the lead.
const REQUEST_TIMEOUT_MS = 5_000;

// Insights data points requested on every claim. Valid values come from the v4
// InsightsParameters enum; only contracted properties may be queried, and the
// account is billed per property returned — so this lists exactly what a
// detector in src/detectors reads, and nothing else. When a detector starts
// using a new property, add it here in the same change.
//
// Dropped 2026-10-17 because nothing scored them: is_framed, browser, ip,
// domain, created_at, expires_at. A future network check (datacenter IPs) can
// use the ip_address Lead Prosper already sends, or re-add ip here.
const INSIGHTS_PROPERTIES = [
  "bot_detected", // bot_check
  "form_input_method", // input_method, superhuman_typing, synthetic_typing
  "form_input_kpm", // superhuman_typing, synthetic_typing
  "form_input_wpm", // synthetic_typing
  "seconds_on_page", // session_duration
  "age_seconds", // stale_certificate
  "os", // automation_environment (os name, is_mobile)
  "approx_ip_geo", // automation_environment
  "page_url", // certificate_page_mismatch
] as const;

// Verify checks consent against the requirements configured on the ActiveProspect
// account. advertiser_name is what populates the one_to_one result, and it is
// per-campaign: the advertiser named in a solar disclosure is not the advertiser
// named in a medical one.
//
// When the caller does not supply it we OMIT it rather than defaulting. A wrong
// advertiser name would produce a confident one_to_one verdict measured against
// the wrong company, which is worse than returning null.
//
// opt_in_types_allowed stays permissive for now. Tightening it is a compliance
// decision to make against real results rather than a guess.
function build_verify_params(advertiser_name?: string): Record<string, unknown> {
  const params: Record<string, unknown> = {
    opt_in_types_allowed: ["manual", "pre-selected", "non-interactive"],
  };
  if (advertiser_name) params["advertiser_name"] = advertiser_name;
  return params;
}

// Page-snapshot text scan, run alongside verify. verify only sees TrustedForm
// tagged consent (data-tf-element-role); a partner form carrying the disclosure
// as plain text is invisible to it. Scanning separates "no consent language" from
// "consent language present but untagged" — two findings with very different
// remediations. Broad deliberately: the per-term found/not_found breakdown shows
// what a partner's page actually says.
const DEFAULT_SCAN_TERMS = [
  "prior express written consent",
  "automatic telephone dialing system",
  "autodialed",
  "prerecorded",
  "text messages",
  "Do Not Call",
  "Privacy Policy",
  "Terms",
  "consent",
] as const;

// Union of the diagnostic defaults and whatever the campaign declares, so the
// per-term breakdown stays broad while the pass/fail judgement stays specific.
function build_scan_terms(extra?: string[]): string[] {
  const seen = new Set<string>(DEFAULT_SCAN_TERMS as readonly string[]);
  for (const t of extra ?? []) {
    const trimmed = t.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

interface TrustedFormFetchResponse {
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface ClaimResult {
  ok: boolean;
  status_code: number | null;
  data: Record<string, unknown>;
  error: string | null;
}

export function is_valid_trustedform_url(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.href.startsWith(TRUSTED_FORM_DOMAIN);
  } catch {
    return false;
  }
}

// Normalize a TrustedForm URL to the bare certificate endpoint.
// Handles common cases where users paste the full page URL from their browser:
//   https://cert.trustedform.com/<hash>/assets/#certificate  → https://cert.trustedform.com/<hash>
//   https://cert.trustedform.com/<hash>?foo=bar             → https://cert.trustedform.com/<hash>
// Only the 40-character hex certificate ID is retained in the path.
export function normalize_certificate_url(url: string): string {
  try {
    const parsed = new URL(url);
    // Extract just the first path segment (the certificate hash)
    const segments = parsed.pathname.split("/").filter(Boolean);
    const cert_hash = segments[0] ?? "";
    if (!cert_hash) return url; // Can't normalize — return as-is and let validation catch it
    return `${TRUSTED_FORM_DOMAIN}/${cert_hash}`;
  } catch {
    return url;
  }
}

export interface ClaimOptions {
  // The advertiser named in the consent disclosure for THIS campaign.
  advertiser_name?: string;
  // Phrases this campaign's disclosure is expected to contain. Compliant
  // disclosures word the same obligation differently — one says "automatic
  // telephone dialing system", another "automated technology" — so a single
  // global list produces false failures on every campaign it was not written
  // for. Scanned IN ADDITION to the diagnostic defaults.
  scan_terms?: string[];
}

// api_key is the ActiveProspect key of the customer the lead belongs to, passed
// on every call: each customer's claims are made, and billed, on their own
// ActiveProspect account. Solcertain's callers pass ACTIVEPROSPECT_API_KEY.
export async function claim_certificate(
  certificate_url: string,
  api_key: string | null | undefined,
  options: ClaimOptions = {},
): Promise<ClaimResult> {
  // Reject any URL that is not a TrustedForm cert URL to prevent credential leakage
  if (!is_valid_trustedform_url(certificate_url)) {
    return {
      ok: false,
      status_code: null,
      data: {},
      error: `Invalid certificate URL. Must begin with ${TRUSTED_FORM_DOMAIN}`,
    };
  }

  if (!api_key) {
    return {
      ok: false,
      status_code: null,
      data: {},
      error: "No ActiveProspect API key is configured for this account. Cannot authenticate with TrustedForm.",
    };
  }

  const credentials = Buffer.from(`API:${api_key}`).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = (await fetch(certificate_url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Api-Version": "4.0",
        Authorization: `Basic ${credentials}`,
      },
      // v4 selects products via operation keys in the body; without one the API
      // answers 400 "No valid products detected".
      body: JSON.stringify({
        insights: {
          properties: INSIGHTS_PROPERTIES,
          scans: { required: build_scan_terms(options.scan_terms) },
        },
        verify: build_verify_params(options.advertiser_name),
      }),
      signal: controller.signal,
    })) as TrustedFormFetchResponse;

    clearTimeout(timeout);

    let data: Record<string, unknown> = {};
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        data = {};
      }
    } else {
      // Return raw text under a key so callers can still parse it
      const text = await response.text();
      data = { raw_text: text };
    }

    if (!response.ok) {
      const errMsg =
        response.status === 401
          ? "Unauthorized — check the ActiveProspect API key"
          : response.status === 404
            ? "Certificate not found"
            : `HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`;

      logger.warn(
        { status: response.status, url: certificate_url },
        "TrustedForm claim failed",
      );

      return {
        ok: false,
        status_code: response.status,
        data,
        error: errMsg,
      };
    }

    return {
      ok: true,
      status_code: response.status,
      data,
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);

    const isTimeout =
      err instanceof Error && err.name === "AbortError";

    const errorMessage = isTimeout
      ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : "Unknown network error";

    logger.error({ err, url: certificate_url }, "TrustedForm request error");

    return {
      ok: false,
      status_code: null,
      data: {},
      error: errorMessage,
    };
  }
}
