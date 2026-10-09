import type { BehaviouralFeatures } from "./feature_extractor.js";
import * as R from "../config/authenticity_rules.js";

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
// badly built partner form", which need opposite responses.

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
}

export function score_authenticity(
  f: BehaviouralFeatures,
  options: ScoreOptions = {},
): AuthenticityResult {
  let score = R.NEUTRAL_BASELINE;
  const risk_flags: string[] = [];
  const evidence: string[] = [];
  let signals_used = 0;

  // --- Bot detection: the single strongest signal TrustedForm offers ---
  if (f.bot_detected === true) {
    score -= R.BOT_DETECTED;
    risk_flags.push("bot_detected");
    evidence.push("TrustedForm flagged this session as a bot.");
    signals_used++;
  } else if (f.bot_detected === false) {
    score += R.BOT_CHECK_PASSED;
    evidence.push("TrustedForm's bot check passed.");
    signals_used++;
  }
  // null → silence. We asked and got nothing; that is not evidence of a human.

  // --- Input method. Only meaningful when TrustedForm reported the array. ---
  if (f.input_methods !== null) {
    signals_used++;
    if (f.typed === true) {
      score += R.TYPING_OBSERVED;
      evidence.push(
        f.autofilled === true
          ? "Fields were typed, with some autofilled — normal mixed human behaviour."
          : "Fields were typed by hand.",
      );
    } else {
      score -= R.NO_TYPING_AT_ALL;
      risk_flags.push("no_typing_observed");
      evidence.push("No typing at all — the form was populated without keystrokes.");
    }
    if (f.pasted === true) {
      score -= R.PASTED_INPUT;
      risk_flags.push("pasted_input");
      evidence.push("At least one field was pasted.");
    }
  }

  // --- Session duration ---
  const secs = f.seconds_on_page;
  if (secs !== null) {
    signals_used++;
    if (secs < R.INSTANT_SESSION_SECONDS) {
      score -= R.INSTANT_SESSION;
      risk_flags.push("instant_submission");
      evidence.push(`Submitted after only ${secs}s — too fast to have been read.`);
    } else if (secs < R.BRIEF_SESSION_SECONDS) {
      score -= R.BRIEF_SESSION;
      risk_flags.push("brief_session");
      evidence.push(`Brief ${secs}s session.`);
    } else if (secs >= R.SUSTAINED_SESSION_SECONDS) {
      score += R.SUSTAINED_SESSION;
      evidence.push(`Sustained ${secs}s session.`);
    } else if (secs >= R.MODERATE_SESSION_SECONDS) {
      score += R.MODERATE_SESSION;
      evidence.push(`${secs}s session.`);
    }
  }

  // --- Consent: reported alongside, never folded into the authenticity score ---
  const consent = assess_consent(f, options.required_consent_terms);
  if (consent.verdict === "MISSING_LANGUAGE") {
    risk_flags.push("consent_language_missing");
    evidence.push(
      `Consent language is missing required phrasing: ${consent.missing_core_terms.join(", ")}.`,
    );
  } else if (consent.verdict === "VERIFIED") {
    evidence.push("Consent verified by TrustedForm.");
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
  };
}
