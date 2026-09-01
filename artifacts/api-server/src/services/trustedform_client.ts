import { logger } from "../lib/logger.js";

const TRUSTED_FORM_DOMAIN = "https://cert.trustedform.com";
// The claim runs synchronously on the Lead Prosper intake path, so a slow or
// degraded ActiveProspect stalls lead delivery for every waiting lead. Keep this
// well under Lead Prosper's own enhancement timeout; a claim that misses the
// window degrades to an "inconclusive" result rather than blocking the lead.
const REQUEST_TIMEOUT_MS = 5_000;

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

export function get_api_key(): string {
  const key = process.env["ACTIVEPROSPECT_API_KEY"];
  if (!key) {
    throw new Error(
      "ACTIVEPROSPECT_API_KEY environment variable is not set. Cannot authenticate with TrustedForm.",
    );
  }
  return key;
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

export async function claim_certificate(
  certificate_url: string,
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

  let api_key: string;
  try {
    api_key = get_api_key();
  } catch (err) {
    return {
      ok: false,
      status_code: null,
      data: {},
      error: err instanceof Error ? err.message : "Missing API key",
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
        Authorization: `Basic ${credentials}`,
      },
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
          ? "Unauthorized — check ACTIVEPROSPECT_API_KEY"
          : response.status === 404
            ? "Certificate not found"
            : `HTTP ${response.status}`;

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
