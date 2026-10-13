import { describe, it, expect } from "vitest";
import {
  is_certificate_reused,
  is_page_mismatch,
  read_landing_page_url,
} from "../services/certificate_integrity.js";
import { score_authenticity } from "../services/authenticity_scorer.js";
import { empty_features, type BehaviouralFeatures } from "../services/feature_extractor.js";
import { mapToLeadProsperFlatFields } from "../services/leadprosper_flat_fields.js";
import type { ScoreAndRouteOutcome } from "../services/score_and_route_service.js";

const lead_a = { lp_lead_id: "A1", email: "a@example.com", phone: "+14125550100" };

describe("is_certificate_reused", () => {
  it("treats a retry of the same lead as not reused", () => {
    expect(is_certificate_reused(lead_a, { ...lead_a })).toBe(false);
  });

  it("matches phone and email regardless of formatting", () => {
    expect(
      is_certificate_reused(lead_a, { email: " A@Example.com ", phone: "(412) 555-0100" }),
    ).toBe(false);
  });

  it("flags a different Lead Prosper lead id", () => {
    expect(is_certificate_reused(lead_a, { ...lead_a, lp_lead_id: "B2" })).toBe(true);
  });

  it("flags a different person", () => {
    expect(
      is_certificate_reused(lead_a, { email: "b@example.com", phone: "+17245550199" }),
    ).toBe(true);
  });

  it("flags a certificate first claimed with no lead identity", () => {
    // The real case: first claimed by a bare test request, later attached to leads.
    expect(is_certificate_reused({ certificate_url: "x" }, lead_a)).toBe(true);
  });

  it("does not flag when neither request identifies a lead", () => {
    expect(is_certificate_reused({}, {})).toBe(false);
  });
});

describe("is_page_mismatch", () => {
  it("ignores www and paths on the same site", () => {
    expect(
      is_page_mismatch(
        "https://solarenergynerds.com/form-step/",
        "https://www.solarenergynerds.com/form-step/?sub1=1",
      ),
    ).toBe(false);
  });

  it("flags a different site", () => {
    expect(
      is_page_mismatch("https://survey.solar-advisors.org/v7", "https://solarenergynerds.com/form-step/"),
    ).toBe(true);
  });

  it("never flags when either side is unknown", () => {
    expect(is_page_mismatch(null, "https://solarenergynerds.com/")).toBe(false);
    expect(is_page_mismatch("https://solarenergynerds.com/", undefined)).toBe(false);
    expect(is_page_mismatch("not a url", "https://solarenergynerds.com/")).toBe(false);
  });

  it("reads the landing page from the known field names", () => {
    expect(read_landing_page_url({ landing_page_url: " https://a.com/ " })).toBe("https://a.com/");
    expect(read_landing_page_url({ email: "x" })).toBeUndefined();
  });
});

const strong_human = (o: Partial<BehaviouralFeatures> = {}): BehaviouralFeatures => ({
  ...empty_features("test"),
  bot_detected: false,
  input_methods: ["typing"],
  typed: true,
  seconds_on_page: 180,
  page_url: "https://survey.solar-advisors.org/v7",
  ...o,
});

describe("scoring", () => {
  it("penalises and flags a reused certificate", () => {
    const r = score_authenticity(strong_human(), { certificate_reused: true });
    expect(r.score).toBe(58);
    expect(r.risk_flags).toContain("certificate_reused");
  });

  it("penalises and flags a page mismatch", () => {
    const r = score_authenticity(strong_human(), {
      landing_page_url: "https://solarenergynerds.com/form-step/",
    });
    expect(r.score).toBe(68);
    expect(r.risk_flags).toContain("certificate_page_mismatch");
  });

  it("is unchanged when the landing page is not supplied", () => {
    expect(score_authenticity(strong_human()).score).toBe(88);
  });
});

describe("Lead Prosper status", () => {
  const cached = (o: Partial<Extract<ScoreAndRouteOutcome, { kind: "cached" }>>) =>
    mapToLeadProsperFlatFields({
      kind: "cached",
      certificate_url: "https://cert.trustedform.com/113df94c36f001b9080831f9026ecfdef097dbad",
      stored_at: null,
      analysis_id: null,
      parsed_lead: { legacy: {}, features: strong_human() },
      score: null,
      required_consent_terms: undefined,
      certificate_reused: false,
      landing_page_url: undefined,
      ...o,
    });

  it("sends a reused certificate to review even when the human is strong", () => {
    const r = cached({ certificate_reused: true });
    expect(r.vs_status).toBe("review");
    expect(r.vs_recommended_action).toBe("review");
    expect(r.vs_risk_flags).toContain("certificate_reused");
  });

  it("approves the same strong human when the certificate is not reused", () => {
    expect(cached({}).vs_status).toBe("approved");
  });
});
