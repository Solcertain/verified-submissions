import { describe, it, expect } from "vitest";
import { build_report, type ReportSubmission, type ReportOutcome } from "../services/verification_report.js";

const sub = (o: Partial<ReportSubmission>): ReportSubmission => ({
  id: "00000000-0000-0000-0000-000000000000",
  received_at: new Date("2026-10-20T12:00:00Z"),
  score: 95,
  status: "approved",
  classification: "STRONG_REAL_HUMAN",
  model_version: "0.4-insights",
  consent_verdict: "VERIFIED",
  risk_flags: [],
  shadow_flags: [],
  source: "solarenergynerds.com",
  is_mobile: true,
  ...o,
});

const period = { start: new Date("2026-10-14T00:00:00Z"), end: new Date("2026-10-21T00:00:00Z") };

describe("build_report", () => {
  const subs = [
    sub({ id: "a1" }),
    sub({ id: "a2", score: 85 }),
    sub({ id: "a3", score: 43, status: "review", classification: "LEAD_FARM_HUMAN_TYPER", risk_flags: ["synthetic_typing", "automation_environment"], is_mobile: false, consent_verdict: "VERIFIED" }),
    sub({ id: "a4", score: 70, classification: "REAL_HUMAN", consent_verdict: "MISSING_LANGUAGE", risk_flags: ["consent_language_missing"], shadow_flags: ["phone_unverified"], source: "google" }),
    sub({ id: "legacy", score: 0, status: "reject", model_version: null, classification: null, consent_verdict: null }),
  ];
  const outcomes: ReportOutcome[] = [
    { analysis_id: "a1", outcome: "sold", return_category: null },
    { analysis_id: "a2", outcome: "sold", return_category: null },
    { analysis_id: "a2", outcome: "returned", return_category: "contact_invalid" },
    { analysis_id: "a4", outcome: "returned", return_category: "lead_quality" },
    { analysis_id: "a3", outcome: "unsold", return_category: null },
    { analysis_id: "not-in-window", outcome: "returned", return_category: "fraud" },
  ];
  const r = build_report(subs, outcomes, period);

  it("separates current-model leads from legacy rows", () => {
    expect(r.leads.scored).toBe(5);
    expect(r.leads.current_model).toBe(4);
    expect(r.leads.legacy_model).toBe(1);
    expect(r.leads.by_status).toEqual({ approved: 3, review: 1 });
  });

  it("counts flags, shadow flags and sources", () => {
    expect(r.risk_flags).toEqual({ synthetic_typing: 1, automation_environment: 1, consent_language_missing: 1 });
    expect(r.shadow_flags).toEqual({ phone_unverified: 1 });
    expect(r.leads.by_source).toEqual({ "solarenergynerds.com": 4, google: 1 });
  });

  it("counts only verification reasons as verification returns", () => {
    expect(r.outcomes.returned).toBe(2);
    expect(r.outcomes.verification_returns).toBe(1);
  });

  it("reads the return rate by the score each lead had", () => {
    expect(r.outcomes.verification_return_rate_by_band["80–89"]).toEqual({ sold: 1, verification_returns: 1 });
    expect(r.outcomes.verification_return_rate_by_band["90–98"]).toEqual({ sold: 1, verification_returns: 0 });
    expect(r.outcomes.verification_return_rate_by_band["62–79"]).toEqual({ sold: 1, verification_returns: 0 });
  });

  it("lists held-back leads by id only", () => {
    expect(r.held_back).toEqual([{ id: "a3", score: 43, status: "review", flags: ["synthetic_typing", "automation_environment"] }]);
  });

  it("writes the report with plain-English meaning for each flag", () => {
    expect(r.markdown).toContain("5 leads scored");
    expect(r.leads.rescored).toBe(0);
    expect(r.markdown).toContain("a person cannot type without pressing keys");
    expect(r.markdown).toContain("Checks being measured");
  });
});

describe("confirmed leads", () => {
  const subs = [
    // Caught: held back at intake, later confirmed fraud. Its stored status was
    // later changed, but the label's snapshot is what the proof uses.
    sub({ id: "f1", score: 98, status: "approved", received_at: new Date("2026-10-17T20:32:21Z") }),
    sub({ id: "f2", score: 91 }), // missed: approved, confirmed fraud
    sub({ id: "g1", score: 55, status: "review", risk_flags: ["brief_session"] }), // false alarm
    sub({ id: "g2", score: 95 }), // relabelled: fraud, then genuine
  ];
  const outcomes: ReportOutcome[] = [
    { analysis_id: "f1", outcome: "unsold", return_category: null },
    {
      analysis_id: "f1",
      outcome: "confirmed_fraud",
      return_category: "fraud",
      recorded_at: new Date("2026-10-17T20:41:42Z"),
      engine_status: "review",
      engine_score: 58,
      engine_flags: ["synthetic_typing"],
      scored_at: new Date("2026-10-17T20:32:21Z"),
    },
    { analysis_id: "f2", outcome: "confirmed_fraud", return_category: "fraud", recorded_at: new Date("2026-10-18T00:00:00Z") },
    { analysis_id: "g1", outcome: "confirmed_genuine", return_category: null, recorded_at: new Date("2026-10-18T00:00:00Z") },
    { analysis_id: "g2", outcome: "confirmed_fraud", return_category: "fraud", recorded_at: new Date("2026-10-18T00:00:00Z") },
    { analysis_id: "g2", outcome: "confirmed_genuine", return_category: null, recorded_at: new Date("2026-10-19T00:00:00Z") },
  ];
  const r = build_report(subs, outcomes, period);

  it("scores the engine against what people confirmed", () => {
    expect(r.confirmed).toMatchObject({ fraud: 2, caught: 1, missed: 1, genuine: 2, false_alarms: 1 });
  });

  it("uses the decision recorded at intake, not the current one", () => {
    const f1 = r.confirmed.cases.find((c) => c.id === "f1")!;
    expect(f1).toMatchObject({ engine_result: "caught", score: 58, status: "review", flags: ["synthetic_typing"] });
    expect(f1.scored_at < f1.confirmed_at!).toBe(true);
  });

  it("lets the latest label stand", () => {
    expect(r.confirmed.cases.find((c) => c.id === "g2")!.engine_result).toBe("correctly_approved");
  });

  it("does not count a confirmation as a return", () => {
    expect(r.outcomes.returned).toBe(0);
  });

  it("writes the evidence into the report", () => {
    expect(r.markdown).toContain("Confirmed fraud: 1 of 2 caught at intake.");
    expect(r.markdown).toContain("**Caught** — `f1`, confirmed fraud. Scored 58 and review at 2026-10-17 20:32 UTC; confirmed 2026-10-17 20:41 UTC.");
    expect(r.markdown).toContain("**Missed** — `f2`");
  });

  it("says so plainly when nothing is confirmed", () => {
    const empty = build_report([sub({ id: "x" })], [], period);
    expect(empty.markdown).toContain("No leads confirmed by a person in this period yet.");
    expect(empty.markdown).not.toContain("Confirmed fraud:");
  });
});
