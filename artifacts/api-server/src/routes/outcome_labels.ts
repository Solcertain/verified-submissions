import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { internal_key_matches } from "../middlewares/api_key.js";
import { OPERATOR_LABELS, save_operator_label, type OperatorLabel } from "../services/outcome_store.js";

const router = Router();

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

// POST /api/outcomes/label   (x-api-key, fails closed)
// { "analysis_id" | "certificate_url" | "lp_lead_id": "...",
//   "label": "fraud" | "genuine", "reason"?: "...", "labelled_by"?: "..." }
//
// Records a person's confirmed verdict on a lead, alongside the decision the
// engine made when the lead arrived. Writes are append-only labels, which the
// calibration and the customer-facing report are built on, so an unset key
// refuses rather than lets anyone in.
router.post("/outcomes/label", async (req: Request, res: Response) => {
  if (!internal_key_matches(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label = str(body["label"]);
  if (!label || !(label in OPERATOR_LABELS)) {
    res.status(400).json({ ok: false, error: `label must be one of: ${Object.keys(OPERATOR_LABELS).join(", ")}` });
    return;
  }
  const input = {
    analysis_id: str(body["analysis_id"]),
    certificate_url: str(body["certificate_url"]),
    lp_lead_id: str(body["lp_lead_id"]),
    label: label as OperatorLabel,
    reason: str(body["reason"]),
    labelled_by: str(body["labelled_by"]),
  };
  if (!input.analysis_id && !input.certificate_url && !input.lp_lead_id) {
    res.status(400).json({ ok: false, error: "Give analysis_id, certificate_url or lp_lead_id" });
    return;
  }
  try {
    const stored = await save_operator_label(input);
    if (!stored) {
      res.status(404).json({ ok: false, error: "No scored lead matches that id" });
      return;
    }
    const held_back = stored.engine.status === "review" || stored.engine.status === "reject";
    res.status(stored.already_recorded ? 200 : 201).json({
      ok: true,
      ...stored,
      // The one-line answer to "did the engine catch it?"
      engine_result:
        input.label === "fraud"
          ? held_back ? "caught" : "missed"
          : held_back ? "false_alarm" : "correctly_approved",
    });
  } catch (err) {
    logger.error({ err }, "Operator label failed");
    res.status(500).json({ ok: false, error: "Label failed" });
  }
});

export default router;
