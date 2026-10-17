import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { internal_key_matches } from "../middlewares/api_key.js";
import { load_report_rows } from "../services/report_store.js";
import { build_report } from "../services/verification_report.js";

const router = Router();

// Fails CLOSED, unlike the scoring middleware: a report is internal business
// data, so with no INTERNAL_API_KEY configured nobody gets one.

// GET /api/reports/verification?days=7            → JSON (aggregates + markdown)
// GET /api/reports/verification?days=7&format=md  → the markdown report only
router.get("/reports/verification", async (req: Request, res: Response) => {
  if (!internal_key_matches(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  const days = Math.min(90, Math.max(1, Number(req.query["days"] ?? 7) || 7));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  try {
    const { subs, outcomes } = await load_report_rows(start, end);
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
