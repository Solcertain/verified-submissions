import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";
import { normalize_outcome_payload, save_outcome } from "../services/outcome_store.js";

const router = Router();

// Authenticated by a secret path segment rather than a header, because Lead
// Prosper's HTTP trigger actions expose only a URL and a method — the same
// pattern its GoHighLevel and ClickFlare triggers already use.
//
// The tradeoff is real: a URL secret can appear in proxy and access logs in a
// way a header would not. It is therefore a SEPARATE secret from
// INTERNAL_API_KEY, so rotating it cannot lock out the scoring endpoints, and it
// grants nothing but the ability to append an outcome row.
function token_matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST /api/leadprosper/outcome/:token
//
// Records what Lead Prosper did with a lead. This is the supervision signal the
// authenticity model needs: a returned or unsold lead is a labelled bad lead,
// and an accepted-and-sold one is a labelled good lead.
router.post("/leadprosper/outcome/:token", async (req: Request, res: Response) => {
  const expected = process.env["LP_CALLBACK_TOKEN"];

  // Fail CLOSED, unlike the scoring middleware. This endpoint only ever writes,
  // so refusing is free; accepting unauthenticated writes would let anyone
  // poison the labels the model will be calibrated against.
  if (!expected) {
    logger.error("LP_CALLBACK_TOKEN is not set — rejecting outcome callback");
    res.status(503).json({ ok: false, error: "Outcome callback is not configured" });
    return;
  }

  const supplied = String(req.params["token"] ?? "");
  if (!token_matches(supplied, expected)) {
    logger.warn("Outcome callback rejected: bad token");
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const payload = normalize_outcome_payload(req.body);

  // A payload we cannot tie to anything is not worth storing, but it IS worth
  // knowing about — a silent mismatch here would look like "no outcomes" rather
  // than "the trigger template is wrong".
  if (!payload.lp_lead_id && !payload.certificate_url) {
    logger.warn(
      { keys: Object.keys((req.body ?? {}) as object) },
      "Outcome callback carried neither a lead id nor a certificate URL",
    );
    res.status(400).json({
      ok: false,
      error:
        "Payload must include a Lead Prosper lead id or a TrustedForm certificate URL. " +
        "Check the trigger's field mapping.",
    });
    return;
  }

  const stored = await save_outcome(payload);

  // Always 200 once authenticated and parseable. Lead Prosper retries on
  // failure, and a storage problem on our side must not cause it to replay
  // outcomes indefinitely.
  res.status(200).json({
    ok: stored !== null,
    outcome_id: stored?.id ?? null,
    linked_analysis_id: stored?.analysis_id ?? null,
  });
});

export default router;
