# Operations Guide

How the scoring engine is deployed, wired into Lead Prosper, fed with
outcomes, and run day to day. For how a score is calculated, see
[SCORING_MODEL.md](SCORING_MODEL.md).

Last verified: 2026-10-17.

---

## 1. System map

```
Consumer ──► solarenergynerds.com/form-step  (TrustedForm script, tagged consent)
                │
                ▼
         Lead Prosper campaign 23668 "Solar Campaign #1"
                │ pre-ping (data append)
                ▼
   POST /api/leadprosper/pre-ping ──► TrustedForm v4 claim (insights + verify + scans)
                │                            │
                │ vs_* fields                ▼
                ▼                      Neon Postgres: lead_submissions
         Lead Prosper routes / sells
                │ campaign triggers
                ▼
   POST /api/leadprosper/outcome/<token> ──► Neon Postgres: lead_outcomes
```

| Component | Where |
|---|---|
| Repository | `Solcertain/verified-submissions` (upstream `jwelle/verified-submissions`) |
| Service | `artifacts/api-server` — Express 5, TypeScript, esbuild bundle |
| Hosting | Vercel project `verified-submissions-api` |
| Production URL | `https://verified-submissions-api.vercel.app` |
| Database | Neon Postgres (`DATABASE_URL`) |
| Custom domain | `api.verifiedsubmissions.com` — **does not resolve**; do not give it to partners |

---

## 2. Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/healthz` | none | Liveness: `{"status":"ok"}` |
| `POST /api/leadprosper/pre-ping` | `x-api-key` | **The production scoring endpoint.** Returns flat `vs_*` fields |
| `POST /api/leadprosper/outcome/:token` | secret path token | Records what happened to a lead |
| `POST /api/score-and-route` | `x-api-key` | Generic claim + score + routing (Sheets, webhooks). Supports `?force=true` to re-claim. Used by the bot lab to capture fixtures |
| `POST /api/score-lead` | `x-api-key` | Claim + score, no routing or storage |
| `GET /api/cron/sync-returns` | `Authorization: Bearer <CRON_SECRET>` or `x-api-key` | Pulls returned leads from Lead Prosper into `lead_outcomes`. Runs daily via Vercel Cron |
| `POST /api/score-and-route/from-text`, `/score-lead/from-text` | `x-api-key` | **Deprecated.** Pasted event text; legacy event-log model only, labelled `legacy-event-log` |

Every certificate-based endpoint uses the model in SCORING_MODEL.md and reaches
the same decision for the same lead; the legacy event-log score is kept
alongside in `score_json.legacy` for comparison.

### Authentication

- `x-api-key` is compared in constant time against `INTERNAL_API_KEY`. **If
  `INTERNAL_API_KEY` is unset, protected endpoints fail open** (log a warning
  and allow the request). Production has it set.
- The outcome endpoint uses a separate secret, `LP_CALLBACK_TOKEN`, in the URL
  path. That was chosen when triggers were believed to expose only a URL; the
  HTTP action does have a Headers field, so the token could move to a header
  later (a URL secret can appear in logs). It **fails closed**: unset token → 503; wrong token → 401. It grants nothing but
  appending an outcome row. Rotating it does not affect scoring.

---

## 3. Environment variables

| Variable | Required | Used for |
|---|---|---|
| `ACTIVEPROSPECT_API_KEY` | yes | TrustedForm claims (Basic auth) |
| `INTERNAL_API_KEY` | yes | `x-api-key` on scoring endpoints |
| `LP_CALLBACK_TOKEN` | yes | Outcome endpoint path secret |
| `DATABASE_URL` | yes | Neon Postgres |
| `LP_API_KEY` | for returns | Lead Prosper public API key (Bearer), used by the returns sync |
| `CRON_SECRET` | for returns | Vercel sends it as `Authorization: Bearer` on cron calls; without it the daily sync is rejected |
| `LP_RETURNS_CAMPAIGNS` | no | Comma-separated campaign ids to sync returns for; default `23668` |
| `GOOGLE_SHEETS_ENABLED`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEET_NAME` | no | Legacy review-row export |
| `OUTBOUND_WEBHOOK_ENABLED`, `OUTBOUND_WEBHOOK_URL`, `CRM_WEBHOOK_URL`, `NOTIFY_WEBHOOK_URL` | no | Legacy routing |
| `LOG_LEVEL` | no | pino log level |

Set them in Vercel project settings. `.env.local` in `artifacts/api-server` is a
local copy for development and must never be committed.

---

## 4. Lead Prosper configuration (campaign 23668)

### 4.1 Pre-ping (scoring)

The campaign calls `POST /api/leadprosper/pre-ping` with the `x-api-key` header
and maps the returned `vs_*` fields into same-named custom fields.

Body sent (since 2026-10-17, configured in the campaign's **Data Append**
section):

```json
{
    "lp_lead_id": "{{lp_lead_id}}",
    "trustedform_cert_url": "{{trustedform_cert_url}}",
    "email": "{{email}}",
    "phone": "{{phone}}",
    "landing_page_url": "{{landing_page_url}}",
    "first_name": "{{first_name}}",
    "last_name": "{{last_name}}",
    "state": "{{state}}",
    "valid_phone": "{{valid_phone}}"
}
```

Verified on the first live lead (2026-10-17 12:38): every field filled, and
`valid_phone` populated — Lead Prosper's phone validation runs before this
append. `landing_page_url` switches on the page-mismatch check. Saving the
append without its response mappings pauses it, so never remove those.

Optional per campaign: `consent_terms` (comma-separated required phrasing, for
a campaign whose disclosure is worded differently from the solar one) and
`advertiser_name`.

### 4.2 Outcome triggers

Lead Prosper trigger conditions offer only **Any Status, Accepted, Duplicated
and Error** — there is no "Returned". So outcomes use two triggers with a
hardcoded label each, and returns are pulled from the Lead Prosper API.

| Trigger | Id | Condition | Body |
|---|---|---|---|
| Verified Submission Sold | 13720 | Lead Status = Accepted | see below |
| Verified Submission Unsold | 16001 | Lead Status = Error | see below |

Both: HTTP POST, JSON, URL
`https://verified-submissions-api.vercel.app/api/leadprosper/outcome/<LP_CALLBACK_TOKEN>`.

