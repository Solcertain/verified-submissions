# Verified Submissions — MVP Status

Repository audit against the behavioral-authenticity MVP defined in the 8-8 prompts.
Audit date: 2026-10-05. Branch: `claude/mvp-completion`. Base: `Solcertain/verified-submissions`.

---

## Which spec is authoritative

There are **two generations of spec in this repo** and the code implements the older one.

| Spec | What it is | Status |
|---|---|---|
| `attached_assets/Verified_Submission_Master_Prompt_1774489519472.md` (931 lines) | Original Replit brief. Pass 1 = scoring backend; Pass 2 = Google Sheets routing, outbound webhooks, thin review UI. | **History.** Explains the Sheets/webhook/UI code and the lead-completeness scoring. Not a requirement. |
| `Verified Submission Prompts 8-8` | Narrower product: behavioral authenticity only. Explicitly excludes lead intent, conversion probability, buyer fit, sales quality. | **Authoritative.** |

Consequence: several things that look like defects are faithful implementations of the retired
spec. Do not "fix" code toward the master prompt by accident.

---

## Current architecture

pnpm workspace monorepo, Node 24, TypeScript 5.9, Express 5, Drizzle ORM over Postgres, esbuild
bundle. Deploys to Vercel from `artifacts/api-server` — its `vercel.json` sets the build command and
rewrites all routes to `app.js`, which re-exports `dist/index.mjs`. The Vercel project's **Root
Directory must be `artifacts/api-server`**, or neither file is read.

```
artifacts/api-server/src/
  routes/        health · lead_scoring · score_and_route · leadprosper
  services/      trustedform_client · event_parser · field_inference · scoring_engine
                 routing_engine · score_and_route_service · leadprosper_adapter
                 leadprosper_flat_fields · submission_store · google_sheets · webhook_dispatcher
  config/        scoring_rules.ts        (all tunable constants)
  middlewares/   api_key.ts
lib/db/          Drizzle schema (lead_submissions) + migrations + migrate.mjs
```

Module boundaries are clean and route handlers are thin — `routes/leadprosper.ts` normalizes,
delegates to `scoreAndRouteLead()`, maps to flat fields, returns. Preserve this.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/healthz` | Liveness |
| `POST /api/score-lead` | Claim a live cert and score it |
| `POST /api/score-lead/from-text` | Score from a raw event-log string (QA; no claim consumed) |
| `POST /api/leadprosper/pre-ping` | Lead Prosper adapter — returns the 16 flat `vs_*` fields |

---

## Working components

- **API surface and transport.** All four routes registered and responding.
- **TrustedForm certificate claim** via Basic Auth, with URL normalization that strips
  browser-appended paths (`/assets/#certificate`, query strings) down to the bare 40-char cert ID.
- **Certificate dedupe cache.** Unique index on `certificate_url`; a repeat cert returns the stored
  analysis instead of consuming another claim. `?force=true` bypasses.
- **Flat `vs_*` contract.** All 16 field names match the spec exactly, and all 16 already exist as
  custom fields on Lead Prosper campaign 23668 alongside `trustedform_cert_url`. **This part is
  done** — do not recreate them.
- **Persistence.** `lead_submissions` stores `trustedform_raw_json`, which is what makes shadow-mode
  data collection useful for later calibration.
- **Auth middleware** exists (`x-api-key` vs `INTERNAL_API_KEY`).
- **Tests.** 24 passing (adapter, flat fields, routes).
- **Graceful failure.** A failed claim returns HTTP 200 with `vs_classification: "inconclusive"` and
  `vs_pass: false` rather than erroring, so Lead Prosper can branch on fields rather than status.

---

## Incomplete components

### The engine is coupled to a retired form — the headline finding

The live form at `solarenergynerds.com/form-step/` serves the **React** app
(`/form-app/assets/index-DXfSJRjk.js`). The Heyflow variant is retired. But three modules are
calibrated to Heyflow:

