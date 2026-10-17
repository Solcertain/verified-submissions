> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Lead Integrity & Compliance Engine — Overview

## What It Is

This app evaluates the quality, authenticity, and compliance of inbound leads using data from **TrustedForm** (by ActiveProspect). It scores each lead on a 0–100 scale, flags risks, decides what to do with the lead (approve / review / reject), routes results to the right destination automatically, and stores every result in a database for later retrieval.

It is designed for lead buyers, compliance teams, and operations staff who need to verify that leads were submitted legitimately before acting on them.

---

## Two Modes of Input

| Mode | When to Use |
|---|---|
| **Live Certificate** | Production use. Paste the TrustedForm certificate URL from a real form submission. The app claims the cert and retrieves full behavioral session data. |
| **Event Log** | Testing and QA. Paste the raw event log text directly. No live claim is made — good for scoring leads without consuming a certificate claim. |

---

## User Experience & Flow

### Page 1 — Lead Check Form

The user lands on a dark-themed form with two tabs:

**Live Certificate tab:**
- User pastes a TrustedForm URL (e.g. `https://cert.trustedform.com/abc123...`)
- The app automatically strips any browser-appended path like `/assets/#certificate`, normalizing to the bare cert URL
- If this certificate has been processed before, the **stored result is returned immediately** — no cert claim is consumed
- Append `?force=true` to the request to bypass the cache and reprocess from scratch

**Event Log tab:**
- User pastes raw TrustedForm event log text
- Optionally includes the cert URL as a reference
- Always creates a fresh database record — text input is not a stable identifier, so no deduplication applies

After submitting, the app shows a "Analyzing Lead..." loading state then navigates to the results page.

---

### Page 2 — Evaluation Results

Results are displayed in an animated two-column layout:

**Left column:**
- Animated **Score Ring** (0–100, color-coded green / amber / red)
- Final Status badge: APPROVED / REVIEW / REJECT
- Confidence level badge
- System Routing card — the decision made and where the lead was sent

**Right column:**
- **Contact Profile** — extracted name, email, phone, address, business name, company size, lead source
- **Compliance Panel** — consent confirmed/missing, certificate ID, session start time, form submission time
- **Risks & Findings** — all triggered risk flags in plain English, plus score explanation bullets
- **Session Activity Metrics** — session duration (seconds), interaction count, repeat edits, resize events, slider moves
- **Integrations Status** — Google Sheets append result and webhook delivery status (shown only when triggered)
- **Raw Output** — collapsible developer panel with the full JSON response

Users can copy the full JSON payload to clipboard or click "New Check" to start over.

---

## Backend Pipeline

What happens on every submission, in order:

```
 1. Validate & normalize the URL (strip browser-added paths like /assets/#certificate)
 2. Check Postgres for an existing result → return immediately if cached
 3. Claim the TrustedForm certificate via API (Live Certificate mode only)
 4. Parse the certificate event log into structured fields
 5. Infer field roles (map field IDs to email, phone, name, address, etc.)
 6. Score the lead across 6 dimensions
 7. Route the lead based on score outcome
 8. Append to Google Sheets (review leads only, if configured)
 9. Fire outbound webhook (if configured)
10. Save full result to Postgres
11. Return structured JSON response
```

---

## Scoring System

Every lead starts at **100 points**. Points are deducted for problems found, and small bonuses are added for clean behavioral signals.

### Deductions

| Category | Trigger | Points Lost |
|---|---|---|
| **Consent / Compliance** | No consent language detected | −50 |
| | Form was never submitted | −40 |
| | Certificate ID is missing | −20 |
| **Field Completeness** | No email found | −20 |
| | No phone found | −20 |
| | No name found | −10 |
| | No address found | −10 |
| **Data Quality** | Invalid email format | −25 |
| | Suspicious / disposable email | −10 |
| | Invalid phone format | −10 |
| | Employee count missing | −5 |
| **Session Speed** | Form completed in under 5 seconds | −35 |
| | Form completed in under 10 seconds | −20 |
| | Fewer than 3 meaningful interactions | −25 |
| **Behavior** | Unstable / erratic field inputs | −10 |
| | Erratic slider behavior | −10 |
| | Excessive window resizing | −5 |
| | Non-progress clicks | −5 |

### Bonuses

| Signal | Points Added |
|---|---|
| Clean, sequential form progression | +5 |
| Stable, deliberate field inputs | +5 |
| Strong contact info with consent present | +5 |

### Score Thresholds

| Score | Status | Meaning |
|---|---|---|
| 85–100 | **Approved** | High quality, ready to act on |
| 60–84 | **Review** | Borderline — needs a human look |
| 0–59 | **Reject** | Poor quality or compliance failure |

---

## Routing Logic

Based on the score outcome, leads are automatically routed:

| Outcome | Action |
|---|---|
| **Approved** | Forwarded to your CRM via webhook (`CRM_WEBHOOK_URL`); held for manual action if no CRM is configured |
| **Review** | Appended as a new row to your Google Sheets review queue |
| **Reject** | Logged internally; optionally notifies via outbound webhook (`NOTIFY_WEBHOOK_URL`) |

---

## Persistence

Every successfully processed submission is saved to a PostgreSQL table called `lead_submissions`:

| Field | Purpose |
|---|---|
| `id` | Unique UUID per record |
| `received_at` | When the API received the request |
| `certificate_url` | The normalized TrustedForm URL — used as the deduplication key |
| `certificate_id` | The certificate hash extracted from the event log |
| `raw_payload_json` | The original request body sent to the API |
| `trustedform_raw_json` | The raw response from TrustedForm's claim API |
| `parsed_submission_json` | The normalized lead data (name, email, phone, etc.) |
| `score_json` | Full scoring output (value, status, confidence, flags, explanations) |
| `status` | approved / review / reject |
| `processed_at` | Timestamp when scoring completed |

**Cache behavior:** If a certificate URL has been seen before, the stored result is returned without re-claiming the cert (live certs are single-use). Pass `?force=true` to bypass the cache and reprocess.

---

## Configuration Reference

All integrations are configured via environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `ACTIVEPROSPECT_API_KEY` | Yes | TrustedForm API key for certificate claims |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | No | Sheet ID from your Google Sheets URL — enables review lead append |
| `GOOGLE_SHEET_NAME` | No | Tab name to append to (default: "Lead Review Queue") |
| `CRM_WEBHOOK_URL` | No | Webhook destination for approved leads (Zapier, n8n, HubSpot, etc.) |
| `OUTBOUND_WEBHOOK_URL` | No | General outbound webhook for all scored leads |
| `OUTBOUND_WEBHOOK_ENABLED` | No | Set to `true` to enable outbound webhooks |
| `NOTIFY_WEBHOOK_URL` | No | Webhook to notify when a lead is rejected |

Google Sheets uses Replit's built-in Google OAuth connection — no service account key or manual credentials needed.

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/score-and-route` | Full pipeline: claim cert → score → route → persist |
| `POST` | `/api/score-and-route/from-text` | Same pipeline from pasted event log text |
| `POST` | `/api/score-lead` | Score only (no routing or persistence) |
| `POST` | `/api/score-lead/from-text` | Score from pasted text only |
| `GET` | `/api/health` | Health check |

All endpoints return structured JSON. A `cached: true` flag is included in the response when a stored result is returned without reprocessing.
