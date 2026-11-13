import { describe, it, expect } from "vitest";
import { score_authenticity } from "../services/authenticity_scorer.js";
import { empty_features, type BehaviouralFeatures } from "../services/feature_extractor.js";
import { status_for } from "../services/verdict.js";
import { MODEL_VERSION, SYNTHETIC_FAST_KPM } from "../config/authenticity_rules.js";
import { assemble_queue, FRAUD_RETURN_PATTERN, type QueueItem } from "../services/label_queue.js";
import { flag_accuracy_lines } from "../services/verification_report.js";

// Model 0.5: synthetic_typing narrowed to machine speed, the phone-keyboard
// pattern moved to shadow, and repeat submissions scored. Cases are real leads
// from Oct-Nov 2026, reduced to the features that matter.

// A strong human on our own form: bot check passed, typed, long session,
// consent verified, on a phone.
const human = (o: Partial<BehaviouralFeatures>): BehaviouralFeatures => ({
  ...empty_features("test"),
  bot_detected: false,
  input_methods: ["typing"],
  typed: true,
  seconds_on_page: 180,
  consent_verified: true,
  os_name: "iOS",
  is_mobile: true,
  form_input_kpm: 140,
  form_input_wpm: 40,
  ...o,
});

describe("model 0.5", () => {
  it("is the live version", () => {
    expect(MODEL_VERSION).toBe("0.5");
  });
});

describe("synthetic typing, narrowed", () => {
  it("approves a phone lead whose keyboard inserted words (Android, 74 kpm / 151 wpm, Nov 2026)", () => {
    const r = score_authenticity(
      human({ os_name: "Android", input_methods: ["typing", "autofill"], autofilled: true, seconds_on_page: 122, form_input_kpm: 74, form_input_wpm: 151 }),
    );
    expect(r.risk_flags).not.toContain("synthetic_typing");
    expect(r.review_required).toBe(false);
    expect(status_for(r)).toBe("approved");
    expect(r.shadow_findings.map((f) => f.flag)).toEqual(["keyboard_word_insertion"]);
  });

  it("approves the fastest real phone case seen (252 kpm / 421 wpm)", () => {
    const r = score_authenticity(human({ form_input_kpm: 252, form_input_wpm: 421 }));
    expect(status_for(r)).toBe("approved");
  });

  it("still holds back the operator-confirmed fraud bd14ca1c (571 kpm / 631 wpm, iOS, 230s)", () => {
    const r = score_authenticity(human({ seconds_on_page: 230, form_input_kpm: 571, form_input_wpm: 631 }));
    expect(r.risk_flags).toContain("synthetic_typing");
    expect(r.review_required).toBe(true);
    expect(status_for(r)).toBe("review");
  });

  it("forces review exactly from the threshold up", () => {
    const below = score_authenticity(human({ form_input_kpm: SYNTHETIC_FAST_KPM - 1, form_input_wpm: SYNTHETIC_FAST_KPM + 50 }));
    const at = score_authenticity(human({ form_input_kpm: SYNTHETIC_FAST_KPM, form_input_wpm: SYNTHETIC_FAST_KPM + 50 }));
    expect(below.risk_flags).not.toContain("synthetic_typing");
    expect(at.risk_flags).toContain("synthetic_typing");
  });

  it("always forces review for typed text with zero keystrokes", () => {
    const r = score_authenticity(human({ form_input_kpm: 0, form_input_wpm: 0 }));
    expect(r.risk_flags).toContain("synthetic_typing");
    expect(r.shadow_findings.map((f) => f.flag)).not.toContain("keyboard_word_insertion");
  });

  it("records nothing for normal typing", () => {
    const r = score_authenticity(human({}));
    expect(r.shadow_findings).toEqual([]);
  });
});

