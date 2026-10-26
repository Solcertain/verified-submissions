import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { require_api_key } from "../middlewares/api_key.js";
import { load_report_rows } from "../services/report_store.js";
import { build_report } from "../services/verification_report.js";

const router = Router();

// Fails CLOSED. A customer key sees only that customer's leads. Solcertain's
// INTERNAL_API_KEY sees Solcertain's own leads, as before customer accounts,
// or another customer's with ?customer_id=<uuid>, or all with ?customer_id=all.

// GET /api/reports/verification?days=7            → JSON (aggregates + markdown)
// GET /api/reports/verification?days=7&format=md  → the markdown report only
router.get("/reports/verification", require_api_key, async (req: Request, res: Response) => {
  const customer = req.customer!;
  const requested = typeof req.query["customer_id"] === "string" ? req.query["customer_id"] : undefined;
  if (requested && requested !== "all" && !/^[0-9a-f-]{36}$/i.test(requested)) {
    res.status(400).json({ ok: false, error: "customer_id must be a uuid" });
    return;
  }
  const customer_id = !customer.internal
    ? customer.id
    : requested === "all"
      ? undefined
      : (requested ?? customer.id);
  const days = Math.min(90, Math.max(1, Number(req.query["days"] ?? 7) || 7));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  try {
    const { subs, outcomes } = await load_report_rows(start, end, customer_id);
    const report = build_report(subs, outcomes, { start, end });
    if (req.query["format"] === "md") {
      res.type("text/markdown").send(report.markdown);
      return;
    }
    res.json({ ok: true, report });
  } catch (err) {
    logger.error({ err }, "Verification report failed");
    res.status(500).json({ ok: false, error: "Report failed" });
  }
});

export default router;
