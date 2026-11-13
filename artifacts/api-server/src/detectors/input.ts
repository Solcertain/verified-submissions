import * as R from "../config/authenticity_rules.js";
import { NONE, type Detector, type Finding } from "./types.js";

// TrustedForm's bot check: the single strongest signal it offers. A null
// result is silence — we asked and got nothing, which is not evidence of a human.
export const bot_check: Detector = {
  id: "bot_check",
  family: "authenticity",
  status: "active",
  description: "TrustedForm's own bot detection on the session.",
  evaluate({ features: f }) {
    if (f.bot_detected === true) {
      return {
        signals: 1,
        findings: [
          { points: -R.BOT_DETECTED, flag: "bot_detected", evidence: "TrustedForm flagged this session as a bot." },
        ],
      };
    }
    if (f.bot_detected === false) {
      return { signals: 1, findings: [{ points: R.BOT_CHECK_PASSED, evidence: "TrustedForm's bot check passed." }] };
    }
    return NONE;
  },
};

// How the fields were filled. Only meaningful when TrustedForm reported the array.
export const input_method: Detector = {
  id: "input_method",
  family: "input",
  status: "active",
  description: "Whether the form was typed, autofilled or pasted.",
  evaluate({ features: f }) {
    if (f.input_methods === null) return NONE;
    const findings: Finding[] = [];
    if (f.typed === true) {
      findings.push({
        points: R.TYPING_OBSERVED,
        evidence:
          f.autofilled === true
            ? "Fields were typed, with some autofilled — normal mixed human behaviour."
            : "Fields were typed by hand.",
      });
    } else {
      findings.push({
        points: -R.NO_TYPING_AT_ALL,
        flag: "no_typing_observed",
        evidence: "No typing at all — the form was populated without keystrokes.",
      });
    }
    if (f.pasted === true) {
      findings.push({ points: -R.PASTED_INPUT, flag: "pasted_input", evidence: "At least one field was pasted." });
    }
    return { signals: 1, findings };
  },
};

// Faster than a person types. Only meaningful when there was typing to measure.
export const superhuman_typing: Detector = {
  id: "superhuman_typing",
  family: "input",
  status: "active",
  description: "Typing faster than any person can sustain.",
  evaluate({ features: f }) {
    if (f.typed !== true || f.form_input_kpm === null || f.form_input_kpm <= R.SUPERHUMAN_TYPING_KPM) return NONE;
    return {
      findings: [
        {
          points: -R.SUPERHUMAN_TYPING,
          flag: "superhuman_typing_speed",
          evidence: `Typing ran at ${Math.round(f.form_input_kpm)} keys/min — faster than a person types.`,
        },
      ],
    };
  },
};

// Typed text that no real keystrokes could have produced: zero keystrokes, or
// more words than keystrokes at a speed no person on our forms has shown. See
// SYNTHETIC_FAST_KPM for why the slower case is no longer evidence of an agent.
function words_over_keys(kpm: number, wpm: number | null): boolean {
  return wpm !== null && wpm > kpm;
}

export const synthetic_typing: Detector = {
  id: "synthetic_typing",
  family: "input",
  status: "active",
  description: "Text reported as typed that no real keystrokes could have produced.",
  evaluate({ features: f }) {
    if (f.typed !== true || f.form_input_kpm === null) return NONE;
    const kpm = f.form_input_kpm;
    const wpm = f.form_input_wpm;
    const fast_injection = words_over_keys(kpm, wpm) && kpm >= R.SYNTHETIC_FAST_KPM;
    if (!(kpm === 0 || fast_injection)) return NONE;
    return {
      findings: [
        {
          points: -R.SYNTHETIC_TYPING,
          flag: "synthetic_typing",
          forces_review: true,
          evidence:
            kpm === 0
              ? "Text was entered as typing but with zero keystrokes — a person cannot type without pressing keys."
              : `More words (${Math.round(wpm!)}/min) than keystrokes (${Math.round(kpm)}/min) at machine speed — impossible for real typing.`,
        },
      ],
    };
  },
};

// The slow words-over-keys pattern: what predictive text and swipe typing
// produce on a phone. Recorded in shadow so it stays measurable against
// outcomes; it costs a lead nothing.
export const keyboard_word_insertion: Detector = {
  id: "keyboard_word_insertion",
  family: "input",
  status: "shadow",
  description: "Whole words inserted per keystroke at human speed, as phone keyboards' predictive and swipe typing do.",
  evaluate({ features: f }) {
    if (f.typed !== true || f.form_input_kpm === null) return NONE;
    const kpm = f.form_input_kpm;
    if (kpm === 0 || kpm >= R.SYNTHETIC_FAST_KPM || !words_over_keys(kpm, f.form_input_wpm)) return NONE;
    return {
      findings: [
        {
          points: -R.KEYBOARD_WORD_INSERTION,
          flag: "keyboard_word_insertion",
          evidence: "More words than keystrokes at a human typing speed — the pattern of predictive or swipe typing.",
        },
      ],
    };
  },
};
