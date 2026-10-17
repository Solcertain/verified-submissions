import type { BehaviouralFeatures } from "../services/feature_extractor.js";
import type { AuthenticityResult, ScoreOptions } from "../services/authenticity_scorer.js";

// A detector is one self-contained check. The scorer knows nothing about any
// individual signal: it runs every registered detector in order and adds up
// what they report. Adding a check for a new kind of bot means adding one file
// to src/detectors and one line to the registry — nothing else changes.

export type DetectorFamily =
  | "authenticity" // TrustedForm's own human/bot verdict
  | "input" // how text got into the form
  | "session" // time on page
  | "environment" // device, browser, network
  | "consent" // whether the consent is legally meaningful
  | "certificate" // whether the certificate belongs to this lead
  | "plausibility"; // whether the person described by the lead looks real

// active: findings move the score and appear in risk_flags.
// shadow: findings are computed and reported in shadow_findings only, so a new
// check can be measured against live traffic before it is allowed to cost a
// real lead anything.
export type DetectorStatus = "active" | "shadow";

export interface DetectorInput {
  features: BehaviouralFeatures;
  options: ScoreOptions;
  // Assessed once by the scorer because it is also part of the result.
  consent: AuthenticityResult["consent"];
}

export interface Finding {
  // Signed contribution to the score: positive is evidence of a real person.
  points: number;
  // Present only for findings that are risks.
  flag?: string;
  // One plain-English sentence; this is what reaches vs_reason and reports.
  evidence?: string;
  // The lead goes to review regardless of score.
  forces_review?: boolean;
}

export interface DetectorResult {
  findings: Finding[];
  // How many of TrustedForm's authenticity signals this detector consumed.
  // Confidence is breadth of evidence, so only signal-bearing detectors set it.
  signals?: number;
}

export interface Detector {
  id: string;
  family: DetectorFamily;
  status: DetectorStatus;
  // What the check looks for, in a sentence a prospect would understand.
  description: string;
  evaluate(input: DetectorInput): DetectorResult;
}

export interface ShadowFinding {
  detector: string;
  flag?: string;
  points: number;
  evidence?: string;
  forces_review?: boolean;
}

export const NONE: DetectorResult = { findings: [] };
