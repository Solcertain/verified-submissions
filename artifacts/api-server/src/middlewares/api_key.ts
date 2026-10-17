import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";

// Constant-time string comparison to avoid leaking the key via timing.
function safe_equal(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Require a matching `x-api-key` header against INTERNAL_API_KEY.
//
// Fail-open when INTERNAL_API_KEY is not configured: log a warning and allow the
// request through, so the endpoint is usable in dev/Replit before the secret is
// set. Once INTERNAL_API_KEY is set, the header is strictly enforced.
export function require_api_key(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env["INTERNAL_API_KEY"];

  if (!expected) {
    logger.warn(
      "INTERNAL_API_KEY is not set — protected endpoint is running UNAUTHENTICATED (fail-open). Set INTERNAL_API_KEY to enforce x-api-key.",
    );
    next();
    return;
  }

  const provided = req.header("x-api-key");
  if (provided && safe_equal(provided, expected)) {
    next();
    return;
  }

  res.status(401).json({
    vs_pass: false,
    error: "Unauthorized: missing or invalid x-api-key header",
  });
}

// Fail-CLOSED check for internal business endpoints (reports, labels): with no
// INTERNAL_API_KEY configured, nobody is let in.
export function internal_key_matches(req: Request): boolean {
  const expected = process.env["INTERNAL_API_KEY"];
  const provided = req.header("x-api-key") ?? "";
  if (!expected || !provided) return false;
  return safe_equal(provided, expected);
}
