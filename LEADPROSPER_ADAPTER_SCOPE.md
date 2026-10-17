> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Verified Submissions Lead Prosper Adapter Scope and Build Plan

## Objective

Build the next production-focused layer for Verified Submissions so Lead Prosper can send a pre-ping lead payload to our backend, have the TrustedForm / ActiveProspect activity log analyzed, and receive flat `vs_*` response fields that Lead Prosper can store in custom fields and use for accept, reject, review, downweight, or return-eligible logic.

This is not a rebuild. The existing backend already has scoring and routing logic. The goal is to create a Lead Prosper adapter around the existing score-and-route pipeline.

---

## Product Goal

Verified Submissions should operate as a pre-ping behavioral verification middleware.

Target flow:

```txt
Lead enters Lead Prosper
  -> Lead Prosper sends payload to Verified Submissions
  -> Verified Submissions normalizes the payload
  -> Verified Submissions pulls or analyzes the TrustedForm certificate
  -> Existing scoring pipeline runs
  -> Verified Submissions returns flat vs_* fields
  -> Lead Prosper stores those fields
  -> Lead Prosper filters decide accept, reject, review, downweight, or return eligibility
  -> Verified Submissions logs the full analysis for reporting and evidence
```

The business goal is to help clients prevent bad leads before they are sold and later support evidence-backed lead returns.

---

## Current Repo Assumptions

The existing repo already includes:

```txt
artifacts/api-server
artifacts/lead-check
lib/db
lib/api-client-react
lib/api-zod
```

The backend already includes these routes:

```http
POST /api/score-lead
POST /api/score-lead/from-text
POST /api/score-and-route
POST /api/score-and-route/from-text
GET /api/healthz
```

The current best existing route for operational use is:

```http
POST /api/score-and-route
```

That route should remain available. Do not remove or break it.

---

## Main Build Target

Create a new dedicated Lead Prosper adapter endpoint:

```http
POST /api/leadprosper/pre-ping
```

This endpoint should accept Lead Prosper-style payloads, normalize the field names, call the existing scoring pipeline, and return flat `vs_*` fields.

---

## Important Architecture Rule

Do not make the new endpoint call `/api/score-and-route` over HTTP.

Instead, extract the core logic from `/api/score-and-route` into a shared service function, then call that function from both routes.

Desired architecture:

```txt
/api/score-and-route
  -> scoreAndRouteLead()

/api/leadprosper/pre-ping
  -> normalizeLeadProsperPayload()
  -> scoreAndRouteLead()
  -> mapToLeadProsperFlatFields()
```

Suggested file structure:

```txt
artifacts/api-server/src/
  routes/
    score_and_route.ts
    leadprosper.ts
  services/
    score_and_route_service.ts
    leadprosper_adapter.ts
    leadprosper_flat_fields.ts
```

Keep the exact repo naming convention if the existing project uses different file naming.

---

## Scope of Work

### 1. Audit Current Score-and-Route Code

Review the current implementation of:

```txt
artifacts/api-server/src/routes/score-and-route
artifacts/api-server/src/services/scoring_engine.ts
artifacts/api-server/src/services/routing_engine.ts
artifacts/api-server/src/services/event_parser.ts
artifacts/api-server/src/services/field_inference.ts
```

Find where the current route performs:

```txt
claim -> parse -> infer -> normalize -> score -> route -> store
```

Extract that reusable logic into a service function.

---

### 2. Create Shared Service Function

Create a reusable function similar to:

```ts
type ScoreAndRouteLeadInput = {
  certificate_url: string;
  raw_payload?: unknown;
  lead_context?: Record<string, unknown>;
  source?: "generic" | "leadprosper";
};

async function scoreAndRouteLead(input: ScoreAndRouteLeadInput) {
  // Reuse existing score-and-route pipeline
}
```

This function should return the same rich internal result currently returned by the existing route.

Do not change the existing scoring behavior unless required to make the adapter work.

---

### 3. Keep Existing Route Working

Refactor:

```http
POST /api/score-and-route
```

So it calls the new shared function.

The public behavior of `/api/score-and-route` should remain compatible with the existing frontend and generated API client.

---

### 4. Add Lead Prosper Route

Add:

```http
POST /api/leadprosper/pre-ping
```

This route should:

1. Validate the request.
2. Normalize possible Lead Prosper field names.
3. Extract the TrustedForm certificate URL.
4. Call `scoreAndRouteLead()`.
5. Map the internal result to flat `vs_*` fields.
6. Return the flat response synchronously.
7. Log the full raw request and flat response if storage is available.

---

## Lead Prosper Payload Normalization

