// Tunable constants for the behavioural authenticity model. Nothing here is
// logic — the engine reads these and only these, so calibration against real
// certificates never requires touching the scoring code.
//
// These values are a defensible v1, NOT a calibrated model. They were chosen
// from the documented meaning of each TrustedForm signal, not fitted to data.
// Treat every number as provisional until the distributions in
// docs/TRUSTEDFORM_FEATURE_MAP.md have been reviewed against real traffic.

export const MODEL_VERSION = "0.2-insights";

// The score starts neutral and evidence moves it. This is deliberate: the
// previous model started at 100 and deducted, which meant a certificate we knew
// nothing about scored the same as one we knew was bad. Absent evidence must
// pull toward INCONCLUSIVE, never toward REJECT.
export const NEUTRAL_BASELINE = 50;

// --- Authenticity evidence (positive) ---
export const BOT_CHECK_PASSED = 8;
export const TYPING_OBSERVED = 14;
export const SUSTAINED_SESSION = 10; // seconds_on_page >= SUSTAINED_SESSION_SECONDS
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
// - form_input_kpm / form_input_wpm: observed values are not physically
//   meaningful as named (9651 kpm over a 133s session) and the ratio between
//   them is not constant, so no threshold can be trusted yet.
// - is_framed: legitimate embedded forms are framed constantly. On its own it
//   carries no signal; it is reported for context only.
// - Lead completeness (missing name/address/employee count): the API returns no
//   field-level data at all, so the old deductions could only ever have fired as
//   false negatives. Completeness is also explicitly out of scope per the spec.
// - Geographic mismatch between approx_ip_geo and the submitted address: a real
//   signal, but it belongs to lead quality rather than authenticity, and mobile
//   traffic routes through carrier IPs that move. Revisit with real data.
