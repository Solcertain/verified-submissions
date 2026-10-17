import type { AuthenticityResult } from "./authenticity_scorer.js";
import type { ScoreResult, SessionMetrics } from "./scoring_engine.js";

// Turns a model result into a decision. Every endpoint — the Lead Prosper
// pre-ping, the generic score-and-route, routing, Google Sheets, outbound
// webhooks and the stored status — goes through here, so one lead cannot be
// "approved" in one place and "review" in another.

export type Status = "approved" | "review" | "reject";
export type Action = "accept" | "review" | "reject";

// The status reflects authenticity, with consent reported separately: a real
// human on a non-compliant partner form is neither "approved" nor "a bot".
// Some findings (a certificate that belongs to another lead, typing no
// keystrokes could produce) force review even when the rest of the evidence is
// strong; the detector that found it decides, via review_required.
export function status_for(result: AuthenticityResult): Status {
  switch (result.classification) {
    case "BOT_OR_SCRIPT":
    case "AUTOFILL_OR_HIGH_RISK_AUTOMATION":
      return "reject";
    case "INCONCLUSIVE":
    case "LEAD_FARM_HUMAN_TYPER":
      return "review";
    case "REAL_HUMAN":
    case "STRONG_REAL_HUMAN":
      return result.review_required ? "review" : "approved";
  }
}

export function action_for(status: Status): Action {
  if (status === "approved") return "accept";
  if (status === "review") return "review";
  return "reject";
}

// The routing, Sheets and webhook code was written against the legacy
// ScoreResult shape. This presents a current-model result in that shape so
// those paths decide on the current model without being rewritten. metrics
// still come from the legacy parse: they describe the event log, not the score.
export function to_score_result(result: AuthenticityResult, metrics: SessionMetrics): ScoreResult {
  return {
    value: result.score,
    status: status_for(result),
    confidence: result.confidence.toLowerCase() as ScoreResult["confidence"],
    risk_flags: result.risk_flags,
    explanations: result.evidence,
    metrics,
  };
}