The adapter should accept multiple possible names for the certificate URL, including:

```txt
certificate_url
trustedform_cert_url
trustedform_cert
trustedform_url
xxTrustedFormCertUrl
xxTrustedFormToken
tf_cert_url
tf_cert
```

Normalize them into:

```ts
certificate_url
```

The adapter should also preserve optional context fields if present:

```txt
lp_lead_id
lp_campaign_id
lp_supplier_id
lp_buyer_id
campaign_id
supplier_id
buyer_id
email
phone
first_name
last_name
address
zip
state
lead_source
vertical
```

The raw payload should be stored or passed through as `raw_payload`.

---

## Flat Response Contract

The Lead Prosper endpoint should return flat fields only.

Required first version:

```json
{
  "vs_pass": true,
  "vs_score": 87,
  "vs_score_1_10": 9,
  "vs_status": "approved",
  "vs_confidence": "high",
  "vs_classification": "real_human",
  "vs_recommended_action": "accept",
  "vs_return_eligible": false,
  "vs_certificate_id": "abc123",
  "vs_consent_detected": true,
  "vs_session_seconds": 42,
  "vs_meaningful_event_count": 18,
  "vs_risk_flags": "",
  "vs_reason": "Consent detected; valid contact info; stable input behavior.",
  "vs_analysis_id": "uuid-or-empty-if-not-available",
  "vs_model_version": "0.1-beta"
}
```

All fields should be safe for Lead Prosper custom fields.

Avoid deeply nested JSON in the Lead Prosper response.

---

## Flat Field Definitions

| Field | Type | Description |
|---|---:|---|
| `vs_pass` | boolean | True if Lead Prosper should allow the lead to continue. |
| `vs_score` | number | Main 0-100 operational score. |
| `vs_score_1_10` | number | Simplified Human Certainty Score for client display. |
| `vs_status` | string | `approved`, `review`, or `reject`. |
| `vs_confidence` | string | `high`, `medium`, or `low`. |
| `vs_classification` | string | `real_human`, `lead_farm_human`, `bot_script`, `autofill`, or `inconclusive`. |
| `vs_recommended_action` | string | `accept`, `reject`, `review`, `downweight`, or `return_eligible`. |
| `vs_return_eligible` | boolean | True only when the evidence is strong enough to support a return workflow later. |
| `vs_certificate_id` | string | Parsed TrustedForm certificate ID when available. |
| `vs_consent_detected` | boolean | Whether consent language was detected. |
| `vs_session_seconds` | number | Session duration from scoring metrics. |
| `vs_meaningful_event_count` | number | Count of meaningful behavioral events. |
| `vs_risk_flags` | string | Comma-separated risk flags. |
| `vs_reason` | string | Human-readable evidence summary. |
| `vs_analysis_id` | string | Internal database ID if available. |
| `vs_model_version` | string | Current model or scoring version. |

---

## Score Mapping

Keep the existing 0-100 score as the main operational score.

Also expose a 1-10 display score.

Recommended mapping:

```ts
function mapScoreToOneToTen(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return Math.max(1, Math.ceil(clamped / 10));
}
```

Decision bands:

| 0-100 Score | 1-10 Score | Status | Recommended Action |
|---:|---:|---|---|
| 0-39 | 1-4 | reject | reject or return eligible |
| 40-59 | 5-6 | review | review or downweight |
| 60-84 | 7-8 | approved or review | accept or cautious accept |
| 85-100 | 9-10 | approved | accept |

Note: Do not rely only on 1-10 for return evidence. The 0-100 score plus reason codes and classification should be the main return ammunition.

---

## Classification Mapping

The current repo may not have a formal classification field yet. Add a first-pass mapper based on score, status, risk flags, explanations, and available behavioral metrics.

Required classifications:

```txt
real_human
lead_farm_human
bot_script
autofill
inconclusive
```

Initial mapping logic can be conservative:

```txt
bot_script:
  status is reject
  and risk flags indicate very short session, low interaction, missing activity, no meaningful events, or automation-like behavior

autofill:
  rapid field population, low interaction, no meaningful typing indicators, but not enough evidence for bot_script

lead_farm_human:
  review status
  and behavior appears human but overly clean, fast, linear, repetitive, or suspicious

real_human:
  approved status
  meaningful activity present
  realistic session duration
  no major automation flags

inconclusive:
  missing certificate data
  partial event log
  conflicting signals
  parsing failure where a hard reject is not justified
```

Do not overstate classification confidence. Use `inconclusive` when signals are weak.

---

## Recommended Action Mapping

Use this first version:

