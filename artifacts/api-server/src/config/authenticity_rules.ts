// Tunable constants for the behavioural authenticity model. Nothing here is
// logic — the engine reads these and only these, so calibration against real
// certificates never requires touching the scoring code.
//
// These values are a defensible v1, NOT a calibrated model. They were chosen
// from the documented meaning of each TrustedForm signal, not fitted to data.
// Treat every number as provisional until the distributions in
// docs/TRUSTEDFORM_FEATURE_MAP.md have been reviewed against real traffic.

export const MODEL_VERSION = "0.4-insights";

// The score starts neutral and evidence moves it. This is deliberate: the
// previous model started at 100 and deducted, which meant a certificate we knew
// nothing about scored the same as one we knew was bad. Absent evidence must
// pull toward INCONCLUSIVE, never toward REJECT.
export const NEUTRAL_BASELINE = 50;

// --- Authenticity evidence (positive) ---
export const BOT_CHECK_PASSED = 8;
export const TYPING_OBSERVED = 14;
// A sustained session earns SUSTAINED_SESSION, then ramps linearly up to
// SUSTAINED_SESSION_MAX at LONG_SESSION_SECONDS. 0.2 awarded a flat +10 at 60s,
// so every real human landed on exactly 82 and the score carried no spread.
export const SUSTAINED_SESSION = 8; // seconds_on_page >= SUSTAINED_SESSION_SECONDS
export const SUSTAINED_SESSION_MAX = 16; // seconds_on_page >= LONG_SESSION_SECONDS
export const MODERATE_SESSION = 5; // seconds_on_page >= MODERATE_SESSION_SECONDS

// --- Authenticity evidence (negative) ---
export const BOT_DETECTED = 45;
export const NO_TYPING_AT_ALL = 25; // filled entirely without typing
export const PASTED_INPUT = 10;
export const INSTANT_SESSION = 30; // seconds_on_page < INSTANT_SESSION_SECONDS
export const BRIEF_SESSION = 12; // seconds_on_page < BRIEF_SESSION_SECONDS

// --- Thresholds ---
export const INSTANT_SESSION_SECONDS = 5;
export const BRIEF_SESSION_SECONDS = 15;
export const MODERATE_SESSION_SECONDS = 30;
export const SUSTAINED_SESSION_SECONDS = 60;
export const LONG_SESSION_SECONDS = 180;

// --- Consent weighting ---
// 0.2 reported consent alongside the score without moving it, so a lead whose
// disclosure lacked the core TCPA phrasing scored the same as one that passed.
// Missing language is sized so the best possible behavioural lead
// (50+8+14+16-15 = 73) falls out of STRONG_REAL_HUMAN into REAL_HUMAN: still
// approved, but visibly distinguishable. Not-evaluated stays neutral, because
// "we did not check" is not a failure.
export const CONSENT_VERIFIED = 10;
export const CONSENT_LANGUAGE_MISSING = 15;

// --- Typing speed ---
// form_input_kpm was left unscored because the first sample looked meaningless
// (9651 kpm). That sample was a partner certificate. Across a week of real
// traffic our own form ranged 38-280 kpm, while partner certificates showed 361,
// 438, 1572 and 9652. A 100 wpm typist is ~500 kpm, so the threshold sits well
// above anything a person sustains; it catches scripted or tool-driven input,
// not fast humans.
export const SUPERHUMAN_TYPING_KPM = 600;
export const SUPERHUMAN_TYPING = 15;

// --- Certificate age at claim ---
// We claim within seconds of submission, so a certificate's age at claim is how
// long ago the consent happened. Our own form shows 2-13s, or ~5 minutes on
// delayed posts (oldest 348s); partner certificates arrived 53 minutes and 22
// hours old. Thirty minutes is five times the oldest legitimate path observed.
export const STALE_CERTIFICATE_SECONDS = 1800;
export const STALE_CERTIFICATE = 15;

// --- Certificate integrity ---
// A certificate presented for a different lead than the one that first claimed
// it, or captured on a different site than the lead's landing page, does not
// evidence consent for THIS lead. Either sends the lead to review regardless of
// score; the penalty makes it visible in vs_score as well.
export const CERTIFICATE_REUSED = 30;
export const CERTIFICATE_PAGE_MISMATCH = 20;

// --- Classification bands, applied to the 0-100 authenticity score ---
export const STRONG_HUMAN_MIN = 80;
export const REAL_HUMAN_MIN = 62;
export const LEAD_FARM_MAX = 61; // below REAL_HUMAN_MIN but above automation
export const AUTOMATION_MAX = 38;

// --- Confidence ---
// Confidence reflects how much evidence we actually had and whether it agreed,
// not how high the score is. A confident 20 and an unconfident 20 are different
// operational facts.
// TrustedForm offers exactly three authenticity signals — bot_detected,
// form_input_method and seconds_on_page. HIGH therefore means "we had all of
// them", not an arbitrary count.
export const MIN_SIGNALS_FOR_HIGH_CONFIDENCE = 3;
export const MIN_SIGNALS_FOR_MEDIUM_CONFIDENCE = 2;

// --- Consent ---
// Phrases that must appear for consent to autodialed or prerecorded contact to
// be meaningful. Absence of these is what distinguishes a real consent gap from
// a page that merely lacks TrustedForm tagging — see
// docs/TRUSTEDFORM_FEATURE_MAP.md §7.
export const CORE_TCPA_TERMS = [
  "prior express written consent",
  "automatic telephone dialing system",
] as const;

// Deliberately NOT scored, and deliberately listed so the omissions are visible:
//
// - form_input_wpm: kpm is scored (see SUPERHUMAN_TYPING_KPM); wpm carries the
//   same information less directly and is not scored separately.
// - is_framed: legitimate embedded forms are framed constantly. On its own it
//   carries no signal; it is reported for context only.
// - Lead completeness (missing name/address/employee count): the API returns no
//   field-level data at all, so the old deductions could only ever have fired as
//   false negatives. Completeness is also explicitly out of scope per the spec.
// - Geographic mismatch between approx_ip_geo and the submitted address: a real
//   signal, but it belongs to lead quality rather than authenticity, and mobile
//   traffic routes through carrier IPs that move. Revisit with real data.
