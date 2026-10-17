> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Scoring Model Tuning Plan (Event-Log First)

**Status:** Plan for review. No code yet.
**Scope:** Separate from the Lead Prosper adapter. Suggested branch `matt/scoring-tuning`, kept out of the adapter PR.
**Context:** Verified Submissions is a multi-tenant SaaS for many lead buyers. **Not every client has TrustedForm Insights.** Therefore the scoring foundation must work from the **base certificate event log alone.** Insights is an optional enhancement layer, never a dependency.

---

## 1. Core principle

The base model scores **behavior, read from event-type patterns in the certificate event log.** The heart of it is **how each field was filled:**

- **Typed (human):** the field's value is built up incrementally across events — `'a' → 'an' → 'ann' → ...` — often with backspaces/corrections.
- **Pasted / autofilled (suspicious):** the field jumps from empty to its full final value in a single event, with no incremental buildup preceding it.
- **Pre-populated / injected (suspicious):** the field has a final value but little or no interaction events at all.
- **Typed + autocomplete (human):** incremental typing of a partial value, then a single jump to a formatted full value (e.g., Google address autocomplete). Counts as human because real keystrokes preceded the jump.

This single distinction is what the current engine gets wrong, and fixing it is the centerpiece of this plan.

---

## 2. What's wrong today (recap, grounded in the code)

- **P1 — typing is penalized.** `calculate_session_metrics` counts every `changed value to '...'` keystroke as a separate edit; `REPEATED_FIELD_EDIT_THRESHOLD = 8` is below a normal email's length, so genuine typing trips `input_instability` and blocks positive adjustments. The engine counts keystrokes instead of reading the fill *pattern*.
- **P2 — consent is brittle.** Consent is detected only by the literal `consent language detected` event; a real (SMS-verified) lead without that line takes a −50 → reject.
- **P3 — resize noise.** Heyflow templates fire hundreds of `resized the window` events; threshold 10 trips `excessive_resize` on legitimate leads.
- **Vertical mismatch.** The engine scores B2B fields (`business_name`, an `employee_count` slider, `missing_employee_count` deduction). Your leads are **solar/homeowner** — those fields don't exist on the funnels, so the engine penalizes leads on data they never collect.
- **Multi-tenant gap.** `FIELD_OVERRIDES` is hardcoded to one client's form field IDs. A SaaS serving many forms can't rely on hardcoded IDs.

---

## 3. The fill-method engine (new core)

Replace the keystroke-counting logic with a per-field **fill-method classifier** derived from the ordered event stream.

For each field, walk its value-change events in order and label it:

```
typed                -> >=2 incremental changes where each value extends the previous
                        (growing prefix), optionally with backspaces/corrections.
typed_with_autocomplete -> incremental typing followed by a single jump to a longer
                        formatted value (address autocomplete). Treated as human.
pasted               -> empty -> full value in ONE change event, no prior keystrokes
                        on that field.
prepopulated         -> field has a value in the final field_map but no change events.
unknown              -> ambiguous / insufficient events.
```

**Aggregate into a session-level signal:**
- `typed_field_ratio` = typed (incl. autocomplete) key fields ÷ all key contact fields (email, phone, name, address).
- High ratio → human. Low ratio (mostly pasted/prepopulated) → autofill/bot.

This `typed_field_ratio` becomes a **primary score driver and the primary classification input**, replacing `input_instability` as a fraud signal.

> Keep a *true* instability signal only for genuinely erratic editing (many delete-and-retype cycles well beyond normal correction) — not normal typing.

---

## 4. The four base signals (confirmed in scope)

