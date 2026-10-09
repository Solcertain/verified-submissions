import type { ScoreAndRouteOutcome } from "./score_and_route_service.js";
import { score_authenticity, type AuthenticityResult } from "./authenticity_scorer.js";
import type { BehaviouralFeatures } from "./feature_extractor.js";
import { MODEL_VERSION as ENGINE_VERSION } from "../config/authenticity_rules.js";

// Version stamp returned to Lead Prosper so responses are traceable to a model rev.
export const MODEL_VERSION = ENGINE_VERSION;

// Matches the spec enum. Changed from five lowercase values deliberately early:
// vs_classification is already a live Lead Prosper custom field, and changing its
// values after shadow data accumulated would invalidate everything collected.
export type Classification =
  | "BOT_OR_SCRIPT"
  | "AUTOFILL_OR_HIGH_RISK_AUTOMATION"
  | "LEAD_FARM_HUMAN_TYPER"
  | "REAL_HUMAN"
  | "STRONG_REAL_HUMAN"
  | "INCONCLUSIVE";

export type RecommendedAction =
  | "accept"
  | "reject"
  | "review"
  | "downweight"
  | "return_eligible";

// The flat, Lead-Prosper-friendly response contract. All values are scalars
// (no nested JSON) so they map cleanly onto Lead Prosper custom fields.
export interface LeadProsperFlatResponse {
  vs_pass: boolean;
  vs_score: number;
  vs_score_1_10: number;
  vs_status: "approved" | "review" | "reject";
  vs_confidence: "high" | "medium" | "low";
  vs_classification: Classification;
  vs_recommended_action: RecommendedAction;
  vs_return_eligible: boolean;
  vs_certificate_id: string;
  vs_consent_detected: boolean;
  vs_session_seconds: number;
  vs_meaningful_event_count: number;
  vs_risk_flags: string;
  vs_reason: string;
  vs_analysis_id: string;
  vs_model_version: string;
}

export function mapScoreToOneToTen(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return Math.max(1, Math.ceil(clamped / 10));
}

// Status bands the authenticity score. It is NOT an overall verdict on the lead:
// consent is reported separately, because a real human on a non-compliant
// partner form is neither "approved" nor "a bot", and collapsing the two would
// force a choice between two true statements.
function status_for(result: AuthenticityResult): LeadProsperFlatResponse["vs_status"] {
  switch (result.classification) {
    case "BOT_OR_SCRIPT":
    case "AUTOFILL_OR_HIGH_RISK_AUTOMATION":
      return "reject";
    case "INCONCLUSIVE":
    case "LEAD_FARM_HUMAN_TYPER":
      return "review";
    case "REAL_HUMAN":
    case "STRONG_REAL_HUMAN":
      return "approved";
  }
}

function action_for(status: LeadProsperFlatResponse["vs_status"]): RecommendedAction {
  if (status === "approved") return "accept";
  if (status === "review") return "review";
  return "reject";
}

function build_flat(
  result: AuthenticityResult,
  certificate_id: string,
  session_seconds: number | null,
  analysis_id: string | null,
): LeadProsperFlatResponse {
  const vs_status = status_for(result);

  // Return eligibility stays strict: high-confidence automation only. A
  // deficient-consent lead is a conversation with the partner, not a return.
  const return_eligible =
    result.confidence === "HIGH" &&
    (result.classification === "BOT_OR_SCRIPT" ||
      result.classification === "AUTOFILL_OR_HIGH_RISK_AUTOMATION");

  // vs_consent_detected is a boolean field, so "not evaluated" has to report
  // false here. The distinction survives in vs_risk_flags and vs_reason.
  const consent_detected = result.consent.verdict === "VERIFIED";

  return {
    vs_pass: vs_status !== "reject",
    vs_score: result.score,
    vs_score_1_10: result.score_1_10,
    vs_status,
    vs_confidence: result.confidence.toLowerCase() as LeadProsperFlatResponse["vs_confidence"],
    vs_classification: result.classification,
    vs_recommended_action: action_for(vs_status),
    vs_return_eligible: return_eligible,
    vs_certificate_id: certificate_id || "",
    vs_consent_detected: consent_detected,
    vs_session_seconds: session_seconds ?? 0,
    // Repurposed: TrustedForm returns no event count, so this now reports how
    // many authenticity signals were actually available (0-3).
    vs_meaningful_event_count: result.signals_used,
    vs_risk_flags: result.risk_flags.join(","),
    vs_reason: result.evidence.join(" "),
    vs_analysis_id: analysis_id ?? "",
    vs_model_version: MODEL_VERSION,
  };
}

