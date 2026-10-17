import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";
import { sync_returns, type SyncResult } from "../services/returns_sync.js";

const router = Router();

function safe_equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; a person running the
// sync by hand uses the normal x-api-key. Unlike the scoring endpoints this
// fails CLOSED: with neither secret configured, nobody can trigger a sync.
function authorized(req: Request): boolean {
  const cron_secret = process.env["CRON_SECRET"];
  const api_key = process.env["INTERNAL_API_KEY"];
  const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const header_key = req.header("x-api-key") ?? "";
  return (
    (!!cron_secret && !!bearer && safe_equal(bearer, cron_secret)) ||
    (!!api_key && !!header_key && safe_equal(header_key, api_key))
  );
}

// GET /api/cron/sync-returns?days=21&campaign=23668
//
// Pulls returned leads from Lead Prosper and records each as a "returned"
// outcome with its reason and category. Safe to run repeatedly.
router.get("/cron/sync-returns", async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const lp_key = process.env["LP_API_KEY"];
  if (!lp_key) {
    logger.error("LP_API_KEY is not set — cannot sync returns");
    res.status(503).json({ ok: false, error: "LP_API_KEY is not configured" });
    return;
  }

  const days = Math.min(90, Math.max(1, Number(req.query["days"] ?? 21) || 21));
  const campaigns = String(req.query["campaign"] ?? process.env["LP_RETURNS_CAMPAIGNS"] ?? "23668")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => /^\d+$/.test(c));

  const results: SyncResult[] = [];
  try {
    for (const campaign of campaigns) {
      results.push(await sync_returns({ campaign, days, api_key: lp_key }));
    }
  } catch (err) {
    logger.error({ err }, "Returns sync failed");
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "Sync failed", results });
    return;
  }

  res.status(200).json({ ok: true, results });
});

export default router;
