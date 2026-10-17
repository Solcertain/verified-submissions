# Verification Plan — working, verified engine by 2026-10-28

Goal: by Tuesday 2026-10-28 the engine is not just running but **shown to
work** — every claim below backed by data a prospect could be shown.

Started 2026-10-17. Status column is updated as items close.

---

## Acceptance criteria

The engine counts as verified when all of these hold:

| # | Criterion | How it is measured | Status 10-17 |
|---|---|---|---|
| A1 | Every lead on campaign 23668 is scored | Leads in Lead Prosper with `vs_model_version` vs all leads | live since 10-13 |
| A2 | Every lead's fate is recorded | Sold, unsold and returned outcomes arriving, linked to the score | sold ✅ unsold ✅ returns ✅ (daily sync) |
| A3 | One model everywhere | Pre-ping, generic endpoints, stored status agree (tested) | ✅ |
| A4 | No real human flagged as automation | Human baseline in the bot lab; refreshed with Oct 17–27 traffic | ✅ on 59; refresh pending |
| A5 | Every captured bot stopped | Bot lab agents | 1 of 1; target ≥ 3 agents |
| A6 | Verification returns are caught or explained | Each fraud / bad-contact / consent return: caught, or the missing signal named | 1 of 6 caught; 5 need lead-data checks (below) |
| A7 | Calibration readout | Return rate by score band, from linked outcomes | needs ~10 days of linked outcomes |
| A8 | Documentation matches the code | SCORING_MODEL.md, OPERATIONS.md, BOT_LAB.md re-verified | ✅ 10-17 |

---

## What the return backtest showed (2026-10-17)

The six returns that bear on verification (Aug 18 – Sep 15) were re-claimed
and scored under 0.4. Certificate age is excluded below: it is an artefact of
claiming weeks later, not a signal about the lead.

| Return reason | Fair score | Caught? | Why / what was missing |
|---|---|---|---|
| Fake name, non-working email and phone | 51 | **Yes** — review | Typing at 3,630 keys/min |
| Not a real person, name "First Last" | 73 | No | Placeholder name — the engine never sees the name |
| Not a working phone number | 71 | No | Phone validity — not sent to the engine |
| Number belongs to a gym | 68 | No | Phone line type / owner — not sent |
| Wrong number and email | 73 | No | Phone and email validity — not sent |
| Opted out of communications | 73 | No | Consent withdrawn after the sale; not detectable at intake |

All six also lacked the required TCPA phrasing — correctly: the compliant
disclosure was only added to the form on 2026-10-05.

**Conclusion:** behaviour was human on 5 of 6. What gave them away was the
lead's own data, so the highest-value next checks are on that data: names,
phone validity and line type, area code against state.

---

## Schedule

| When | Work | Owner |
|---|---|---|
| Oct 17 | Returns sync live, backfill, categories tuned; one model everywhere; Sold trigger fixed | done |
| Oct 17–20 | Remove personal data from the 13 early Sold-trigger rows | Engineering, needs permission |
| Oct 17 | Add `landing_page_url`, `first_name`, `last_name`, `state`, `valid_phone` to the pre-ping body — **done**, verified on a live lead; page-mismatch check active | done |
| Oct 20–22 | Lead-data detectors in **shadow**: placeholder / junk names, invalid phone (`valid_phone`), low phone activity, phone area code vs state | Engineering |
| Oct 20–24 | Bot lab run 1 on a **test copy** of the form: ChatGPT agent, one open-source agent, Claude computer use | Engineering + test form |
| Oct 22–27 | Shadow findings reviewed against live traffic; promote what is clean | Engineering |
| Oct 27 | Refresh human baseline with Oct 17–27 own-form traffic | Engineering |
| Oct 28 | Verification report: criteria A1–A8 with numbers | Engineering |

### Why lead-data checks enter in shadow

The human baseline contains no lead fields, so there is no false-positive
evidence for them yet. Shadow mode measures them on real traffic first; a
check is promoted only if it stays quiet on real customers.

---

## Risks

- **Volume.** About 20–45 own-form leads a day and few verification returns —
  A7 will be directional on Oct 28, not statistically settled.
- **`valid_phone` is not yet trustworthy.** In 89 recent leads it was `False`
  on 19, yet 14 of those sold — mostly scoring 90+ — and none was returned; the
  one return in the sample had `valid_phone = True`. It may flag VoIP or
  landlines rather than dead numbers. It enters as a shadow signal only, and
  `phone_activity_score` is never populated, so it is not used at all. A real
  line-type / reachability lookup may be needed for the phone checks.
- **Lead Prosper field timing.** `valid_phone` must be computed before the
  pre-ping runs; if Lead Prosper validates after, the check has to read it from
  the outcome instead.
- **Bot lab needs a test form.** Running agents against the live form would
  create real, sellable leads.
