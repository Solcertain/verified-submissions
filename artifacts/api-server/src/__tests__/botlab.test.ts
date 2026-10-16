import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { score_authenticity, type AuthenticityResult } from "../services/authenticity_scorer.js";
import { extract_features, empty_features, type BehaviouralFeatures } from "../services/feature_extractor.js";
import { DETECTORS } from "../detectors/registry.js";
import type { Detector } from "../detectors/types.js";

// The bot lab: every captured agent must be stopped, and every real human in
// the baseline must get through untouched. Adding a newly captured bot is
// dropping its claim response into fixtures/botlab/agents — no code. See
// docs/BOT_LAB.md for how fixtures are captured.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "botlab");

// Flags that say "this was not a person". A human baseline case carrying any
// of them is a false positive.
const AUTOMATION_FLAGS = [
  "bot_detected",
  "no_typing_observed",
  "superhuman_typing_speed",
  "synthetic_typing",
  "automation_environment",
  "instant_submission",
];

function read_json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function files(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(ROOT, dir, f));
}

// A lead reaches a buyer only when it is classified human and nothing forced review.
function approved(r: AuthenticityResult): boolean {
  return (r.classification === "REAL_HUMAN" || r.classification === "STRONG_REAL_HUMAN") && !r.review_required;
}

describe("bot lab: agents", () => {
  const agents = files("agents");

  it("has at least one captured agent", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  for (const file of agents) {
    it(`stops ${path.basename(file, ".json")}`, () => {
      const r = score_authenticity(extract_features(read_json(file)));
      expect(approved(r), `scored ${r.score} ${r.classification} [${r.risk_flags.join(", ")}]`).toBe(false);
      expect(r.risk_flags.some((f) => AUTOMATION_FLAGS.includes(f))).toBe(true);
    });
  }
});

describe("bot lab: real humans", () => {
  for (const file of files("humans")) {
    const corpus = read_json(file) as { cases: BehaviouralFeatures[] };

    it(`${path.basename(file, ".json")}: no case carries an automation flag`, () => {
      const offenders = corpus.cases
        .map((f, i) => ({ i, r: score_authenticity(f) }))
        .filter(({ r }) => r.risk_flags.some((f) => AUTOMATION_FLAGS.includes(f)))
        .map(({ i, r }) => `#${i}: ${r.risk_flags.join(", ")}`);
      expect(offenders).toEqual([]);
    });

    it(`${path.basename(file, ".json")}: no case is classified as automation`, () => {
      const classes = corpus.cases.map((f) => score_authenticity(f).classification);
      expect(classes.filter((c) => c === "BOT_OR_SCRIPT" || c === "AUTOFILL_OR_HIGH_RISK_AUTOMATION")).toEqual([]);
    });
  }
});

describe("detector registry", () => {
  it("has unique ids and a description for every check", () => {
    const ids = DETECTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DETECTORS) expect(d.description.length).toBeGreaterThan(10);
  });

  // A candidate check that would flag every lead, run in shadow mode.
  const candidate: Detector = {
    id: "candidate_check",
    family: "environment",
    status: "shadow",
    description: "Test candidate that fires on everything.",
    evaluate: () => ({
      findings: [{ points: -50, flag: "candidate_flag", evidence: "Candidate fired.", forces_review: true }],
    }),
  };
  const human: BehaviouralFeatures = {
    ...empty_features("test"),
    bot_detected: false,
    input_methods: ["typing"],
    typed: true,
    seconds_on_page: 180,
  };

  it("never lets a shadow check move the score, flags or review decision", () => {
    const live = score_authenticity(human);
    const shadowed = score_authenticity(human, {}, [...DETECTORS, candidate]);
    expect(shadowed.score).toBe(live.score);
    expect(shadowed.risk_flags).toEqual(live.risk_flags);
    expect(shadowed.review_required).toBe(live.review_required);
    expect(shadowed.shadow_findings).toEqual([
      { detector: "candidate_check", points: -50, flag: "candidate_flag", evidence: "Candidate fired.", forces_review: true },
    ]);
  });

  it("applies the same check once promoted to active", () => {
    const promoted = score_authenticity(human, {}, [...DETECTORS, { ...candidate, status: "active" }]);
    expect(promoted.score).toBe(score_authenticity(human).score - 50);
    expect(promoted.risk_flags).toContain("candidate_flag");
    expect(promoted.review_required).toBe(true);
  });
});
