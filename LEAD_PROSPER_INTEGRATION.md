> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Lead Prosper Integration Source

## Purpose

This document summarizes how Verified Submissions should use the Lead Prosper public API as an integration source.

Lead Prosper should be treated as the lead-routing and ping/post platform. Verified Submissions should remain the behavioral authenticity scoring layer.

The goal is not to rebuild Lead Prosper. The goal is to:

1. Pull lead context from Lead Prosper when needed.
2. Analyze the TrustedForm certificate with Verified Submissions.
3. Return or store a score that can support accept, reject, downweight, or manual review decisions.
4. Use Lead Prosper debug and return workflows when a lead needs investigation or dispute handling.

Official reference:

```txt
https://support.leadprosper.io/article/258-lead-prosper-analytics-api-cheat-sheet
```

---

## Authentication

Lead Prosper uses bearer token authentication.

```http
Authorization: Bearer YOUR_TOKEN
```

Recommended environment variable:

```env
LEADPROSPER_API_TOKEN=
```

Do not commit the token to GitHub.

---

## API Limit

Lead Prosper states that the public API is limited to 100 requests per minute.

Implementation note:

- Add basic request throttling before production use.
- Cache campaign metadata when possible.
- Do not run unnecessary debug-log calls on every lead.

---

## Important Endpoints

| Use Case | Method | Endpoint |
|---|---:|---|
| Campaign analytics | GET | `https://api.leadprosper.io/public/stats` |
| Supplier analytics | GET | `https://api.leadprosper.io/public/stats/supplier` |
| Single lead details | GET | `https://api.leadprosper.io/public/lead/{lead_ID}` |
| Multiple lead details | GET | `https://api.leadprosper.io/public/leads` |
| All campaign details | GET | `https://api.leadprosper.io/public/campaigns` |
| Single campaign details | GET | `https://api.leadprosper.io/public/campaigns/{campaign_ID}` |
| Pause buyer | GET | `https://api.leadprosper.io/public/campaigns/{campaign_ID}/pause_buyer/{buyer_ID}` |
| Resume buyer | GET | `https://api.leadprosper.io/public/campaigns/{campaign_ID}/resume_buyer/{buyer_ID}` |
| Return single lead | POST | `https://api.leadprosper.io/public/lead/return` |
| Lead debug log | POST | `https://api.leadprosper.io/public/leads/debug` |

---

## Recommended MVP Integration

### Phase 1: Read-Only Context

Start with read-only Lead Prosper access.

Use:

```http
GET /public/lead/{lead_ID}
```

Pull:

- Lead status
- Campaign ID
- Supplier
- Buyer outcomes
- Cost and revenue
- Lead fields
- TrustedForm certificate URL
- Lead Prosper ping ID, if present

This lets Verified Submissions analyze the certificate and associate the result with the Lead Prosper lead ID.

---

## Verified Submissions Flow with Lead Prosper

```txt
Lead Prosper lead ID
  -> Pull Lead Prosper lead details
  -> Extract trustedform_cert_url from lead_data
  -> Call TrustedForm API
  -> Extract behavioral signals
  -> Run Verified Submissions scoring engine
  -> Store analysis in Supabase
  -> Return score and recommended action
```

---

## Internal Endpoint: Analyze Lead Prosper Lead

This is a recommended internal endpoint for your own app.

```http
POST /integrations/leadprosper/analyze
```

### Request

```json
{
  "lp_lead_id": "Oi_PE5UB8JeApcHI06lG"
}
```

### Internal Steps

1. Validate the internal API key.
2. Call Lead Prosper single lead details endpoint.
3. Read `lead_data.trustedform_cert_url`.
4. Call the TrustedForm event log API.
5. Extract features.
6. Score the lead.
7. Save the result in Supabase with `lp_lead_id`.
8. Return the Verified Submissions result.

### Response

```json
{
  "lp_lead_id": "Oi_PE5UB8JeApcHI06lG",
  "trustedform_cert_url": "https://cert.trustedform.com/example",
  "lead_score": 6,
  "classification": "Lead Farm Human Typer",
  "confidence": "Medium",
  "recommended_action": "manual_review",
  "leadprosper": {
    "campaign_id": 21626,
    "campaign_name": "Solar Exchange",
    "lead_status": "ACCEPTED",
    "returned": false
  }
}
```

---

## Lead Details Endpoint

```http
GET https://api.leadprosper.io/public/lead/{lead_ID}
```

Use this when you already know the Lead Prosper lead ID.

Useful returned data includes:

- `id`
- `status`
- `error_code`
- `error_message`
- `cost`
- `revenue`
- `campaign_id`
- `campaign_name`
- `returned`
- `return_reason`
- `lead_data`
- `supplier`
- `buyers`

Important field for Verified Submissions:

```json
{
  "lead_data": {
    "trustedform_cert_url": "https://cert.trustedform.com/example"
  }
}
```

---

## Multiple Lead Details Endpoint

```http
GET https://api.leadprosper.io/public/leads
```

Use this for batch review, audits, or backtesting.

Common query parameters:

