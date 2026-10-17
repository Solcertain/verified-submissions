# Scoring Model Reference

**Authoritative description of the live scoring engine.** If anything here
disagrees with the code, the code is right and this file is out of date.

| | |
|---|---|
| Model version | `0.4-insights` |
| Code | `artifacts/api-server/src/detectors/` (checks), `src/config/authenticity_rules.ts` (every weight and threshold), `src/services/authenticity_scorer.ts` (aggregation) |
| Last verified against code | 2026-10-17 |
| Audience | Internal. Thresholds and signal combinations are not for prospects — see [What not to publish](#what-not-to-publish). |

Related: [OPERATIONS.md](OPERATIONS.md) (integration, deployment, data),
[BOT_LAB.md](BOT_LAB.md) (keeping up with new bots),
[TRUSTEDFORM_FEATURE_MAP.md](TRUSTEDFORM_FEATURE_MAP.md) (research on what TrustedForm returns).

---

## 1. What the score answers

One question: **was a real person, giving real consent, on the form that
produced this lead?**

It deliberately does **not** answer whether the lead will buy, qualifies, or
fits a buyer. "Credit fail" or "not interested" is a real person correctly
verified. Those belong to a separate lead-quality measure that does not exist
yet.

Three axes are kept apart because they need different responses:

| Axis | Question | Example failure |
|---|---|---|
| Authenticity | Was a human there? | AI agent injecting text |
| Consent | Is the consent legally meaningful? | Partner page missing TCPA phrasing |
| Integrity | Does this certificate belong to this lead? | One certificate on two different leads |

All three move the single `vs_score`, but each is also reported on its own
(`vs_classification`, `vs_consent_detected`, `vs_risk_flags`).

---

## 2. Pipeline

```
Lead Prosper pre-ping
  → POST /api/leadprosper/pre-ping
  → normalise payload (find the certificate under any of 8 field names)
  → already claimed?  yes → rescore stored features with the current model,
                              and check whether this is the same lead (reuse)
                       no  → claim from TrustedForm (v4: insights + verify + scans)
  → extract features
  → run every detector in the registry, sum findings
  → classify, assign confidence, decide status
  → return flat vs_* fields (always HTTP 200)
```

- The claim is synchronous, with a **5-second timeout**, and each claim is a
  **metered** TrustedForm call. A timeout or failure returns an inconclusive
  result (§9), never a reject: our failure to read a certificate must not kill
  a lead.
- A certificate is claimed once. Later requests for the same certificate are
  rescored from stored features under the *current* model, so model upgrades
  apply to retries and no stored score is ever replayed.
- The engine is **pure and deterministic**: no network, database, clock or
  randomness inside scoring. Same features, same model version, same result.

---

## 3. Inputs

### From TrustedForm (per certificate)

| Feature | Source | Used by |
|---|---|---|
| `bot_detected` | insights | bot check |
| `form_input_method` → typed / autofilled / pasted | insights | input method, typing checks |
| `form_input_kpm`, `form_input_wpm` | insights | superhuman typing, synthetic typing |
| `seconds_on_page` | insights | session duration |
| `age_seconds` (age at claim) | insights | stale certificate |
| `os`, `is_mobile`, `approx_ip_geo` | insights | automation environment |
| `page_url` | insights | page mismatch |
| `verify.result.success` | verify | consent |
| scan `found` / `not_found` | insights scans | consent |

Exactly these **nine Insights properties** are requested — TrustedForm bills
per property returned, so nothing unscored is asked for (since 2026-10-17;
`is_framed`, browser, IP, domain, `created_at` and `expires_at` were dropped).
Verify's `language_approved`, `one_to_one` and `opt_in_types_satisfied` come
back with the verify result and are stored but not scored.

### From the request body (Lead Prosper)

| Field | Required | Effect |
|---|---|---|
| Certificate URL — any of `certificate_url`, `trustedform_cert_url`, `trustedform_cert`, `trustedform_url`, `xxTrustedFormCertUrl`, `xxTrustedFormToken` (bare 40-hex), `tf_cert_url`, `tf_cert` | yes | Missing → HTTP 400 |
| `lp_lead_id`, `email`, `phone` | recommended | Identify the lead for reuse detection |
| `landing_page_url` | optional | Enables page-mismatch check; inert without it |
| `consent_terms` | optional | Comma-separated phrases this campaign's disclosure must contain; replaces the default core terms for pass/fail |
| `advertiser_name` | optional | Passed to TrustedForm verify for the one-to-one result; omitted if absent |

**Currently sent by Lead Prosper** (since 2026-10-17): `lp_lead_id`,
`trustedform_cert_url`, `email`, `phone`, `landing_page_url`, `first_name`,
`last_name`, `state`, `valid_phone`. The name, state and `valid_phone` fields
are not scored yet; they feed the lead-data checks being built in shadow
(see [VERIFICATION_PLAN.md](VERIFICATION_PLAN.md)).

---

## 4. How the score is built

Every lead starts at **50** (neutral: absence of evidence pulls toward
"inconclusive", never toward "reject"). Each detector adds or subtracts. The
total is rounded and clamped to 0–100.

### Positive evidence

| Detector | Condition | Points |
|---|---|---|
| `bot_check` | TrustedForm bot check passed | +8 |
| `input_method` | Any typing observed (mixed typing + autofill counts) | +14 |
| `session_duration` | 30–59 s | +5 |
| `session_duration` | 60 s → 180 s, linear ramp | +8 → +16 |
| `consent_language` | TrustedForm verify succeeded | +10 |

**Maximum possible score: 98** (50 + 8 + 14 + 16 + 10).

### Negative evidence

| Detector | Flag | Condition | Points | Forces review |
|---|---|---|---|---|
| `bot_check` | `bot_detected` | TrustedForm flagged a bot | −45 | via class |
| `input_method` | `no_typing_observed` | Form filled with no typing | −25 | via class |
| `input_method` | `pasted_input` | Any field pasted | −10 | |
| `superhuman_typing` | `superhuman_typing_speed` | Typed and kpm > 600 | −15 | |
| `synthetic_typing` | `synthetic_typing` | Typed but kpm = 0, or wpm > kpm | −40 | **yes** |
| `automation_environment` | `automation_environment` | Desktop Linux and IP geolocates to a country only | −15 | |
| `session_duration` | `instant_submission` | < 5 s | −30 | |
| `session_duration` | `brief_session` | 5–14 s | −12 | |
| `consent_language` | `consent_language_missing` | Required phrasing absent from page | −15 | |
| `stale_certificate` | `stale_certificate` | Certificate > 30 min old at claim | −15 | |
| `certificate_reuse` | `certificate_reused` | Certificate already claimed for a different lead | −30 | **yes** |
| `certificate_page_mismatch` | `certificate_page_mismatch` | Certificate site ≠ lead's landing page | −20 | **yes** |

Sessions of 15–29 s score 0. Unknown values (null) never score — "we asked and
got nothing" is not evidence either way.

### Why each threshold is where it is

All thresholds come from the Oct 8–16 2026 baseline: 64 certificates, 59 from
our own form (solarenergynerds.com) and 5 from a partner page.

| Check | Real traffic (own form) | Bad traffic | Threshold |
|---|---|---|---|
| Superhuman typing | 38–280 keys/min | 361, 438, 1,572, 9,652 | 600 — above a 100 wpm typist (~500) |
| Synthetic typing | kpm always > 0; wpm/kpm 0.06–0.95 | AI agent: kpm 0, wpm 2,070 | Physically impossible values only |
| Stale certificate | 2–13 s, ≤ 348 s on delayed posts | 53 min, 22 h | 30 min — 5× the oldest legitimate |
| Automation environment | 0 of 64 desktop Linux; all IPs resolve to a state | AI agent: both | Requires both together |
| Consent missing (−15) | — | — | Best possible behaviour (73) falls out of STRONG_REAL_HUMAN but stays approved |

---

## 5. Consent verdict

Assessed once per lead, in this order:

1. **VERIFIED** — TrustedForm verify returned `success: true`. Requires the
   disclosure to be approved in ActiveProspect's **Consent Language Manager**.
2. **MISSING_LANGUAGE** — the page scan did not find one or more required
   terms. Required terms are the campaign's `consent_terms` if sent, otherwise
   `prior express written consent` and `automatic telephone dialing system`.
   Only required terms count; the scan also checks diagnostic extras
   (`autodialed`, `Do Not Call`, …) that never fail a lead.
3. **NOT_EVALUATED** — neither of the above. Neutral, 0 points.

`vs_consent_detected` is `true` only for VERIFIED.

One-to-one consent (`one_to_one`) is not used: our disclosure names several
sellers by design, and the FCC one-to-one rule was vacated in January 2025.

---

## 6. Classification

Evaluated top to bottom; the first match wins.

| # | Condition | `vs_classification` |
|---|---|---|
| 1 | No authenticity signals at all | `INCONCLUSIVE` |
| 2 | TrustedForm flagged a bot | `BOT_OR_SCRIPT` |
| 3 | Input methods reported, no typing | `AUTOFILL_OR_HIGH_RISK_AUTOMATION` |
| 4 | Fewer than 2 signals | `INCONCLUSIVE` |
| 5 | Score ≥ 80 | `STRONG_REAL_HUMAN` |
| 6 | Score 62–79 | `REAL_HUMAN` |
| 7 | Score ≤ 38 | `AUTOFILL_OR_HIGH_RISK_AUTOMATION` |
| 8 | Score 39–61 | `LEAD_FARM_HUMAN_TYPER` |

"Signals" are TrustedForm's three authenticity signals: bot check, input
method, session duration (`vs_meaningful_event_count` reports how many were
present, 0–3).

### Confidence (`vs_confidence`)

Confidence is breadth of evidence, not size of score.

- `INCONCLUSIVE` → low
- 3 signals → high; 2 → medium; fewer → low
- Bot flag **and** typing observed (signals disagree) → high drops to medium

---

## 7. Status and actions

| Classification | `vs_status` | `vs_recommended_action` |
|---|---|---|
| `STRONG_REAL_HUMAN`, `REAL_HUMAN` | `approved` — or `review` if any finding forces review | `accept` / `review` |
| `LEAD_FARM_HUMAN_TYPER`, `INCONCLUSIVE` | `review` | `review` |
| `BOT_OR_SCRIPT`, `AUTOFILL_OR_HIGH_RISK_AUTOMATION` | `reject` | `reject` |

- `vs_pass` = status is not `reject`.
- `vs_return_eligible` = high confidence **and** `BOT_OR_SCRIPT` or
  `AUTOFILL_OR_HIGH_RISK_AUTOMATION`. Consent gaps and integrity failures are
  deliberately not return grounds on their own.

---

## 8. Response fields (`POST /api/leadprosper/pre-ping`)

All values are flat scalars so they map onto Lead Prosper custom fields.

| Field | Meaning |
|---|---|
| `vs_pass` | `false` only when status is `reject` (or analysis unavailable) |
| `vs_score` | 0–100 canonical score |
| `vs_score_1_10` | `ceil(score / 10)`, minimum 1 — a presentation of `vs_score`, not a second model |
| `vs_status` | `approved` / `review` / `reject` |
| `vs_confidence` | `high` / `medium` / `low` |
| `vs_classification` | §6 |
| `vs_recommended_action` | `accept` / `review` / `reject` |
| `vs_return_eligible` | §7 |
| `vs_certificate_id` | TrustedForm certificate id (from the response, else the URL) |
| `vs_consent_detected` | Consent verdict is VERIFIED |
| `vs_session_seconds` | Seconds on page, 0 if unknown |
| `vs_meaningful_event_count` | Authenticity signals available, 0–3 |
| `vs_risk_flags` | Comma-separated flags from §4 |
| `vs_reason` | One plain-English sentence per finding, in registry order |
| `vs_analysis_id` | Stored analysis id — the join key for outcomes |
| `vs_model_version` | Model that produced this response |

---

## 9. When the engine cannot score

| Situation | Response |
|---|---|
| No certificate field in the request | HTTP 400 |
| Bad API key | HTTP 401 |
| Invalid certificate URL, TrustedForm error or timeout | HTTP 200: `vs_pass false`, `vs_status review`, `vs_score 0`, `vs_classification INCONCLUSIVE`, `vs_risk_flags analysis_unavailable`, reason in `vs_reason` |
| Certificate cached before features were stored | Same inconclusive shape; re-claim with `force=true` to rescore |

---

## 10. Detectors, shadow mode and versions

Each check is a detector in `src/detectors/` with an id, family, status and
one-sentence description. The registry (`src/detectors/registry.ts`) is the
complete list of what runs.

- **`active`** detectors move the score, flags and review decision.
- **`shadow`** detectors run on every lead but change nothing. Their findings
  are returned in `shadow_findings` and logged as `"shadow detector findings"`
  with the analysis id and live score. No detector is in shadow today.

Any change to a weight, threshold or detector status bumps `MODEL_VERSION`.
Promotion rules and the monthly bot run are in [BOT_LAB.md](BOT_LAB.md).

| Version | Date | Change |
|---|---|---|
| 0.1-beta | — | Legacy: 100-and-deduct model over the certificate event log |
| 0.2-insights | Oct 2026 | Neutral 50 baseline over TrustedForm insights; consent reported, not scored |
| 0.3-insights | 2026-10-13 | Session ramp; consent scored; certificate id fallback; reuse and page-mismatch checks |
| 0.4-insights | 2026-10-16 | Superhuman typing, stale certificate, synthetic typing, automation environment |
| (refactor) | 2026-10-16 | Detectors, shadow mode, bot lab. No scoring change — 490 snapshot cases identical |
| (consistency) | 2026-10-17 | Generic endpoints, stored status, routing, Sheets and webhooks moved onto this model. No scoring change |

---

## 11. Observed performance

Baseline Oct 8–16 2026, 64 certificates, replayed under 0.4:

| Source | Leads | Scores | Notes |
|---|---|---|---|
| Own form | 59 | 57–98 | 0 automation flags. 24 of 59 (41%) at the 98 ceiling |
| Partner (survey.solar-advisors.org) | 5 | 40–66 | All missing core TCPA phrasing; 3 also stale or superhuman, and those 3 go to review; the other 2 (62, 66) are still approved |
| Confirmed AI agent (ChatGPT agent) | 1 | 98 → 43 | Passed TrustedForm's bot check; caught by synthetic typing and environment |

---

## 12. Known limitations

Stated plainly so nobody oversells the engine.

1. **Weights are not yet calibrated against outcomes.** They are set from the
   baseline and the documented meaning of each signal. The outcome feed started
   2026-10-16; see [OPERATIONS.md §5](OPERATIONS.md#5-outcomes-and-calibration).
2. **The top of the scale is crowded.** 41% of own-form baseline leads hit 98. Telling a
   good 98 from a great 98 needs outcomes, not more guessed weights.
3. **The human baseline is narrow:** mostly Facebook traffic on phones, one
   form. A new traffic source (desktop, a new partner, another vertical) should
   be replayed through the bot lab before it is trusted.
4. **No lead-data checks.** The engine never sees name, address or phone
   content, so it cannot catch a government-building address or a phone area
   code from another state.
5. **AI agents that drive a real desktop with real keystrokes** would defeat
   synthetic typing. Network and plausibility checks (roadmap phase 3) and a
   first-party behaviour sensor (phase 4) are the answer.
6. **Pasted-text endpoints cannot use this model.** `/score-lead/from-text` and
   `/score-and-route/from-text` receive no TrustedForm insights, so they still
   run the retired event-log model and label every response and stored row
   `model_version: "legacy-event-log"`. Every certificate-based endpoint, the
   stored `status`, Google Sheets rows and outbound webhooks use this model
   (since 2026-10-17; rows stored earlier carry the legacy status).
7. **The name, state and phone fields are stored with the request.** When the
   lead-data checks are built they should keep only their result (for example
   "placeholder name: yes"), not the raw values.

---

## What not to publish

Reports and collateral say **what** was caught and **why it matters** ("text
was entered with zero keystrokes — a person cannot type without pressing
keys"). They never list thresholds, point values or which signals are combined.
That is a recipe for getting past the engine.
