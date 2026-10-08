import { Router, type Request, type Response } from "express";
import { require_api_key } from "../middlewares/api_key.js";
import {
  parse_trustedform_text,
} from "../services/event_parser.js";
import { infer_field_roles, normalize_submission } from "../services/field_inference.js";
import { score_lead } from "../services/scoring_engine.js";
import {
  route_lead,
  build_webhook_payload,
  type RoutingConfig,
} from "../services/routing_engine.js";
import { append_review_row } from "../services/google_sheets.js";
import { dispatch_outbound_webhook } from "../services/webhook_dispatcher.js";
import { save_submission } from "../services/submission_store.js";
import { scoreAndRouteLead } from "../services/score_and_route_service.js";

const router = Router();

// Build routing config from env vars so it's easy to configure without code changes
function get_routing_config(): RoutingConfig {
  return {
    crm_webhook_url: process.env["CRM_WEBHOOK_URL"] ?? undefined,
    notify_webhook_url: process.env["NOTIFY_WEBHOOK_URL"] ?? undefined,
    google_sheets_enabled: process.env["GOOGLE_SHEETS_ENABLED"] !== "false",
    outbound_webhook_enabled: process.env["OUTBOUND_WEBHOOK_ENABLED"] === "true",
  };
}

function get_outbound_webhook_config() {
  return {
    enabled: process.env["OUTBOUND_WEBHOOK_ENABLED"] === "true",
    url: process.env["OUTBOUND_WEBHOOK_URL"] ?? "",
    retry_attempts: 3,
    timeout_seconds: 5,
  };
}

// POST /api/score-and-route
// Full Pass 2 pipeline: claim → parse → infer → normalize → score → route → sheets → webhook
// The pipeline itself lives in scoreAndRouteLead() so it can be shared with the
// LeadProsper adapter without an internal HTTP call. This handler only maps the
// shared outcome onto the original JSON response shape.
router.post("/score-and-route", require_api_key, async (req: Request, res: Response) => {
  const raw_url = req.body?.certificate_url as string | undefined;
  const force = req.query["force"] === "true" || req.body?.force === true;

  // 1. Validate input
  if (!raw_url || typeof raw_url !== "string") {
    res.status(400).json({
      ok: false,
      error: "certificate_url is required and must be a string",
    });
    return;
  }

  const outcome = await scoreAndRouteLead({
    raw_url,
    raw_payload: req.body as Record<string, unknown>,
    force,
    source: "generic",
  });

  switch (outcome.kind) {
    case "invalid_url":
      res.status(400).json({ ok: false, error: outcome.error });
      return;

    case "cached":
      res.json({
        ok: true,
        cached: true,
        stored_at: outcome.stored_at,
        claim_result: { ok: true, status_code: 200, certificate_url: outcome.certificate_url },
        parsed_lead: outcome.parsed_lead,
        score: outcome.score,
        routing: null,
        sheet_result: null,
        webhook_result: null,
      });
      return;

    case "claim_failed":
      res.json({
        ok: false,
        error: outcome.error,
        claim_result: {
          ok: false,
          status_code: outcome.status_code,
          error: outcome.error,
          certificate_url: outcome.certificate_url,
        },
        parsed_lead: null,
        score: null,
        routing: null,
        sheet_result: null,
        webhook_result: null,
      });
      return;

    case "scored":
      res.json({
        ok: true,
        cached: false,
        claim_result: outcome.claim_result,
        parsed_lead: outcome.parsed_lead,
        score: outcome.score,
        routing: outcome.routing,
        sheet_result: outcome.sheet_result,
        webhook_result: outcome.webhook_result,
      });
      return;
  }
});

// POST /api/score-and-route/from-text
// Same full pipeline but scoring from a raw event log (no live cert claim)
router.post("/score-and-route/from-text", require_api_key, async (req: Request, res: Response) => {
  const { event_log_text, certificate_url } = req.body as {
    event_log_text?: string;
    certificate_url?: string;
  };

  if (!event_log_text || typeof event_log_text !== "string") {
    res.status(400).json({
      ok: false,
      error: "event_log_text is required",
    });
    return;
  }

  const parsed_lead = parse_trustedform_text(event_log_text);
  const inferred_fields = infer_field_roles(parsed_lead.field_map);
  const normalized = normalize_submission(parsed_lead, inferred_fields);
  const score = score_lead(normalized);

  const routing_config = get_routing_config();
  const routing = route_lead(normalized, score, routing_config);
  const cert_url = certificate_url ?? "";

  let sheet_result = null;
  if (score.status === "review" && routing_config.google_sheets_enabled !== false) {
    sheet_result = await append_review_row(
      {
        score: score.value,
        status: score.status,
        confidence: score.confidence,
        first_name: normalized.first_name,
        last_name: normalized.last_name,
        email: normalized.email,
        phone: normalized.phone,
        address: normalized.address_full,
        business_name: normalized.business_name,
        risk_flags: score.risk_flags,
        explanations: score.explanations,
        certificate_id: normalized.certificate_id,
        certificate_url: cert_url,
        lead_source: normalized.lead_source,
        employee_count: normalized.employee_count,
        consent_detected: normalized.consent_detected,
      },
      cert_url,
    );
  }

  const webhook_config = get_outbound_webhook_config();
  let webhook_result = null;
  if (webhook_config.enabled) {
    const payload = build_webhook_payload(normalized, score, routing, cert_url);
    webhook_result = await dispatch_outbound_webhook(payload, webhook_config);
  }

  const from_text_parsed_lead = {
    certificate_id: normalized.certificate_id,
    certificate_created_at: normalized.certificate_created_at,
    submitted_at: normalized.submitted_at,
    consent_detected: normalized.consent_detected,
    lead_source: normalized.lead_source,
    business_name: normalized.business_name,
    address_full: normalized.address_full,
    email: normalized.email,
    phone: normalized.phone,
    first_name: normalized.first_name,
    last_name: normalized.last_name,
    employee_count: normalized.employee_count,
    field_map: normalized.field_map,
    parse_notes: normalized.parse_notes,
    status: normalized.status,
  };

  // Persist the result — always insert a new row.
  // Do NOT pass certificate_url so we always get an INSERT (no upsert) since
  // text input is not a stable identifier and dedup is out of scope here.
  await save_submission({
    certificate_id: normalized.certificate_id || undefined,
    raw_payload_json: { event_log_text, certificate_url: cert_url || null },
    parsed_submission_json: from_text_parsed_lead as unknown as Record<string, unknown>,
    score_json: score as unknown as Record<string, unknown>,
    status: score.status,
    processed_at: new Date(),
  });

  res.json({
    ok: true,
    cached: false,
    claim_result: {
      ok: false,
      status_code: null,
      note: "Scored from raw event text — no live certificate claim",
      certificate_url: cert_url || null,
    },
    parsed_lead: from_text_parsed_lead,
    score,
    routing,
    sheet_result,
    webhook_result,
  });
});

export default router;
