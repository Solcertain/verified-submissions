import { describe, it, expect } from "vitest";
import { score_authenticity } from "../services/authenticity_scorer.js";
import { empty_features, type BehaviouralFeatures } from "../services/feature_extractor.js";
import { read_lead_fields, storable_payload, to_state_code, type LeadFields } from "../services/lead_fields.js";

const human: BehaviouralFeatures = {
  ...empty_features("test"),
  bot_detected: false,
  input_methods: ["typing"],
  typed: true,
  seconds_on_page: 180,
  geo_country_code: "US",
  geo_state: "Ohio",
};

const lead = (o: Partial<LeadFields>): LeadFields => ({
  first_name: "Mary",
  last_name: "Brennan",
  email: "mary.brennan@gmail.com",
  phone: "+14125550100",
  state: "OH",
  valid_phone: true,
  ...o,
});

function shadow_flags(l: LeadFields, f: BehaviouralFeatures = human): string[] {
  return score_authenticity(f, { lead: l }).shadow_findings.map((s) => s.flag!).filter(Boolean);
}

describe("placeholder_name", () => {
  it.each([
    ["First", "Last"],
    ["Test", "User"],
    ["test", "test"],
    ["John", "Doe"],
    ["asdf", "Smith"],
    ["Mary", "sdfgh"],
    ["Jon3", "Smith"],
    ["aaa", "Brennan"],
    ["Smith", "Smith"],
    ["", "!!"],
  ])("flags %s %s", (first_name, last_name) => {
    expect(shadow_flags(lead({ first_name, last_name }))).toContain("placeholder_name");
  });

  it.each([
    ["Mary", "Brennan"],
    ["Na", "Kim"],
    ["Nil", "Yilmaz"],
    ["Lynn", "Wright"],
    ["J", "Nguyen"],
    ["Wei", "Ng"],
    ["Sean", "O'Brien"],
    ["José", "García"],
    ["Mary-Kate", "Smith-Jones"],
  ])("leaves the real name %s %s alone", (first_name, last_name) => {
    expect(shadow_flags(lead({ first_name, last_name }))).not.toContain("placeholder_name");
  });
});

describe("disposable_email", () => {
  it.each(["pat@mailinator.com", "x@yopmail.com", "test@gmail.com", "fake@yahoo.com", "a@example.com"])(
    "flags %s",
    (email) => expect(shadow_flags(lead({ email }))).toContain("disposable_email"),
  );
  it.each(["pat.lee@gmail.com", "testa.rossi@outlook.com", "nobody.important@icloud.com"])(
    "leaves %s alone",
    (email) => expect(shadow_flags(lead({ email }))).not.toContain("disposable_email"),
  );
});

describe("ip_state_mismatch", () => {
  it("flags an IP in a different state from the lead", () => {
    expect(shadow_flags(lead({ state: "PA" }))).toContain("ip_state_mismatch");
  });
  it("is quiet when the states match or either is unknown", () => {
    expect(shadow_flags(lead({ state: "OH" }))).not.toContain("ip_state_mismatch");
    expect(shadow_flags(lead({ state: null }))).not.toContain("ip_state_mismatch");
    expect(shadow_flags(lead({ state: "PA" }), { ...human, geo_state: null })).not.toContain("ip_state_mismatch");
  });
});

describe("phone_unverified", () => {
  it("records Lead Prosper's invalid-phone verdict, and only that", () => {
    expect(shadow_flags(lead({ valid_phone: false }))).toContain("phone_unverified");
    expect(shadow_flags(lead({ valid_phone: true }))).not.toContain("phone_unverified");
    expect(shadow_flags(lead({ valid_phone: null }))).not.toContain("phone_unverified");
  });
});

describe("shadow means no effect", () => {
  it("never changes the score, flags or review decision, however fake the lead", () => {
    const clean = score_authenticity(human);
    const fake = score_authenticity(human, {
      lead: lead({ first_name: "First", last_name: "Last", email: "test@mailinator.com", state: "PA", valid_phone: false }),
    });
    expect(fake.score).toBe(clean.score);
    expect(fake.risk_flags).toEqual(clean.risk_flags);
    expect(fake.review_required).toBe(clean.review_required);
    expect(fake.shadow_findings.map((s) => s.flag).sort()).toEqual(
      ["disposable_email", "ip_state_mismatch", "phone_unverified", "placeholder_name"],
    );
  });

  it("keeps names, emails and phones out of the evidence", () => {
    const r = score_authenticity(human, {
      lead: lead({ first_name: "Zebulon", last_name: "Zebulon", email: "test@mailinator.com" }),
    });
    const text = JSON.stringify(r.shadow_findings);
    expect(text).not.toMatch(/zebulon|mailinator|4125550100/i);
  });
});

describe("lead fields", () => {
  it("reads Lead Prosper's values and ignores unfilled placeholders", () => {
    expect(
      read_lead_fields({ first_name: "{{first_name}}", last_name: " Lee ", state: "pa", valid_phone: "True" }),
    ).toMatchObject({ first_name: null, last_name: "Lee", state: "PA", valid_phone: true });
    expect(read_lead_fields({ valid_phone: "False" }).valid_phone).toBe(false);
    expect(to_state_code("Pennsylvania")).toBe("PA");
    expect(to_state_code("Narnia")).toBeNull();
  });

  it("drops names before storage but keeps what reuse detection needs", () => {
    const stored = storable_payload({ first_name: "Pat", last_name: "Lee", email: "p@x.com", phone: "1", lp_lead_id: "L1" });
    expect(stored).toEqual({ email: "p@x.com", phone: "1", lp_lead_id: "L1" });
  });
});