| Location | Coupling | Effect on live traffic |
|---|---|---|
| `services/field_inference.ts` | 6 hardcoded field IDs — `input-041bc24c`, `input-10bf0565`, `input-13c9ba29`, `input-6417e977`, `input-a4ad7fac`, `slider-5c5a48ae` | **All six come from one Heyflow certificate** (`attached_assets/verified_submission_event_1774489519467.md`). Never match; every lead falls back to heuristics. |
| `services/event_parser.ts:37` | `NOISE_PATTERNS` includes a `clicked on [unnamed heyflow` pattern | Heyflow-specific noise filtering is dead. |
| `services/scoring_engine.ts:139` | A `heyflow-wrapper` regex gates the non-progress-click signal | `non_progress_clicking` **can never fire** on React-form traffic. |

The single committed certificate sample is therefore a **format** reference, not a calibration
dataset. Real certificates from the current form are the prerequisite for all engine work.

### Scoring measures the wrong thing

`config/scoring_rules.ts` starts at `BASE_SCORE = 100` and **deducts**. Bands: `APPROVED_MIN = 85`,
`REVIEW_MIN = 60`. Deductions include `MISSING_EMAIL` (20), `MISSING_PHONE` (20), `MISSING_NAME`
(10), `MISSING_ADDRESS` (10), `MISSING_EMPLOYEE_COUNT` (5), `SUSPICIOUS_EMAIL` (10) — these measure
**form completeness and contact quality**, which the authoritative spec explicitly excludes.

Genuinely behavioral signals present: `UNDER_5_SECONDS`, `UNDER_10_SECONDS`, `LOW_INTERACTION`,
`INPUT_INSTABILITY`, `ERRATIC_SLIDER`, `EXCESSIVE_RESIZE`, `NON_PROGRESS_CLICKS` (dead, see above).

### `unknown` is not distinguishable from `false`

`event_parser.ts` declares `consent_detected: boolean`, initialized `false` at line 52. So "no
consent event in the log" and "no log was parsed at all" are the same value. The deduct-from-100
model compounds this: absent data produces a penalty, so missing evidence reads as bad evidence.
The spec is explicit that this must not happen.

---

## Missing MVP components

1. **TrustedForm Insights.** No integration anywhere — zero matches for `insights` or `bot_detected`
   across `artifacts/` and `lib/`. The claim path only. The sole existing Insights implementation in
   this codebase family is `api/analyze.js` in the sibling checkout
   (`7_Projects/verified-submissions-api/verified-submissions`); read it before rebuilding.
2. **~7 of 12 required behavioral features.** The parser emits only
   `certificate_created`, `consent_detected`, `field_changed`, `form_submitted`, `radio_selected`,
   `noise`, `other`, `unknown`. There are no keystroke, backspace, mouse, scroll, or focus event
   types, so these spec features cannot currently be derived at all:
   `keystrokes_present`, `backspaces`, `changed_value_only_fields`, mouse activity, scroll activity,
   linear navigation, instant/rapid field injection.
3. **Classification enum mismatch.** Code returns 5 lowercase values
   (`real_human`, `lead_farm_human`, `bot_script`, `autofill`, `inconclusive`,
   `leadprosper_flat_fields.ts:8-12`). Spec requires 6 uppercase including `STRONG_REAL_HUMAN`.
4. **Fixture tests for the 12 scoring scenarios.** Existing tests cover the adapter and routes, not
   extraction-vs-scoring separation.
5. **Typed normalized feature object.** Scoring reads parsed events directly; there is no
   feature-extraction boundary that can be tested independently.
6. **`docs/TRUSTEDFORM_FEATURE_MAP.md`** (Prompt 3 deliverable).

---

## Technical debt / risks

- **Fail-open auth.** `middlewares/api_key.ts` allows every request when `INTERNAL_API_KEY` is
  unset, logging only a warning. The predecessor deployment at
  `verified-submissions-api-server.vercel.app` is live in exactly this state: an unauthenticated
  `POST /api/leadprosper/pre-ping` returns **400, not 401**. Each such call with a real cert burns a
  metered ActiveProspect claim and writes a row. **Set the secret before any URL is reachable.**
- **Synchronous external call on production intake.** The claim runs inline on the Lead Prosper
  path for campaign 23668 (308 buyers, 37 active). Timeout was 15s; reduced to **5s** on this
  branch. A degraded ActiveProspect still adds latency to every lead.
- **PII at rest.** `raw_payload_json` holds lead PII and `trustedform_raw_json` holds full session
  data. RLS is enabled on `lead_submissions` with no policies (denies all non-owner roles) and
  deliberately **not forced**, since the app connects as table owner over `DATABASE_URL`.
