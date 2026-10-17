import type { BehaviouralFeatures } from "./feature_extractor.js";
import type { LeadFields } from "./lead_fields.js";
import * as R from "../config/authenticity_rules.js";
import { DETECTORS } from "../detectors/registry.js";
import type { Detector, ShadowFinding } from "../detectors/types.js";

// Deterministic behavioural authenticity model over TrustedForm v4 Insights.
//
// Pure: no network, no database, no clock, no randomness. The same features at
// the same MODEL_VERSION always produce the same result, which is what makes
// calibration and regression testing possible.
//
// Three things this model deliberately keeps apart, because a single live
// certificate showed all three diverging (see docs/TRUSTEDFORM_FEATURE_MAP.md §7
// — a real human, typing for 133 seconds, whose consent language was deficient
// and whose submitted state contradicted its own postcode):
//
//   authenticity — was a human actually there
//   consent      — is the consent legally meaningful
//   sellability  — is the data usable (NOT scored here; that is Lead Prosper's job)
//
// Collapsing them loses the distinction between "a bot" and "a real person on a
// badly built partner form", which need opposite responses. Since 0.3 consent
// also weighs on the score: missing language keeps a sustained-session human
// out of STRONG_REAL_HUMAN, and only a human whose behavioural evidence was
// already thin (session under 30s) can be pushed into review by it. The
// consent verdict is still reported separately.

export type Classification =
  | "BOT_OR_SCRIPT"
  | "AUTOFILL_OR_HIGH_RISK_AUTOMATION"
  | "LEAD_FARM_HUMAN_TYPER"
  | "REAL_HUMAN"
  | "STRONG_REAL_HUMAN"
  | "INCONCLUSIVE";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type ConsentVerdict = "VERIFIED" | "MISSING_LANGUAGE" | "NOT_EVALUATED";

export interface AuthenticityResult {
  model_version: string;
  score: number; // 0-100 canonical
  score_1_10: number; // derived from score, never computed separately
  classification: Classification;
  confidence: Confidence;
  consent: {
    verdict: ConsentVerdict;
    missing_core_terms: string[];
  };
  risk_flags: string[];
  evidence: string[];
  signals_used: number;
  // A detector found something that sends the lead to review whatever the score.
  review_required: boolean;
  // What checks still in shadow mode would have reported. Never affects the
  // score; used to measure a new check against live traffic before promoting it.
  shadow_findings: ShadowFinding[];
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// The 1-10 value is a presentation of the canonical score, not a second model.
function derive_1_10(score: number): number {
  return Math.max(1, Math.min(10, Math.ceil(score / 10)));
}

// required_terms are the phrases THIS campaign's disclosure is expected to
// contain. Compliant disclosures word the same obligation differently, so
// judging every campaign against one global list produces false failures.
// Falls back to the defaults when a campaign declares nothing.
function assess_consent(
  f: BehaviouralFeatures,
  required_terms?: string[],
): AuthenticityResult["consent"] {
  const required =
    required_terms && required_terms.length > 0
      ? required_terms
      : (R.CORE_TCPA_TERMS as readonly string[]);
  const missing = (f.consent_terms_missing ?? []).filter((t) => required.includes(t));

  // Order matters. A positive verify result is the strongest statement
  // available. Missing core phrasing is the next strongest. Everything else is
  // "we did not establish this", which is not the same as a failure.
  if (f.consent_verified === true) {
    return { verdict: "VERIFIED", missing_core_terms: [] };
  }
  if (missing.length > 0) {
    return { verdict: "MISSING_LANGUAGE", missing_core_terms: missing };
  }
  return { verdict: "NOT_EVALUATED", missing_core_terms: [] };
}

export interface ScoreOptions {
  // Phrases this campaign's disclosure must contain for consent to be adequate.
  required_consent_terms?: string[];
  // This certificate was already claimed for a different lead.
  certificate_reused?: boolean;
  // The lead's landing page as reported by Lead Prosper, compared against the
  // page TrustedForm actually recorded.
  landing_page_url?: string;
  // The lead's own details, for plausibility checks.
  lead?: LeadFields;
}

export function score_authenticity(
  f: BehaviouralFeatures,
  options: ScoreOptions = {},
  detectors: readonly Detector[] = DETECTORS,
): AuthenticityResult {
  let score = R.NEUTRAL_BASELINE;
  const risk_flags: string[] = [];
  const evidence: string[] = [];
  const shadow_findings: ShadowFinding[] = [];
  let signals_used = 0;
  let review_required = false;

  const consent = assess_consent(f, options.required_consent_terms);
  const input = { features: f, options, consent };

  for (const detector of detectors) {
    const result = detector.evaluate(input);
    if (detector.status === "shadow") {
      for (const finding of result.findings) {
        shadow_findings.push({ detector: detector.id, ...finding });
      }
      continue;
    }
    signals_used += result.signals ?? 0;
    for (const finding of result.findings) {
      score += finding.points;
      if (finding.flag) risk_flags.push(finding.flag);
      if (finding.evidence) evidence.push(finding.evidence);
      if (finding.forces_review) review_required = true;
    }
  }

  score = clamp(score);

  // --- Classification ---
  // Thin evidence is INCONCLUSIVE regardless of where the arithmetic landed.
  let classification: Classification;
  if (signals_used === 0) {
    classification = "INCONCLUSIVE";
    evidence.push("No usable signals were returned for this certificate.");
  } else if (f.bot_detected === true) {
    classification = "BOT_OR_SCRIPT";
  } else if (f.input_methods !== null && f.typed === false) {
    classification = "AUTOFILL_OR_HIGH_RISK_AUTOMATION";
  } else if (signals_used < R.MIN_SIGNALS_FOR_MEDIUM_CONFIDENCE) {
    classification = "INCONCLUSIVE";
  } else if (score >= R.STRONG_HUMAN_MIN) {
    classification = "STRONG_REAL_HUMAN";
  } else if (score >= R.REAL_HUMAN_MIN) {
    classification = "REAL_HUMAN";
  } else if (score <= R.AUTOMATION_MAX) {
    classification = "AUTOFILL_OR_HIGH_RISK_AUTOMATION";
  } else {
    classification = "LEAD_FARM_HUMAN_TYPER";
  }

  // --- Confidence: breadth of evidence, not magnitude of score ---
  let confidence: Confidence;
  if (classification === "INCONCLUSIVE") {
    confidence = "LOW";
  } else if (signals_used >= R.MIN_SIGNALS_FOR_HIGH_CONFIDENCE) {
    confidence = "HIGH";
  } else if (signals_used >= R.MIN_SIGNALS_FOR_MEDIUM_CONFIDENCE) {
    confidence = "MEDIUM";
  } else {
    confidence = "LOW";
  }

  // A disagreement between signals costs confidence even when there are many of
  // them: typing observed alongside a bot flag is exactly the case where a
  // single number hides the uncertainty.
  if (f.bot_detected === true && f.typed === true && confidence === "HIGH") {
    confidence = "MEDIUM";
    evidence.push("Signals disagree: typing was observed but the bot check failed.");
  }

  return {
    model_version: R.MODEL_VERSION,
    score,
    score_1_10: derive_1_10(score),
    classification,
    confidence,
    consent,
    risk_flags,
    evidence,
    signals_used,
    review_required,
    shadow_findings,
  };
}