Sold body:

```json
{
    "lp_lead_id": "{{lp_lead_id}}",
    "trustedform_cert_url": "{{trustedform_cert_url}}",
    "status": "sold",
    "buyer": "{{lp_buyer_name}}",
    "sell_price": "{{lp_lead_sell_price}}",
    "vs_analysis_id": "{{vs_analysis_id}}",
    "vs_score": "{{vs_score}}",
    "vs_model_version": "{{vs_model_version}}"
}
```

Unsold body: the same with `"status": "unsold"`, `"return_reason":
"{{lp_lead_error_message}}"`, and no `buyer` / `sell_price`.

Send only these fields. The endpoint stores the whole body, so a body that
includes name, email, phone or address puts personal data into
`lead_outcomes.raw_payload_json` for no benefit.

**Status 2026-10-17:** Unsold is correct and delivering. **Sold is sending Lead
Prosper's default 60-field payload** — no `status`, `lp_lead_id`, buyer or
price, and full personal data. Its rows link to the analysis (via the
certificate URL) but carry no outcome label. Fix: replace the Sold body with the
one above.

To check a trigger: open a lead under **Leads → Triggers Log**; a 200 from
`verified-submissions-api.vercel.app` means it delivered.

### 4.3 ActiveProspect

The Solar Energy Nerds disclosure (`TCPA_TEXT` in
`sen-site/form-app/src/steps/Submit.jsx`) must be in TrustedForm's **Consent
Language Manager**. Without it, verify fails on every lead and no lead can earn
the consent points. **If the disclosure wording changes, update the Consent
Language Manager the same day.**

---

## 5. Outcomes and calibration

### What each outcome can teach

| Label | Source | Use |
|---|---|---|
| Sold | Sold trigger | Weak positive: a buyer accepted it |
| Unsold — no buyers available | Unsold trigger | **None for authenticity.** Coverage, not quality |
| Unsold — rejected by filter | Unsold trigger | None for authenticity |
| Returned + reason | Returns sync (pull, daily) | **The key negative label** when the reason is wrong number, fake, didn't request |
| Buyer disposition (contacted, wrong number, credit fail …) | Not yet collected | Strongest labels; credit fail etc. feed lead quality, never authenticity |
| Bot lab agents | Captured fixtures | Guaranteed negatives, on demand |

### Returns sync

`GET /api/cron/sync-returns` runs daily at 10:00 UTC (`vercel.json`). It reads
the last 21 days of leads for each campaign in `LP_RETURNS_CAMPAIGNS`, keeps the
returned ones, and records each once as `outcome: "returned"` with the returning
buyer, price and reason. Re-running is safe: a lead already recorded as returned
is skipped. Run it by hand with `GET /api/cron/sync-returns?days=60` and the
`x-api-key` header.

Each return reason is sorted into a category (stored as
`raw_payload_json.return_category`):

| Category | Example reasons | Bears on verification |
|---|---|---|
| `fraud` | fake, bot, made-up details | yes |
| `contact_invalid` | wrong number, disconnected, bad email | yes |
| `consent_dispute` | never filled out a form, didn't request, DNC | yes |
| `duplicate` | duplicate lead from Sept 28th | no |
| `lead_quality` | credit, renter, not interested, out of area | no — real people |
| `other` | anything unrecognised | review by hand |

