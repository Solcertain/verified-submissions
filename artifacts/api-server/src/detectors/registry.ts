import type { Detector } from "./types.js";
import { bot_check, input_method, superhuman_typing, synthetic_typing } from "./input.js";
import { automation_environment } from "./environment.js";
import { session_duration } from "./session.js";
import { consent_language } from "./consent.js";
import { certificate_page_mismatch, certificate_reuse, stale_certificate } from "./certificate.js";

// Every check the engine runs, in order. Order only affects the order of
// sentences in vs_reason, never the score.
//
// To add a check: write it in the matching family file, add it here with
// status "shadow", watch its shadow_findings on live traffic, then promote it
// to "active" in a new MODEL_VERSION. See docs/BOT_LAB.md.
export const DETECTORS: readonly Detector[] = [
  bot_check,
  input_method,
  superhuman_typing,
  synthetic_typing,
  automation_environment,
  session_duration,
  consent_language,
  stale_certificate,
  certificate_reuse,
  certificate_page_mismatch,
];
