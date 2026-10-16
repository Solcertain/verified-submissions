import * as R from "../config/authenticity_rules.js";
import { NONE, type Detector } from "./types.js";

// Consent is still reported as its own verdict, but it also moves the score, so
// a deficient disclosure is visible in vs_score and drops the lead out of
// STRONG_REAL_HUMAN. Not-evaluated is neutral: "we did not check" is not a failure.
export const consent_language: Detector = {
  id: "consent_language",
  family: "consent",
  status: "active",
  description: "Whether the consent disclosure is approved and contains the required TCPA phrasing.",
  evaluate({ consent }) {
    if (consent.verdict === "MISSING_LANGUAGE") {
      return {
        findings: [
          {
            points: -R.CONSENT_LANGUAGE_MISSING,
            flag: "consent_language_missing",
            evidence: `Consent language is missing required phrasing: ${consent.missing_core_terms.join(", ")}.`,
          },
        ],
      };
    }
    if (consent.verdict === "VERIFIED") {
      return { findings: [{ points: R.CONSENT_VERIFIED, evidence: "Consent verified by TrustedForm." }] };
    }
    return NONE;
  },
};
