import { createHmac } from "node:crypto";
import { safe_equal } from "../lib/crypto.js";

// The handful of Stripe calls billing needs, over plain fetch: Checkout
// Sessions, meter events, invoice items, and webhook signature checks. Not the
// SDK, to keep the serverless bundle and the dependency list as they are.

const STRIPE_API = "https://api.stripe.com/v1";
// Pinned so a Dashboard default-version change cannot reshape responses.
const STRIPE_VERSION = "2025-03-31.basil";
const REQUEST_TIMEOUT_MS = 10_000;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

type Params = Record<string, unknown>;

// Stripe takes form encoding with bracketed keys: a[b]=1, items[0][price]=x.
export function encode_form(params: Params, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) out.push(...encode_form(item as Params, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(...encode_form(v as Params, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export async function stripe_request<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  params: Params = {},
  options: { idempotency_key?: string } = {},
): Promise<T> {
  const secret = process.env["STRIPE_SECRET_KEY"];
  if (!secret) throw new StripeError("STRIPE_SECRET_KEY is not set", null, "not_configured");

  const body = encode_form(params).join("&");
  const url = method === "GET" && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    "Stripe-Version": STRIPE_VERSION,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.idempotency_key) headers["Idempotency-Key"] = options.idempotency_key;

  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json["error"] ?? {}) as Record<string, unknown>;
    throw new StripeError(
      typeof err["message"] === "string" ? err["message"] : `Stripe HTTP ${res.status}`,
      res.status,
      typeof err["code"] === "string" ? err["code"] : null,
    );
  }
  return json as T;
}

// Checks a Stripe-Signature header (t=<unix>,v1=<hex>[,v1=...]) against the raw
// request body, as Stripe documents: HMAC-SHA256 of "<t>.<body>" with the
// endpoint secret, and a timestamp no older than the tolerance.
export function verify_stripe_signature(
  raw_body: string | Buffer,
  header: string | undefined,
  secret: string,
  tolerance_seconds = 300,
  now_seconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = v;
    if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now_seconds - Number(timestamp)) > tolerance_seconds) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${typeof raw_body === "string" ? raw_body : raw_body.toString("utf8")}`)
    .digest("hex");
  return signatures.some((s) => safe_equal(s, expected));
}

// Test helper and documentation in one: what Stripe would send for a body.
export function sign_stripe_payload(raw_body: string, secret: string, now_seconds = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${now_seconds}.${raw_body}`).digest("hex");
  return `t=${now_seconds},v1=${sig}`;
}