Only the first three are negative labels for calibration. The categories are
keyword rules in `src/services/leadprosper_returns.ts`, tuned on the 33 real
returns from Aug 18 – Oct 17 2026 (each is a test case). Every sync re-applies
the current rules to returns already stored, so improving a rule fixes old rows
on the next run. Read the `other` bucket periodically and add rules for
reasons it misses.

First backfill (2026-10-17, 60 days, 33 returns): about two thirds were
territory, ZIP, utility or property fit; 4 duplicates; 6 bore on verification
(2 fake identities, 3 bad or wrong phone numbers, 1 opt-out). Only 1 of the 33
was linked to a scored lead, because almost all predate the scorer.

### Do we need more data?

Yes, but the bottleneck is **negative labels**, not lead volume. Our own form
produces almost entirely real humans, so more of the same traffic mostly adds
more confirmed-good leads. What calibrates the engine is confirmed-bad leads,
and those come from:

1. **Returns with reasons** — pulled from Lead Prosper.
2. **The bot lab** — each monthly run adds labeled agents immediately.
3. **Different traffic** — partner and desktop leads, where the engine's
   judgement actually matters.
4. **Buyer dispositions**, once a buyer agrees to send them.

Working target before re-weighting: roughly **50 confirmed-bad and several
hundred confirmed-good leads**, with the bad ones spread across more than one
source. Until then, threshold changes come from the bot lab and the human
baseline, not from outcome statistics.

### Tables

`lead_submissions` — one row per claimed certificate: `certificate_url`,
`certificate_id`, `raw_payload_json` (request body), `trustedform_raw_json`
(full claim response), `parsed_submission_json` (`{ legacy, features }` —
features are what the model scores), `score_json` (current-model result with
`model_version`, plus the legacy score under `legacy`) and `status`,
`received_at`, `processed_at`. Rows written before 2026-10-17 hold the legacy
model's score and status.

`lead_outcomes` — one row per outcome (trigger callback or returns sync): `lp_lead_id`,
`certificate_url`, `outcome`, `buyer`, `sell_price`, `return_reason`,
`supplier`, `raw_payload_json`, `analysis_id` (linked by normalised certificate
URL when found; no foreign key, so outcomes for unscored leads are kept).
Consumer details (name, email, phone, address, IP and similar) are stripped
from `raw_payload_json` before storing, whatever the trigger sends.

---

## 6. Deploying

- **Push to `main` deploys production** automatically (Vercel Git
  integration). `claude/mvp-completion` is kept at the same commit as `main`.
- Before pushing: `npx vitest run` in `artifacts/api-server`. The bot lab runs
  as part of it; a red agent or human test blocks the change.
- After a deploy: Vercel shows the deployment `READY`, `GET /api/healthz`
  returns ok, and the next lead in Lead Prosper shows the new
  `vs_model_version`.
- **Rollback:** promote the previous production deployment in the Vercel
  dashboard (Deployments → previous → Promote). No database migration is
  involved in any model change.

### Local development notes

- `routes.test.ts` and `node build.mjs` need the `pg` package, which is not
  installed in the local checkout; both work on Vercel. All other tests run
  locally. To run `routes.test.ts` locally without reinstalling, point a vitest
  config's `resolve.alias.pg` at any installed copy of `pg`.
- Line-ending warnings (LF → CRLF) on commit are harmless.

---

## 7. Routine tasks

| Task | How |
|---|---|
| Add or change a check | Write it in `src/detectors/`, start in `shadow`, follow [BOT_LAB.md](BOT_LAB.md), bump `MODEL_VERSION` on promotion |
| Change a weight or threshold | `src/config/authenticity_rules.ts` only; replay the human baseline (bot lab tests) and bump `MODEL_VERSION` |
| Monthly bot run | [BOT_LAB.md](BOT_LAB.md) |
| Refresh the human baseline | Quarterly; export recent own-form features, anonymise (remove IP and postal code), replace the file in `fixtures/botlab/humans/` |
| Rotate `LP_CALLBACK_TOKEN` | Generate a new value, set it in Vercel, redeploy, then update the URL on **both** outcome triggers |
| Investigate a lead | Find it in Lead Prosper; `vs_analysis_id` is the `lead_submissions.id` with its stored features and full TrustedForm response |
| Report on a lead | Verdict and score; the signals that mattered, each with one line on why it matters; comparison with the real-traffic baseline; what the engine caught or missed |

---

## 8. Open items

| Item | Owner | Blocks |
|---|---|---|
| Replace the Sold trigger body (§4.2) | Lead Prosper admin | Sold labels |
| Set `LP_API_KEY` and `CRON_SECRET` in Vercel | Ops | Returns sync |
| Lead-data and network checks (roadmap phase 3) | Engineering + Lead Prosper fields + IP-intelligence service | Catching invented people |
| First-party behaviour sensor on our forms (phase 4) | Engineering + form repo | Agents with real keystrokes |
| Fix or remove `api.verifiedsubmissions.com` | Ops | Partner-facing URL |
