> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Verified Submissions API Reference

## Purpose

Verified Submissions is a real-time behavioral classification API that analyzes TrustedForm event logs and related signals to determine whether a submitted lead appears to be authentic human behavior, autofill, lead farm activity, or automation.

This API is focused on behavioral authenticity only. It does not score lead intent, conversion likelihood, buyer fit, or sales quality.

---

## MVP Scope

The MVP should stay focused on one core flow:

1. Accept a TrustedForm certificate URL.
2. Pull the TrustedForm event log through the TrustedForm API.
3. Extract behavioral features.
4. Run the scoring engine.
5. Return a structured JSON result.
6. Log the analysis in the database.

No billing, customer dashboard, user accounts, or marketing site are required for the first working version.

---

## Base URL

```txt
https://api.verifiedsubmissions.com
```

For local development:

```txt
http://localhost:3000
```

---

## Authentication

Every request should include an internal API key.

### Header

```http
x-api-key: YOUR_INTERNAL_API_KEY
```

### Environment Variables

```env
INTERNAL_API_KEY=
TRUSTEDFORM_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
LEADPROSPER_API_TOKEN=
```

Never commit real API keys, database credentials, TrustedForm keys, Supabase service keys, or Lead Prosper tokens into the code repository.

---

## Endpoint: Analyze Lead

```http
POST /analyze
```

Analyzes one TrustedForm certificate and returns a behavioral authenticity score.

---

## Request Body

```json
{
  "trustedform_cert_url": "https://cert.trustedform.com/abc123",
  "email": "optional@email.com",
  "phone": "optional phone",
  "lp_lead_id": "optional Lead Prosper lead id"
}
```

### Request Fields

| Field | Type | Required | Description |
|---|---:|---:|---|
| `trustedform_cert_url` | string | Yes | Full TrustedForm certificate URL. |
| `email` | string | No | Optional lead email for matching and verification. |
| `phone` | string | No | Optional lead phone number for matching and verification. |
| `lp_lead_id` | string | No | Optional Lead Prosper lead ID for logging, debugging, or return workflows. |

---

## Successful Response

```json
{
  "model_version": "0.1-beta",
  "lead_score": 6,
  "classification": "Lead Farm Human Typer",
  "confidence": "Medium",
  "human_or_bot": "Likely Human",
  "recommended_action": "manual_review",
  "signals": {
    "keystrokes_present": true,
    "instant_injection": false,
    "backspaces": 2,
    "time_on_page": 38,
    "linear_flow_score": 0.7,
    "mouse_events_present": true,
    "scroll_events_present": false,
    "insights_bot_detected": false
  },
  "integrations": {
    "leadprosper": {
      "lp_lead_id": "optional",
      "suggested_action": "review_only"
    }
  }
}
```

---

## Response Fields

| Field | Type | Description |
|---|---:|---|
| `model_version` | string | Current scoring model version. |
| `lead_score` | number | Authenticity score from 1 to 10. |
| `classification` | string | Behavioral classification label. |
| `confidence` | string | `High`, `Medium`, or `Low`. |
| `human_or_bot` | string | Plain-language human vs automation result. |
| `recommended_action` | string | Suggested routing decision. |
| `signals` | object | Extracted behavioral signals used by the scoring engine. |
| `integrations` | object | Optional integration-specific output, such as Lead Prosper routing metadata. |

---

## Classification Labels

### Real Homeowner

Typical indicators:

- Keystroke sequences present
- Variable delays between fields
- Backspaces or corrections detected
- Some non-linear movement
- Realistic total session duration

### Lead Farm Human Typer

Typical indicators:

- Letter-by-letter typing
- Very clean entries
- No corrections
- Strictly linear navigation
- Very fast field transitions
- Repetitive pattern across certificates

### Bot / Script

Typical indicators:

- Instant value injection
- No keystrokes
- Minimal mouse movement
- Very short session duration
- Changed-value events only
- TrustedForm Insights `bot_detected` is true

### Autofill

Typical indicators:

- Multiple fields populate rapidly
- No keystroke sequences
- Browser-triggered changed-value behavior
- Sequential or simultaneous field fills

### Inconclusive

Typical indicators:

- Mixed signals
- Partial event log
- Insufficient behavioral data
- Conflicting automation and human signals

---

## Score Bands

| Score | Classification Band | Recommended Action |
|---:|---|---|
| 1-2 | Bot / Automated Script | Reject |
| 3-4 | Autofill or High-Risk Automation | Reject or route to lower payout |
| 5-6 | Lead Farm Human Typer / Inconclusive | Manual review or downweight |
| 7-8 | Real Human, Moderate Confidence | Accept |
| 9-10 | Strong Real Homeowner Pattern | Accept, premium tier |

