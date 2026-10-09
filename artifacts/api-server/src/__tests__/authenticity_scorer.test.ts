import { describe, it, expect } from "vitest";
import { score_authenticity } from "../services/authenticity_scorer.js";
import { extract_features, empty_features } from "../services/feature_extractor.js";
import type { BehaviouralFeatures } from "../services/feature_extractor.js";
import real_claim from "./fixtures/claim_with_scans.json";

// Covers the scenarios required by the MVP spec. The engine is pure, so none of
// these touch the network, the database or the clock.

const F = (o: Partial<BehaviouralFeatures>): BehaviouralFeatures => ({
  ...empty_features("test"),
  ...o,
});

describe("automation", () => {
  it("classifies a TrustedForm bot flag as BOT_OR_SCRIPT", () => {
    const r = score_authenticity(F({ bot_detected: true, seconds_on_page: 40 }));
    expect(r.classification).toBe("BOT_OR_SCRIPT");
    expect(r.risk_flags).toContain("bot_detected");
  });

  it("classifies instant injection as automation and flags it", () => {
    const r = score_authenticity(
      F({ bot_detected: false, input_methods: ["autofill"], typed: false, seconds_on_page: 2 }),
    );
    expect(r.classification).toBe("AUTOFILL_OR_HIGH_RISK_AUTOMATION");
    expect(r.risk_flags).toContain("instant_submission");
  });

  it("classifies autofill-only as automation even on a long session", () => {
    const r = score_authenticity(
      F({ bot_detected: false, input_methods: ["autofill"], typed: false, seconds_on_page: 45 }),
    );
    expect(r.classification).toBe("AUTOFILL_OR_HIGH_RISK_AUTOMATION");
  });
});

describe("humans", () => {
  it("treats fast typing as human, not automation", () => {
    const r = score_authenticity(
      F({ bot_detected: false, input_methods: ["typing"], typed: true, seconds_on_page: 12 }),
    );
    expect(r.classification).not.toBe("AUTOFILL_OR_HIGH_RISK_AUTOMATION");
    expect(r.risk_flags).toContain("brief_session");
  });

  it("classifies ordinary typing as REAL_HUMAN", () => {
    const r = score_authenticity(
      F({ bot_detected: false, input_methods: ["typing"], typed: true, seconds_on_page: 45 }),
    );
    expect(r.classification).toBe("REAL_HUMAN");
  });

  it("reserves STRONG_REAL_HUMAN for a sustained typed session", () => {
    const r = score_authenticity(
      F({ bot_detected: false, input_methods: ["typing"], typed: true, seconds_on_page: 150 }),
    );
    expect(r.classification).toBe("STRONG_REAL_HUMAN");
    expect(r.confidence).toBe("HIGH");
  });
});

describe("unknown is never treated as bad", () => {
  it("returns INCONCLUSIVE at the neutral baseline with no signals", () => {
    const r = score_authenticity(extract_features({}));
    expect(r.classification).toBe("INCONCLUSIVE");
    expect(r.confidence).toBe("LOW");
    expect(r.score).toBe(50);
    expect(r.risk_flags).toEqual([]);
  });

  it("scores an unknown certificate far above a known-bad one", () => {
    const unknown = score_authenticity(F({}));
    const bad = score_authenticity(
      F({ bot_detected: true, input_methods: ["autofill"], typed: false, seconds_on_page: 1 }),
    );
    expect(unknown.score).toBeGreaterThan(bad.score + 30);
  });

  it("returns INCONCLUSIVE for a malformed claim response", () => {
    expect(score_authenticity(extract_features("garbage")).classification).toBe("INCONCLUSIVE");
  });
});

describe("consent is a separate axis from authenticity", () => {
  // The case that motivated the split: a real human on a partner form whose
  // consent language is deficient. Collapsing these into one score would force
  // a choice between two true statements.
  const r = score_authenticity(
    F({
      bot_detected: false,
      input_methods: ["typing", "autofill"],
      typed: true,
      autofilled: true,
      seconds_on_page: 133,
      consent_verified: false,
      consent_terms_missing: [
        "prior express written consent",
        "automatic telephone dialing system",
        "Do Not Call",
      ],
    }),
  );

  it("still recognises the human", () => {
    expect(["REAL_HUMAN", "STRONG_REAL_HUMAN"]).toContain(r.classification);
  });

  it("reports the consent failure independently", () => {
    expect(r.consent.verdict).toBe("MISSING_LANGUAGE");
    expect(r.risk_flags).toContain("consent_language_missing");
  });

  it("reports only the core TCPA terms, not every missing phrase", () => {
    expect(r.consent.missing_core_terms).toEqual([
      "prior express written consent",
      "automatic telephone dialing system",
    ]);
  });

  it("distinguishes not-evaluated from failed", () => {
    expect(score_authenticity(F({})).consent.verdict).toBe("NOT_EVALUATED");
  });
});

describe("confidence reflects evidence, not score", () => {
  it("drops to MEDIUM when signals disagree", () => {
    const r = score_authenticity(
      F({ bot_detected: true, input_methods: ["typing"], typed: true, seconds_on_page: 40 }),
    );
    expect(r.confidence).not.toBe("HIGH");
  });

  it("is LOW when only one signal was available", () => {
    expect(score_authenticity(F({ bot_detected: false })).confidence).toBe("LOW");
  });
});

describe("determinism and derived values", () => {
  const features = extract_features(real_claim);

  it("produces identical results for identical input", () => {
    expect(score_authenticity(features)).toEqual(score_authenticity(features));
  });

  it("derives the 1-10 score from the canonical score", () => {
    const r = score_authenticity(features);
    expect(r.score_1_10).toBe(Math.max(1, Math.min(10, Math.ceil(r.score / 10))));
  });

  it("scores the real captured certificate as a human with deficient consent", () => {
    const r = score_authenticity(features);
    expect(r.classification).toBe("STRONG_REAL_HUMAN");
    expect(r.confidence).toBe("HIGH");
    expect(r.consent.verdict).toBe("MISSING_LANGUAGE");
  });
});
