import {
  claim_certificate,
  is_valid_trustedform_url,
  normalize_certificate_url,
} from "./trustedform_client.js";
import { extract_features, type BehaviouralFeatures } from "./feature_extractor.js";
import {
  parse_trustedform_text,
  parse_trustedform_payload,
} from "./event_parser.js";
import { infer_field_roles, normalize_submission } from "./field_inference.js";
import { score_lead, type ScoreResult } from "./scoring_engine.js";
import {
  route_lead,
  build_webhook_payload,
  type RoutingConfig,
  type RoutingResult,
} from "./routing_engine.js";
import { append_review_row } from "./google_sheets.js";
import { dispatch_outbound_webhook } from "./webhook_dispatcher.js";
import {
  save_submission,
  get_submission_by_certificate,
} from "./submission_store.js";

// Flat snapshot of a normalized submission, used both in API responses and
// when persisting to the lead_submissions table.
export interface ParsedLeadPayload {
  certificate_id: string;
  certificate_created_at: string;
  submitted_at: string;
  consent_detected: boolean;
  lead_source: string;
  business_name: string;
  address_full: string;
  email: string;
  phone: string;
  first_name: string;
  last_name: string;
  employee_count: number | null;
  field_map: Record<string, string>;
  parse_notes: string[];
  status: "parsed" | "partial" | "error";
}

type SheetResult = Awaited<ReturnType<typeof append_review_row>> | null;
type WebhookResult = Awaited<ReturnType<typeof dispatch_outbound_webhook>> | null;

// Discriminated outcome so each caller (generic route, LeadProsper adapter)
// can render its own response shape from one shared pipeline.
export type ScoreAndRouteOutcome =
  | { kind: "invalid_url"; error: string }
  | {
      kind: "cached";
      certificate_url: string;
      stored_at: Date | null;
      analysis_id: string | null;
      parsed_lead: unknown;
      score: unknown;
    }
  | {
      kind: "claim_failed";
      certificate_url: string;
      status_code: number | null;
      error: string;
    }
  | {
      kind: "scored";
      certificate_url: string;
      claim_result: { ok: boolean; status_code: number | null };
      parsed_lead: ParsedLeadPayload;
      features: BehaviouralFeatures;
      score: ScoreResult;
      routing: RoutingResult;
      sheet_result: SheetResult;
      webhook_result: WebhookResult;
      analysis_id: string | null;
    };

export interface ScoreAndRouteInput {
  // The raw certificate URL (may be a full browser URL — it is normalized here).
  raw_url: string;
  // The original request body, persisted as-is for audit/evidence.
  raw_payload: Record<string, unknown>;
  // Skip the dedup cache lookup when true.
  force?: boolean;
  // Where the request came from (informational; reserved for future logging).
  source?: "generic" | "leadprosper";
}

// Build routing config from env vars so it's easy to configure without code changes.
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

function friendly_claim_error(status_code: number | null, error: string | null): string {
  if (status_code === 404) {
    return "Certificate not found. It may have expired, already been claimed, or the URL is invalid.";
  }
  if (status_code === 401) {
    return "TrustedForm API authentication failed. Check the ACTIVEPROSPECT_API_KEY secret.";
  }
  return `TrustedForm returned an error (HTTP ${status_code ?? "unknown"}): ${error ?? "no detail"}`;
}

// Core score-and-route pipeline, extracted so both POST /api/score-and-route and
// POST /api/leadprosper/pre-ping share the exact same logic (no internal HTTP call).
//
// Flow: validate → dedup cache → claim → parse → infer → normalize → score →
// route → optional sheets/webhook → persist.
export async function scoreAndRouteLead(
  input: ScoreAndRouteInput,
): Promise<ScoreAndRouteOutcome> {
  // Normalize: strip trailing paths like /assets/#certificate that browsers append.
  const certificate_url = normalize_certificate_url(input.raw_url);

  if (!is_valid_trustedform_url(certificate_url)) {
    return {
      kind: "invalid_url",
      error: "certificate_url must begin with https://cert.trustedform.com",
    };
  }

  // Dedup cache — return a previously stored result unless forced.
  if (!input.force) {
    const existing = await get_submission_by_certificate(certificate_url, undefined);
    if (existing) {
      return {
        kind: "cached",
        certificate_url,
        stored_at: existing.processed_at ?? null,
        analysis_id: existing.id ?? null,
        parsed_lead: existing.parsed_submission_json,
        score: existing.score_json,
      };
    }
  }

  // Claim the certificate from TrustedForm.
  const claim_result = await claim_certificate(certificate_url);

  if (!claim_result.ok) {
    return {
      kind: "claim_failed",
      certificate_url,
      status_code: claim_result.status_code,
      error: friendly_claim_error(claim_result.status_code, claim_result.error),
    };
  }

  // Behavioural features come straight off the v4 insights/verify response.
  // The legacy parse below still feeds the old scoring path; see
  // docs/TRUSTEDFORM_FEATURE_MAP.md for why that model cannot be fed by the API.
  const features = extract_features(claim_result.data);

  // Parse → infer → normalize → score.
  let parsed_lead;
  if (
    typeof claim_result.data["raw_text"] === "string" &&
    (claim_result.data["raw_text"] as string).length > 0
  ) {
    parsed_lead = parse_trustedform_text(claim_result.data["raw_text"] as string);
  } else {
    parsed_lead = parse_trustedform_payload(claim_result.data);
  }

  const inferred_fields = infer_field_roles(parsed_lead.field_map);
  const normalized = normalize_submission(parsed_lead, inferred_fields);
  const score = score_lead(normalized);

  // Route.
  const routing_config = get_routing_config();
  const routing = route_lead(normalized, score, routing_config);

  // Google Sheets — only for review leads.
  let sheet_result: SheetResult = null;
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
        certificate_url,
        lead_source: normalized.lead_source,
        employee_count: normalized.employee_count,
        consent_detected: normalized.consent_detected,
      },
      certificate_url,
    );
  }

  // Outbound webhook.
  const webhook_config = get_outbound_webhook_config();
  let webhook_result: WebhookResult = null;
  if (webhook_config.enabled) {
    const payload = build_webhook_payload(normalized, score, routing, certificate_url);
    webhook_result = await dispatch_outbound_webhook(payload, webhook_config);
  }

  const parsed_lead_payload: ParsedLeadPayload = {
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

  // Persist. save_submission is itself non-blocking (it swallows DB errors and
  // returns null), so a storage outage never fails the synchronous response.
  const saved = await save_submission({
    certificate_url,
    certificate_id: normalized.certificate_id || undefined,
    raw_payload_json: input.raw_payload,
    trustedform_raw_json: claim_result.data,
    parsed_submission_json: {
      legacy: parsed_lead_payload,
      features,
    } as unknown as Record<string, unknown>,
    score_json: score as unknown as Record<string, unknown>,
    status: score.status,
    processed_at: new Date(),
  });

  return {
    kind: "scored",
    certificate_url,
    claim_result: { ok: claim_result.ok, status_code: claim_result.status_code },
    parsed_lead: parsed_lead_payload,
    features,
    score,
    routing,
    sheet_result,
    webhook_result,
    analysis_id: saved?.id ?? null,
  };
}