| Parameter | Purpose |
|---|---|
| `start_date` | Start date or datetime. |
| `end_date` | End date or datetime. |
| `campaign` | Campaign ID. |
| `timezone` | Timezone for date range. |
| `status` | Filter by accepted, error, or duplicated. |
| `supplier` | Filter by supplier ID. |
| `field_name` and `field_value` | Search by lead field value. |
| `search_after` | Pagination cursor. |

Implementation note:

- The Lead Prosper documentation states results are limited to 100 at a time.
- Use `search_after` for pagination.
- For backtesting, process leads in batches and respect rate limits.

---

## Lead Debug Log Endpoint

```http
POST https://api.leadprosper.io/public/leads/debug
```

Use this for investigation, not for every normal scoring request.

### Request

```json
{
  "lead_ids": ["8gP4X54B8G-3h53ltvcR"]
}
```

Best uses:

- Diagnose why a buyer accepted, skipped, errored, or was outbid.
- Review ping/post request and response data.
- Support disputes and compliance audits.
- Build forensic reports for enterprise clients.

Implementation notes:

- Lead Prosper supports up to 5 lead IDs per debug-log request.
- Debug logs are not available for leads older than 90 days.
- HTTP buyer ping/post payloads can include raw request and response strings.
- Treat debug logs as sensitive data.

---

## Return Single Lead Endpoint

```http
POST https://api.leadprosper.io/public/lead/return
```

Use only after a business rule or human review decides a lead should be returned.

### Request

```json
{
  "lead_id": "OnwQrpoB8JeApcHIOlC3",
  "reason": "Behavioral authenticity failed"
}
```

Optional:

```json
{
  "portal_refund": true
}
```

Recommended return reasons for Verified Submissions:

| Scenario | Suggested Reason |
|---|---|
| Score 1-2 | `Automated behavior detected` |
| Score 3 | `High-risk automation pattern` |
| Conflicting data after review | `Behavioral authenticity inconclusive` |
| TrustedForm unavailable | `Certificate event log unavailable` |

Do not auto-return leads in the MVP until you have tested the scoring model with real samples.

---

## Campaign Details Endpoint

```http
GET https://api.leadprosper.io/public/campaigns
```

Use this to map campaigns, suppliers, buyers, campaign fields, and caps.

Useful for:

- Building campaign-specific scoring thresholds
- Creating buyer-level routing rules later
- Mapping campaign IDs to verticals
- Understanding which campaigns are direct post, ping/post exchange, or one-to-one

---

## Pause and Resume Buyer Endpoints

Pause buyer:

```http
GET https://api.leadprosper.io/public/campaigns/{campaign_ID}/pause_buyer/{buyer_ID}
```

Resume buyer:

```http
GET https://api.leadprosper.io/public/campaigns/{campaign_ID}/resume_buyer/{buyer_ID}
```

Use these carefully.

Recommended use:

- Admin-only controls
- Manual operations
- Emergency fraud response
- Never triggered automatically from one low-scoring lead

---

## Recommended Database Additions

Add these columns to `analyses` if Lead Prosper integration is enabled:

```sql
alter table analyses
  add column if not exists lp_lead_id text,
  add column if not exists lp_campaign_id text,
  add column if not exists lp_supplier_id text,
  add column if not exists lp_status text,
  add column if not exists lp_returned boolean;
```

Optional table for audit/debug operations:

```sql
create table if not exists leadprosper_debug_logs (
  id uuid primary key default gen_random_uuid(),
  lp_lead_id text not null,
  debug_payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table leadprosper_debug_logs enable row level security;
```

---

## Recommended Service File

```txt
src/services/leadprosper.ts
```

Suggested functions:

```ts
getLeadProsperLead(lpLeadId: string)
listLeadProsperLeads(params)
getLeadProsperCampaigns()
getLeadProsperDebugLogs(leadIds: string[])
returnLeadProsperLead(leadId: string, reason: string)
```

---

## Example TypeScript Service Skeleton

```ts
const LEADPROSPER_BASE_URL = "https://api.leadprosper.io/public";

function getLeadProsperHeaders() {
  const token = process.env.LEADPROSPER_API_TOKEN;

  if (!token) {
    throw new Error("Missing LEADPROSPER_API_TOKEN");
  }

  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

export async function getLeadProsperLead(lpLeadId: string) {
  const response = await fetch(`${LEADPROSPER_BASE_URL}/lead/${lpLeadId}`, {
    method: "GET",
    headers: getLeadProsperHeaders()
  });

  if (!response.ok) {
    throw new Error(`Lead Prosper lead lookup failed: ${response.status}`);
  }

  return response.json();
}

export async function returnLeadProsperLead(leadId: string, reason: string) {
  const response = await fetch(`${LEADPROSPER_BASE_URL}/lead/return`, {
    method: "POST",
    headers: getLeadProsperHeaders(),
    body: JSON.stringify({
      lead_id: leadId,
      reason
    })
  });

  if (!response.ok) {
    throw new Error(`Lead Prosper return failed: ${response.status}`);
  }

  return response.json();
}
```

---

## MVP Recommendation

For the first integration, only build:

1. `getLeadProsperLead(lpLeadId)`
2. Extract `trustedform_cert_url`
3. Analyze through Verified Submissions
4. Store `lp_lead_id` on the analysis
5. Return the score

Do not build automatic return, pause-buyer, or buyer-routing actions until the scoring model is validated on real data.