1. **Fill method** (§3) — primary. Typed vs pasted vs prepopulated.
2. **Session timing & duration** — total `session_seconds` plus per-field entry timing. Full form completed in a couple seconds *with* pasted fields = strong bot signal; realistic, *variable* per-field timing = human. Timing is scored **in combination with** fill method, not alone.
3. **Interaction depth** — count of **distinct field interactions and navigation events** before submit (not raw keystroke count, so a typed field and a pasted field aren't rewarded by length). Very shallow interaction = suspicious.
4. **Consent & opt-in** — detect from **any** of: `consent language detected`, `opted in on [checkbox]`, or a phone/SMS verification step. See §6.

---

## 5. Solar / homeowner field set (multi-tenant)

- **Remove** B2B logic: `employee_count` slider scoring, `business_name` inference, `missing_employee_count` deduction.
- **Score completeness on solar-relevant fields:** name, phone, email, address (and homeowner/utility fields if a given funnel collects them).
- **Make the field set and field→role mapping configurable per client/vertical** rather than hardcoded IDs. Options to decide (see §9): a per-client config map, semantic inference from values (current heuristic path, generalized), or a hybrid. This is required for SaaS multi-tenancy.

---

## 6. Consent logic (revised, compliance-sensitive)

Consent evidence = **any** of:
- `consent language detected` event (current), or
- `opted in on [checkbox-...]` event (TCPA checkbox), or
- a completed phone/SMS verification step, or
- (optional, when available) Insights `scans` confirming opt-in language on the page.

**Open compliance decision (§9):** should *behaviorally real but consent-event-absent* leads be a hard reject, or a smaller deduction + `review`? Current −50 hard-rejects them. Recommend softening to a flag/review unless you have a compliance reason to hard-reject, since consent capture **varies by funnel**.

---

## 7. Classification from the event log (no Insights required)

```
real_human       -> high typed_field_ratio, realistic & variable timing,
                    corrections present, consent/opt-in seen. status approved.
autofill         -> key fields pasted/prepopulated (low typed_ratio), short session,
                    minimal corrections, but fields ARE populated.
bot_script       -> near-zero interaction, fields prepopulated/injected, ultra-short
                    session, no typing, often missing submission.
lead_farm_human  -> genuinely typed (human hands) BUT suspicious: very fast/uniform,
                    suspicious email, repetitive patterns. status review.
inconclusive     -> sparse/partial log, parse failure, conflicting signals, or the
                    adapter's timeout fail-open path.
```

`vs_confidence` reflects **signal strength and data completeness** — a clean, fully-typed, consented session is high; sparse logs are low.

---

## 8. Insights as an optional layer (only when the client has it)

Pluggable enhancer; **absent → the base score stands unchanged.** When present, it corroborates and sharpens:

| Insights field | Use |
|---|---|
| `bot_detected` | Strong override toward reject / `bot_script`. |
| `form_input_method` (`type`/`paste`/`autofill`/`pre-populated`) | Authoritative corroboration of §3 fill-method. |
| `form_input_kpm` / `form_input_wpm` | Validate typing; high KPM + ~0 WPM = paste/bot. |
| `scans` (opt-in language) | Corroborate consent (§6). |
| `seconds_on_page`, `age_seconds` | Engagement + lead freshness. |
| `approx_ip_geo`, `ip` | Fraud + state matching for solar. |
| `bot_detected`, `is_framed`, `num_sensitive_*` | Additional risk flags. |

Design as a separate module that raises confidence (and can force-reject on `bot_detected`) — so base and premium clients run the same pipeline with this step skipped when unavailable. Could map to a paid tier later (§9).

> Note: Insights/Certificate API is **v4.0** (`api-version: 4.0` header, product objects). API access ends when the cert's retain window expires (3 or 90 days); retaining does **not** extend API access.

---

## 9. Decisions (resolved)

1. **Consent — RESOLVED.** When no consent evidence appears but behavior is clearly human: **route to `review` with a `missing_consent` flag (not a silent reject).** Provide a **per-client strict toggle** that escalates this to hard-reject for clients with strict TCPA requirements. Default = review.
2. **Field mapping — RESOLVED.** **Hybrid:** semantic value-pattern inference works out-of-the-box; clients with unusual forms can supply an optional per-client override map. No mandatory per-client setup to onboard.
3. **Confidence — RESOLVED.** **Base tier can reach `high`.** A strong typed + consented event-log session earns high confidence on its own; Insights adds certainty but is not required for high.
4. **Lead-farm — RESOLVED.** **Review / downweight.** Genuinely-typed but low-quality-source humans pass through as `review` with a flag and a lowered score; the buyer's filters decide. Not auto-rejected.

---

## 10. Data needed to validate thresholds

The logic above is structural; the *numbers* (weights, ratios, timing cutoffs) need labeled real data to confirm:

1. **Bad-lead event logs you can label** — bots, autofills, and especially **disputed/refunded/returned** leads. 3–5+ would calibrate the reject end.
2. **More good leads across each funnel/template** you run (field IDs differ per funnel).
3. **Your accept / review / reject / return definitions** in plain English (the ground truth).
4. **Lead economics** — price per lead and dispute/return cost — to set how conservative to be.

---

## 11. Build order (when approved)

1. Implement the per-field fill-method classifier (§3) + `typed_field_ratio`.
2. Replace `input_instability` deduction with fill-method-based scoring (fixes P1).
3. Broaden consent detection (§6) and soften the deduction per the §9 decision (fixes P2).
4. Neutralize resize noise (fixes P3).
5. Swap B2B field logic for the configurable solar field set (§5).
6. Re-derive classification from fill-method (§7).
7. Add the optional Insights enhancer module (§8), no-op when absent.
8. Calibrate thresholds against the labeled data (§10); add regression tests using the real samples as fixtures (redacted).

---

## 12. Relationship to the adapter

The Lead Prosper adapter ships independently and already discounts the noisy flags in its classifier, so it is **not blocked** by this work. This tuning makes the underlying score correct and defensible before going public to buyers. Keep the two as separate PRs.