Operational rule:

```txt
1-3 = Auto Reject
4-6 = Manual Review / Downweight
7-10 = Accept
```

---

## Feature Extraction Requirements

The feature extraction module should parse the TrustedForm event log and calculate normalized values from 0 to 1 where possible.

| Feature | Description |
|---|---|
| `keystrokes_present` | Whether real keystroke sequences appear. |
| `changed_value_only_fields` | Number of fields populated without keystrokes. |
| `backspaces` | Number of correction events. |
| `time_between_fields` | Timing gaps between field interactions. |
| `time_on_page` | Total session duration. |
| `mouse_events_present` | Whether mouse movement or clicks are present. |
| `scroll_events_present` | Whether scroll activity exists. |
| `linear_flow_score` | How strictly linear the form completion path appears. |
| `instant_injection` | Whether values appear to be injected instantly. |
| `insights_bot_detected` | TrustedForm Insights bot detection signal. |

---

## Scoring Engine

The scoring engine should live in a separate module.

Recommended function:

```ts
scoreLead(features): AnalysisResult
```

Example scoring impacts:

| Signal | Weight Impact |
|---|---:|
| No keystrokes | -3 |
| Instant multi-field injection | -3 |
| TrustedForm Insights `bot_detected = true` | -4 |
| Backspaces present | +2 |
| Non-linear navigation | +1 |
| Realistic time on page | +1 |
| Extremely fast linear typing | -1 |
| Repetitive pattern across certificates | -2 |

The scoring engine should be deterministic. The same certificate and same event data should return the same result.

---

## Error Responses

### Missing API Key

```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid API key"
}
```

### Missing Certificate URL

```json
{
  "error": "Bad Request",
  "message": "trustedform_cert_url is required"
}
```

### TrustedForm API Error

```json
{
  "error": "TrustedForm API Error",
  "message": "Unable to retrieve certificate event log"
}
```

### Analysis Failed

```json
{
  "error": "Analysis Failed",
  "message": "Unable to analyze behavioral signals"
}
```

---

## Database Logging

Table name:

```txt
analyses
```

Recommended schema:

| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key. |
| `cert_id` | text | TrustedForm certificate ID or URL. |
| `lp_lead_id` | text | Optional Lead Prosper lead ID. |
| `lead_score` | int | Final 1-10 score. |
| `classification` | text | Final classification label. |
| `confidence` | text | High, Medium, or Low. |
| `signals` | jsonb | Extracted feature breakdown. |
| `model_version` | text | Scoring engine version. |
| `created_at` | timestamp | Analysis creation time. |

---

## Supabase SQL

```sql
create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  cert_id text not null,
  lp_lead_id text,
  lead_score int not null check (lead_score between 1 and 10),
  classification text not null,
  confidence text not null,
  signals jsonb not null default '{}'::jsonb,
  model_version text not null,
  created_at timestamptz not null default now()
);

alter table analyses enable row level security;
```

For the MVP, do not expose this table directly to the browser. Write to it only through the backend using the Supabase service role key stored in environment variables.

---

## Security Requirements

- Keep the GitHub repository private.
- Do not store secrets in code.
- Use Vercel, Render, or Railway environment variables.
- Require an internal API key for the MVP API.
- Enable Supabase Row Level Security.
- Do not expose the Supabase service role key to frontend code.
- Keep Postman collections private.
- Add `.env` to `.gitignore`.
- Rotate keys after sharing temporary access with a developer.

---

## Suggested Folder Structure

```txt
verified-submissions/
  docs/
    API_REFERENCE.md
    LEAD_PROSPER_INTEGRATION.md
  src/
    index.ts
    routes/
      analyze.ts
    services/
      trustedform.ts
      leadprosper.ts
      supabase.ts
    scoring/
      extractFeatures.ts
      scoreLead.ts
      classifyLead.ts
    types/
      analysis.ts
  .env.example
  .gitignore
  package.json
```

---

## Definition of Done for MVP

The MVP is complete when:

- `POST /analyze` accepts a TrustedForm certificate URL.
- The backend pulls the event log.
- The backend extracts behavioral signals.
- The scoring engine returns a deterministic result.
- The result includes score, classification, confidence, recommended action, and feature breakdown.
- The analysis is logged in Supabase.
- The response returns in under 2 seconds for normal certificates.
- No secrets are committed to the repository.
