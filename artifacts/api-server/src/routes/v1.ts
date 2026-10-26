import { Router, type Request, type Response } from "express";
import { require_api_key, resolve_outcome_token } from "../middlewares/api_key.js";
import { scoreAndRouteLead } from "../services/score_and_route_service.js";
import { verdict_for_outcome } from "../services/leadprosper_flat_fields.js";
import { action_for, status_for } from "../services/verdict.js";
import { MODEL_VERSION } from "../config/authenticity_rules.js";
import { get_activeprospect_key } from "../services/customer_store.js";
import { save_outcome } from "../services/outcome_store.js";
import { scrub_pii } from "../services/pii.js";

// The customer API: one REST surface any lead platform can call, on
// verify.verifiedsubmission.com. Thin wrappers over the same pipeline and the
// same verdict as the Lead Prosper pre-ping, scoped to the calling customer.

const router = Router();

function str(v: unknown): string | undefined {
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

// Lead fields may come flat or under "lead"; the pipeline reads flat keys.
function lead_payload(body: Record<string, unknown>): Record<string, unknown> {
  const lead = typeof body["lead"] === "object" && body["lead"] !== null ? (body["lead"] as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...lead };
  for (const key of ["advertiser_name", "landing_page_url", "lead_source", "lead_id"]) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  // The pipeline takes consent terms comma-separated; accept an array too.
  const terms = body["consent_terms"];
  if (Array.isArray(terms)) out["consent_terms"] = terms.filter((t) => typeof t === "string").join(",");
  else if (typeof terms === "string") out["consent_terms"] = terms;
  return out;
}

// POST /api/v1/verify   (x-api-key)
// { "certificate_url": "https://cert.trustedform.com/…",
//   "lead"?: { email, phone, state, first_name, last_name },
//   "advertiser_name"?, "consent_terms"?: string[] | "a,b", "landing_page_url"?, "lead_id"? }
router.post("/v1/verify", require_api_key, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw_url = str(body["certificate_url"]);
  if (!raw_url) {
    res.status(400).json({ ok: false, error: "certificate_url is required" });
    return;
  }

  const customer = req.customer!;
  const outcome = await scoreAndRouteLead({
    customer,
    activeprospect_key: await get_activeprospect_key(customer),
    raw_url,
    raw_payload: lead_payload(body),
    source: "v1",
  });

  if (outcome.kind === "invalid_url") {
    res.status(400).json({ ok: false, error: outcome.error });
    return;
  }

  const verdict = verdict_for_outcome(outcome);
  if (verdict.kind === "unavailable") {
    // Our failure to read a certificate must not kill someone's lead: answer
    // 200 with a review status, and say why.
    res.status(200).json({
      ok: false,
      status: "review",
      action: "review",
      classification: "INCONCLUSIVE",
      score: null,
      flags: ["analysis_unavailable"],
      reasons: [verdict.reason],
      cached: outcome.kind === "cached",
      billable: false,
      model_version: MODEL_VERSION,
    });
    return;
  }

  const r = verdict.result;
  const status = status_for(r);
  res.status(200).json({
    ok: true,
    analysis_id: verdict.analysis_id,
    certificate_id: verdict.certificate_id,
    status,
    action: action_for(status),
    score: r.score,
    score_1_10: r.score_1_10,
    confidence: r.confidence.toLowerCase(),
    classification: r.classification,
    flags: r.risk_flags,
    reasons: r.evidence,
    consent: { verdict: r.consent.verdict, missing_terms: r.consent.missing_core_terms },
    session_seconds: verdict.session_seconds,
    cached: outcome.kind === "cached",
    billable: outcome.kind === "scored" && outcome.billable,
    model_version: r.model_version,
  });
});

const OUTCOMES = ["accepted", "sold", "returned", "rejected"] as const;

// POST /api/v1/outcomes/:token
// { "lead_id"?, "certificate_url"?, "outcome": "accepted|sold|returned|rejected",
//   "reason"?, "buyer"?, "price"?, "supplier"? }
//
// The token is the customer's outcome URL secret, so a platform that can only
// fire a URL (no headers) can still report what happened to a lead.
router.post("/v1/outcomes/:token", async (req: Request, res: Response) => {
  const customer = await resolve_outcome_token(String(req.params["token"] ?? ""));
  if (!customer) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const outcome = str(body["outcome"])?.toLowerCase();
  if (!outcome || !(OUTCOMES as readonly string[]).includes(outcome)) {
    res.status(400).json({ ok: false, error: `outcome must be one of: ${OUTCOMES.join(", ")}` });
    return;
  }
  const lead_id = str(body["lead_id"]);
  const certificate_url = str(body["certificate_url"]);
  if (!lead_id && !certificate_url) {
    res.status(400).json({ ok: false, error: "Give lead_id or certificate_url" });
    return;
  }

  const stored = await save_outcome(
    {
      lp_lead_id: lead_id ?? null,
      certificate_url: certificate_url ?? null,
      outcome,
      buyer: str(body["buyer"]) ?? null,
      sell_price: str(body["price"]) ?? null,
      return_reason: str(body["reason"]) ?? null,
      supplier: str(body["supplier"]) ?? null,
      raw: { ...scrub_pii(body), source: "v1" },
    },
    customer.id,
  );

  res.status(200).json({
    ok: stored !== null,
    outcome_id: stored?.id ?? null,
    linked_analysis_id: stored?.analysis_id ?? null,
  });
});

export default router;