- **Two deployments, two repos.** The Replit app (`verified-submissions.replit.app`) and the
  predecessor Vercel project are both still live. Retire both to avoid debugging the wrong one.
- **Local builds do not work on Windows.** `pnpm-workspace.yaml` strips all non-Linux native
  binaries, so vitest and esbuild fail. Never commit an un-stripped workspace file. For a local
  typecheck run `./node_modules/.bin/tsc --build` directly; going through pnpm triggers a
  `node_modules` purge that needs a TTY.
- **Dead code from the retired spec.** `google_sheets.ts` and `webhook_dispatcher.ts` implement
  master-prompt Pass 2. Gate off, do not delete until the product decision is confirmed.

---

## Recommended MVP architecture

Keep the existing module layout. Insert one new boundary the spec requires and the code lacks:

```
trustedform_client ─┐
                    ├─► event_parser ─► feature_extractor ─► scoring_engine ─► routing_engine
insights_client ────┘                   (NEW: typed,          (pure, no I/O)
                                         unknown-aware)
                                              │
                      leadprosper_flat_fields ┘─► routes/leadprosper.ts
```

- `feature_extractor` returns a typed object where every signal is `true | false | unknown`.
- `scoring_engine` stays pure and independently testable with no network, DB, or clock dependency.
- All tunable weights stay in `config/scoring_rules.ts` so calibration never touches logic.
- Form-specific field maps move out of code into a keyed registry, so a form change is data.

---

## Implementation plan

### P0 — required for a working MVP
1. Set `INTERNAL_API_KEY`; verify unauthenticated POST returns **401**. *(done on the new deployment)*
2. Provision the database and apply migrations. *(done — Neon; `0001_lead_submissions.sql` applied; RLS verified)*
3. Set `ACTIVEPROSPECT_API_KEY` from Solcertain's own account.
4. Deploy, and wire campaign 23668 in **shadow mode** — map all 16 `vs_*` fields, create **no**
   filter rules.
5. **Capture real certificates from the React form.** Prerequisite for everything below.
6. Change the classification enum to the 6 uppercase values — **before** shadow data accumulates,
   since `vs_classification` is already live in Lead Prosper.
7. Re-derive the field-inference map from captured React-form certs; remove all three Heyflow
   couplings.
8. Introduce `feature_extractor` with `unknown` distinct from `false`; stop inferring `false` from
   absent data.
9. Add TrustedForm Insights including `bot_detected`.
10. Fixture tests for the 12 scenarios, extraction tested separately from scoring.

### P1 — before beta
11. Calibrate against captured certs; produce `docs/TRUSTEDFORM_FEATURE_MAP.md`; bump
    `vs_model_version` from `0.1-beta`.
12. Decide the lead-completeness deductions against real distributions.
13. Move form field maps into a keyed registry.
14. Confirm end-to-end latency against the ~2s target.
15. Retire the predecessor Vercel project and the Replit app.

### P2 — post-MVP
16. Enable Lead Prosper filters, starting with high-confidence automated rejects only.
17. Decide the fate of `google_sheets.ts` / `webhook_dispatcher.ts`.
18. Break out resale campaigns (28736 Value / 33556 Aged) as separate revenue lines.

---

## Definition of done

Objective pass/fail:

1. `GET /api/healthz` returns `{"status":"ok"}` on the Solcertain deployment.
2. Unauthenticated `POST /api/leadprosper/pre-ping` returns **401**.
3. A real React-form certificate returns all 16 `vs_*` fields populated.
4. The four edge cases in `LEADPROSPER_TESTING.md` §5 behave as documented, including no second
   claim on a duplicate cert.
5. Rows land in `lead_submissions` with non-null `trustedform_raw_json`.
6. A case-insensitive search for `heyflow` under `artifacts/api-server/src` returns **nothing**.
7. Every feature in the extractor can report `unknown`, and a missing event log yields `unknown`
   rather than `false` — covered by an explicit test.
8. `vs_classification` returns one of the 6 uppercase values.
9. Insights `bot_detected` is surfaced in the feature object.
10. All 12 fixture scenarios pass; scoring is deterministic across repeat runs at a fixed model
    version; no test touches a live API.
11. Typecheck, tests, and build are green on Linux/CI.
12. Campaign 23668 carries no filter referencing any `vs_*` field until calibration is signed off.