describe("repeat submission", () => {
  it("costs 10 points without forcing review", () => {
    const first = score_authenticity(human({}));
    const repeat = score_authenticity(human({}), { prior_submissions: { count: 2, days_since_last: 3.4 } });
    expect(first.score - repeat.score).toBe(10);
    expect(repeat.risk_flags).toContain("repeat_submission");
    expect(repeat.review_required).toBe(false);
    expect(repeat.evidence.join(" ")).toContain("2 other leads, most recently 3 days earlier");
  });

  it("says same day for a repeat within 24 hours", () => {
    const r = score_authenticity(human({}), { prior_submissions: { count: 1, days_since_last: 0.2 } });
    expect(r.evidence.join(" ")).toContain("1 other lead, most recently earlier the same day");
  });

  it("does nothing when there is no prior lead or the lookup returned nothing", () => {
    expect(score_authenticity(human({})).risk_flags).not.toContain("repeat_submission");
    expect(score_authenticity(human({}), { prior_submissions: { count: 0, days_since_last: 0 } }).risk_flags).not.toContain(
      "repeat_submission",
    );
  });

  it("never puts the contact detail in its evidence", () => {
    const r = score_authenticity(human({}), {
      prior_submissions: { count: 1, days_since_last: 5 },
      lead: { first_name: null, last_name: null, email: "someone@example.org", phone: "4125550100", state: "PA", valid_phone: true },
    });
    const text = r.evidence.join(" ");
    expect(text).not.toContain("4125550100");
    expect(text).not.toContain("someone@example.org");
  });
});

const item = (id: string, reason: QueueItem["reason"]): QueueItem => ({
  analysis_id: id,
  reason,
  received_at: "2026-11-10T00:00:00.000Z",
  score: 90,
  status: "approved",
  flags: [],
  shadow_flags: [],
  evidence: [],
  device: null,
  is_mobile: null,
  kpm: null,
  wpm: null,
  seconds_on_page: null,
  outcome: null,
  return_reason: null,
});

describe("label queue", () => {
  it("orders held back, then fraud returns, then controls, each lead once", () => {
    const q = assemble_queue([item("a", "held_back")], [item("b", "fraud_return"), item("a", "fraud_return")], [item("c", "control")]);
    expect(q.map((i) => `${i.analysis_id}:${i.reason}`)).toEqual(["a:held_back", "b:fraud_return", "c:control"]);
  });

  it("recognises the buyer wording seen in real returns", () => {
    const re = new RegExp(FRAUD_RETURN_PATTERN, "i");
    for (const said of [
      "wrong number and emaill. they didnt sumbit anything ",
      'Not a real person. "First Last"',
      "Fake name, non-working email, non-working phone number",
      "Was not the home owner and does not even live at that address ",
      "Homeowner said they never filled out a form",
    ]) {
      expect(re.test(said), said).toBe(true);
    }
    for (const said of ["Outside of Territory", "Duplicate lead", "already has solar"]) {
      expect(re.test(said), said).toBe(false);
    }
  });
});

describe("flag accuracy in the report", () => {
  const c = (label: "fraud" | "genuine", flags: string[]) => ({
    id: Math.random().toString(16).slice(2),
    label,
    engine_result: "caught" as const,
    score: 50,
    status: "review",
    flags,
    model_version: "0.5",
    scored_at: null,
    confirmed_at: null,
  });

  it("stays silent below ten labels", () => {
    expect(flag_accuracy_lines([c("fraud", ["synthetic_typing"])] as never)).toEqual([]);
  });

  it("reports, per flag, how many labelled leads were really fraud", () => {
    const cases = [
      ...Array.from({ length: 3 }, () => c("fraud", ["synthetic_typing"])),
      c("genuine", ["synthetic_typing"]),
      ...Array.from({ length: 6 }, () => c("genuine", [])),
    ];
    const lines = flag_accuracy_lines(cases as never);
    expect(lines).toContain("| `synthetic_typing` | 4 | 3 (75%) |");
  });
});
