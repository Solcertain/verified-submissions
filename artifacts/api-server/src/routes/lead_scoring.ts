import { Router, type Request, type Response } from "express";
import { require_api_key } from "../middlewares/api_key.js";
import { claim_certificate, is_valid_trustedform_url } from "../services/trustedform_client.js";
import {
  parse_trustedform_text,
  parse_trustedform_payload,
} from "../services/event_parser.js";
import { infer_field_roles, normalize_submission } from "../services/field_inference.js";
import { score_lead } from "../services/scoring_engine.js";

const router = Router();

// POST /api/score-lead
// Accepts a TrustedForm certificate URL, claims the cert, parses it,
// infers field roles, normalizes the submission, scores the lead,
// and returns a full structured response.
router.post("/score-lead", require_api_key, async (req: Request, res: Response) => {
  const { certificate_url } = req.body as { certificate_url?: string };

  // 1. Validate input
  if (!certificate_url || typeof certificate_url !== "string") {
    res.status(400).json({
      ok: false,
      error: "certificate_url is required and must be a string",
    });
    return;
  }

  if (!is_valid_trustedform_url(certificate_url)) {
    res.status(400).json({
      ok: false,
      error:
        "certificate_url must begin with https://cert.trustedform.com to prevent credential leakage",
    });
    return;
  }

  // 2. Claim certificate from TrustedForm
  const claim_result = await claim_certificate(certificate_url);

  // Even if the claim failed we still attempt to parse what we have
  let parsed_lead;

  if (!claim_result.ok) {
    req.log.warn(
      { certificate_url, error: claim_result.error },
      "Certificate claim failed — attempting offline parse",
    );
    // Return the error but still provide partial structure
    res.status(502).json({
      ok: false,
      claim_result: {
        ok: false,
        status_code: claim_result.status_code,
        error: claim_result.error,
      },
      parsed_lead: null,
      score: null,
    });
    return;
  }

  // 3. Parse the payload returned from TrustedForm
  // If the response contains a raw_text field, use the text parser;
  // otherwise use the JSON payload parser.
  if (
    typeof claim_result.data["raw_text"] === "string" &&
    (claim_result.data["raw_text"] as string).length > 0
  ) {
    parsed_lead = parse_trustedform_text(claim_result.data["raw_text"] as string);
  } else {
    parsed_lead = parse_trustedform_payload(claim_result.data);
  }

  // 4 & 5. Infer field roles and normalize the submission
  const inferred_fields = infer_field_roles(parsed_lead.field_map);
  const normalized = normalize_submission(parsed_lead, inferred_fields);

  // 6. Score the lead
  const score = score_lead(normalized);

  // 7. Return the full structured response
  res.json({
    ok: true,
    claim_result: {
      ok: claim_result.ok,
      status_code: claim_result.status_code,
    },
    parsed_lead: {
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
    },
    score,
  });
});

// POST /api/score-lead/from-text
// Accepts a raw TrustedForm event log as plain text (for testing/dev use
// without a live certificate claim). Parses, infers, normalizes, and scores.
router.post("/score-lead/from-text", require_api_key, (req: Request, res: Response) => {
  const { event_log_text, certificate_url } = req.body as {
    event_log_text?: string;
    certificate_url?: string;
  };

  if (!event_log_text || typeof event_log_text !== "string") {
    res.status(400).json({
      ok: false,
      error: "event_log_text is required and must be a string",
    });
    return;
  }

  const parsed_lead = parse_trustedform_text(event_log_text);
  const inferred_fields = infer_field_roles(parsed_lead.field_map);
  const normalized = normalize_submission(parsed_lead, inferred_fields);
  const score = score_lead(normalized);

  res.json({
    ok: true,
    claim_result: {
      ok: false,
      status_code: null,
      note: "Scored from raw event text — no live certificate claim performed",
      certificate_url: certificate_url ?? null,
    },
    parsed_lead: {
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
    },
    score,
  });
});

export default router;