```ts
if (status === "approved") {
  vs_pass = true;
  vs_recommended_action = "accept";
}

if (status === "review") {
  vs_pass = true;
  vs_recommended_action = "review";
}

if (status === "reject") {
  vs_pass = false;
  vs_recommended_action = "reject";
}
```

Return eligibility:

```ts
vs_return_eligible = (
  status === "reject" &&
  confidence === "high" &&
  classification is "bot_script" or "autofill"
);
```

Do not trigger actual Lead Prosper returns in this scope.

---

## Database and Logging

The current repo already has database storage through Postgres / Drizzle.

For this scope, log enough data to support debugging and future reporting:

```txt
raw Lead Prosper payload
normalized payload
certificate_url
certificate_id
score result
routing result
flat vs_* response
created_at
processed_at
```

If the current database schema already stores raw payload and score JSON, reuse it.

If a small schema change is needed, add optional Lead Prosper fields:

```txt
lp_lead_id
lp_campaign_id
lp_supplier_id
lp_buyer_id
source
flat_response_json
```

Do not block the adapter on a large reporting schema migration.

---

## Authentication

Protect the new endpoint using the same API key strategy as the existing backend.

Expected header:

```http
x-api-key: INTERNAL_API_KEY
```

Do not expose ActiveProspect, TrustedForm, database, or Lead Prosper API credentials to frontend code.

Do not commit secrets.

---

## Out of Scope for This Build

Do not build these yet:

```txt
Customer dashboard
Billing
Stripe
User accounts
Automatic Lead Prosper returns
Pause or resume buyer automation
Full supplier reporting dashboard
Manual review portal
Major scoring model rewrite
CRM delivery rebuild
Google Sheets rebuild
```

The only exception is small logging work needed to support the adapter.

---

## Testing Requirements

Add or update tests for:

1. Payload normalization.
2. Missing certificate URL error.
3. Multiple TrustedForm field name variants.
4. 0-100 to 1-10 score mapping.
5. Internal result to flat `vs_*` field mapping.
6. Classification mapping.
7. Recommended action mapping.
8. Return eligibility logic.
9. Existing `/api/score-and-route` route still works.
10. New `/api/leadprosper/pre-ping` route returns flat fields.

---

## Manual Test Example

Use a test request like:

```json
{
  "lp_lead_id": "test-lp-123",
  "lp_campaign_id": "solar-campaign-1",
  "lp_supplier_id": "publisher-22",
  "trustedform_cert_url": "https://cert.trustedform.com/example",
  "email": "test@example.com",
  "phone": "5555555555",
  "first_name": "Test",
  "last_name": "Lead"
}
```

Expected response shape:

```json
{
  "vs_pass": true,
  "vs_score": 87,
  "vs_score_1_10": 9,
  "vs_status": "approved",
  "vs_confidence": "high",
  "vs_classification": "real_human",
  "vs_recommended_action": "accept",
  "vs_return_eligible": false,
  "vs_certificate_id": "example",
  "vs_consent_detected": true,
  "vs_session_seconds": 42,
  "vs_meaningful_event_count": 18,
  "vs_risk_flags": "",
  "vs_reason": "Consent detected; valid contact info; stable input behavior.",
  "vs_analysis_id": "uuid-or-empty-if-not-available",
  "vs_model_version": "0.1-beta"
}
```

---

## Acceptance Criteria

This task is complete when:

1. `/api/leadprosper/pre-ping` exists.
2. It accepts Lead Prosper-style payloads.
3. It handles multiple possible TrustedForm certificate field names.
4. It reuses the existing score-and-route logic through a shared service function.
5. It does not make an internal HTTP call to `/api/score-and-route`.
6. It returns flat `vs_*` fields.
7. It exposes both `vs_score` and `vs_score_1_10`.
8. It includes `vs_classification`.
9. It includes `vs_recommended_action`.
10. It includes `vs_return_eligible`.
11. It includes human-readable `vs_reason`.
12. It includes machine-readable `vs_risk_flags`.
13. Existing frontend and existing routes still work.
14. Typecheck passes.
15. Build passes.
16. A sample Lead Prosper-style request can be tested successfully.

---

## Developer Notes

The purpose of this task is to productize the existing MVP for Lead Prosper.

Do not overbuild.

The most important outcome is a stable synchronous endpoint that Lead Prosper can call and use for custom fields.

The second most important outcome is clean, defensible scoring output that gives clients ammunition for rejecting or later returning bad leads.

Focus on:

```txt
adapter
normalization
flat fields
classification
evidence fields
logging
tests
```

Avoid:

```txt
dashboards
billing
automatic returns
major scoring rewrites
new infrastructure
```
