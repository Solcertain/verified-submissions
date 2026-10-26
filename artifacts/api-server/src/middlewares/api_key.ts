import { type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";
import { safe_equal } from "../lib/crypto.js";
import {
  SOLCERTAIN,
  api_key_prefix,
  find_customer_by_api_key,
  find_customer_by_outcome_token,
  type CustomerContext,
} from "../services/customer_store.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by require_api_key: whose request this is.
      customer?: CustomerContext;
    }
  }
}

// How long a customer whose payment failed keeps verifying before requests are
// refused with 402. Stripe retries the card in that window.
function grace_days(): number {
  const n = Number(process.env["PAST_DUE_GRACE_DAYS"] ?? 7);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

// Whether this customer may make a billable call right now. null means yes;
// otherwise the HTTP status and message to refuse with.
export function access_refusal(
  customer: CustomerContext,
  now = new Date(),
): { status: number; error: string } | null {
  if (customer.internal) return null;
  switch (customer.status) {
    case "active":
      return null;
    case "past_due": {
      const since = customer.past_due_since?.getTime() ?? now.getTime();
      if (now.getTime() - since <= grace_days() * 86_400_000) return null;
      return { status: 402, error: "Payment required: update your card in the billing portal" };
    }
    case "pending_payment":
      return { status: 402, error: "Payment required: complete checkout to activate this account" };
    case "canceled":
      return { status: 403, error: "This account is canceled" };
  }
}

// Resolves the `x-api-key` header to a customer.
//
// INTERNAL_API_KEY is Solcertain (customer #1) and is checked first, with no
// database read, so the live Lead Prosper pre-ping keeps its current path.
// Anything shaped like a customer key (vsk_...) is looked up by prefix and
// compared by hash.
export async function resolve_customer(req: Request): Promise<CustomerContext | null> {
  const provided = req.header("x-api-key") ?? "";
  if (!provided) return null;

  const internal = process.env["INTERNAL_API_KEY"];
  if (internal && safe_equal(provided, internal)) return SOLCERTAIN;

  if (!api_key_prefix(provided)) return null;
  try {
    return await find_customer_by_api_key(provided);
  } catch (err) {
    logger.error({ err }, "API key lookup failed");
    return null;
  }
}

// Fails CLOSED: with no INTERNAL_API_KEY configured and no matching customer
// key, the request is refused. (Before customer accounts, an unset
// INTERNAL_API_KEY let every request through.)
export async function require_api_key(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!process.env["INTERNAL_API_KEY"]) {
    logger.warn("INTERNAL_API_KEY is not set — only customer API keys are accepted");
  }

  const customer = await resolve_customer(req);
  if (!customer) {
    res.status(401).json({
      vs_pass: false,
      error: "Unauthorized: missing or invalid x-api-key header",
    });
    return;
  }

  const refusal = access_refusal(customer);
  if (refusal) {
    res.status(refusal.status).json({ vs_pass: false, error: refusal.error });
    return;
  }

  req.customer = customer;
  next();
}

// Fail-CLOSED check for internal business endpoints (labels, admin): only
// INTERNAL_API_KEY gets in, never a customer key.
export function internal_key_matches(req: Request): boolean {
  const expected = process.env["INTERNAL_API_KEY"];
  const provided = req.header("x-api-key") ?? "";
  if (!expected || !provided) return false;
  return safe_equal(provided, expected);
}

// For legacy endpoints that claim certificates without storing or metering
// them, or that feed Solcertain's own review queue: Solcertain only. Runs after
// require_api_key. Customers use POST /api/v1/verify.
export function internal_only(req: Request, res: Response, next: NextFunction): void {
  if (req.customer?.internal) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: "Not available on customer keys. Use POST /api/v1/verify." });
}

// The customer an outcome callback's path token belongs to. LP_CALLBACK_TOKEN
// is Solcertain's, as before; anything else is looked up by hash. Fails closed.
export async function resolve_outcome_token(token: string): Promise<CustomerContext | null> {
  if (!token) return null;
  const solcertain = process.env["LP_CALLBACK_TOKEN"];
  if (solcertain && safe_equal(token, solcertain)) return SOLCERTAIN;
  try {
    return await find_customer_by_outcome_token(token);
  } catch (err) {
    logger.error({ err }, "Outcome token lookup failed");
    return null;
  }
}