// When we couldn't analyze, return a safe inconclusive response: vs_pass=false
// so Lead Prosper doesn't auto-accept, but routed to review rather than a hard
// reject — our failure to read a certificate must not kill someone's lead.
function inconclusive_response(reason: string): LeadProsperFlatResponse {
  return {
    vs_pass: false,
    vs_score: 0,
    vs_score_1_10: 1,
    vs_status: "review",
    vs_confidence: "low",
    vs_classification: "INCONCLUSIVE",
    vs_recommended_action: "review",
    vs_return_eligible: false,
    vs_certificate_id: "",
    vs_consent_detected: false,
    vs_session_seconds: 0,
    vs_meaningful_event_count: 0,
    vs_risk_flags: "analysis_unavailable",
    vs_reason: reason,
    vs_analysis_id: "",
    vs_model_version: MODEL_VERSION,
  };
}

// Cached parsed_lead is an untyped JSON blob. Since 0.2-insights it is written as
// { legacy, features }; anything older has no features and must not be guessed at.
function read_stored_features(value: unknown): BehaviouralFeatures | null {
  const blob = (value ?? {}) as Record<string, unknown>;
  const features = blob["features"];
  if (typeof features !== "object" || features === null) return null;
  // A features object always carries parse_notes; its absence means this is some
  // other shape and must not be treated as a scoreable result.
  if (!Array.isArray((features as Record<string, unknown>)["parse_notes"])) return null;
  return features as unknown as BehaviouralFeatures;
}

function stored_certificate_id(value: unknown): string {
  const blob = (value ?? {}) as Record<string, unknown>;
  const legacy = (blob["legacy"] ?? blob) as Record<string, unknown>;
  return typeof legacy["certificate_id"] === "string" ? (legacy["certificate_id"] as string) : "";
}

export function mapToLeadProsperFlatFields(
  outcome: ScoreAndRouteOutcome,
): LeadProsperFlatResponse {
  switch (outcome.kind) {
    case "scored":
      return build_flat(
        score_authenticity(outcome.features),
        outcome.parsed_lead.certificate_id,
        outcome.features.seconds_on_page,
        outcome.analysis_id,
      );

    // Cached rows were written under an earlier model whose scores are not
    // comparable to this one, so replaying them would silently mix model
    // versions. Re-claim with force=true to rescore a cached certificate.
    // A cached row is rescored from its STORED features rather than replaying a
    // stored score, so dedupe still saves a metered claim while the result always
    // reflects the current model. Rows written before features were persisted
    // have none, and those stay honestly inconclusive rather than being guessed at.
    case "cached": {
      const stored = read_stored_features(outcome.parsed_lead);
      if (!stored) {
        return inconclusive_response(
          `Stored analysis predates model ${MODEL_VERSION} and carries no features; re-claim with force=true to rescore.`,
        );
      }
      return build_flat(
        score_authenticity(stored),
        stored_certificate_id(outcome.parsed_lead),
        stored.seconds_on_page,
        outcome.analysis_id,
      );
    }

    case "claim_failed":
      return inconclusive_response(outcome.error);

    case "invalid_url":
      return inconclusive_response(outcome.error);
  }
}
