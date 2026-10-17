> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Lead Prosper Adapter — Testing Guide

A one-page checklist for testing `POST /api/leadprosper/pre-ping`.

---

## 1. Environment variables

Set these on the server (Replit Secrets) before testing.

| Variable | Required? | Purpose | If missing |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection | App won't boot (`@workspace/db` throws at import) |
| `ACTIVEPROSPECT_API_KEY` | **Yes** for live certs | Authenticates the TrustedForm certificate claim | Every claim fails → responses come back `vs_classification: "inconclusive"`, `vs_pass: false` |
| `INTERNAL_API_KEY` | Recommended | Protects the endpoint via the `x-api-key` header | **Endpoint is OPEN** (fail-open). It logs a warning on every request. Set this before any exposed/real use. |
| `PORT` | **Yes** | Port the server listens on | App won't start |
| `CRM_WEBHOOK_URL` | No | Forward approved leads to CRM | Approved leads are logged only |
| `GOOGLE_SHEETS_ENABLED` | No (default on) | Append `review` leads to the review sheet | Set `false` to skip |
| `OUTBOUND_WEBHOOK_ENABLED` / `OUTBOUND_WEBHOOK_URL` | No | Mirror results to an outbound webhook | Skipped unless `OUTBOUND_WEBHOOK_ENABLED=true` |

> Auth behavior: if `INTERNAL_API_KEY` is **set**, requests must send a matching `x-api-key` header or get `401`. If it's **unset**, all requests are allowed (with a warning).

---

## 2. Build & run (Replit / Linux)

```bash
corepack pnpm install
corepack pnpm -C artifacts/api-server build
PORT=3000 corepack pnpm -C artifacts/api-server start
```

Health check:

```bash
curl http://localhost:3000/api/healthz
# {"status":"ok"}
```

---

## 3. Main test — pre-ping with a real certificate

```bash
curl -X POST http://localhost:3000/api/leadprosper/pre-ping \
  -H "Content-Type: application/json" \
  -H "x-api-key: $INTERNAL_API_KEY" \
  -d '{
    "lp_lead_id": "test-lp-123",
    "lp_campaign_id": "solar-campaign-1",
    "lp_supplier_id": "publisher-22",
    "trustedform_cert_url": "https://cert.trustedform.com/<REAL_CERT_HASH>",
    "email": "test@example.com",
    "phone": "5555555555",
    "first_name": "Test",
    "last_name": "Lead"
  }'
```

**Expected:** HTTP `200` with the flat contract:

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
  "vs_analysis_id": "uuid-or-empty",
  "vs_model_version": "0.1-beta"
}
```

The certificate URL is accepted under any of these field names (first match wins):
`certificate_url`, `trustedform_cert_url`, `trustedform_cert`, `trustedform_url`,
`xxTrustedFormCertUrl`, `xxTrustedFormToken` (bare 40-char token is OK), `tf_cert_url`, `tf_cert`.

---

## 4. Field reference (what Lead Prosper stores)

| Field | Type | Meaning |
|---|---|---|
| `vs_pass` | bool | Allow the lead to continue? (`false` on reject / analysis failure) |
| `vs_score` | 0–100 | Main operational score |
| `vs_score_1_10` | 1–10 | Simplified display score |
| `vs_status` | `approved`/`review`/`reject` | Band |
| `vs_confidence` | `high`/`medium`/`low` | Confidence |
| `vs_classification` | `real_human`/`lead_farm_human`/`bot_script`/`autofill`/`inconclusive` | Behavioral class |
| `vs_recommended_action` | `accept`/`review`/`reject` | Suggested action |
| `vs_return_eligible` | bool | Strong evidence for a later return (strict: high-confidence automated reject only) |
| `vs_certificate_id` | string | Parsed TrustedForm cert ID |
| `vs_consent_detected` | bool | Consent language found |
| `vs_session_seconds` | number | Session duration |
| `vs_meaningful_event_count` | number | Meaningful interactions |
| `vs_risk_flags` | string | Comma-separated flags |
| `vs_reason` | string | Human-readable evidence summary |
| `vs_analysis_id` | string | DB row id (empty if storage unavailable) |
| `vs_model_version` | string | Currently `0.1-beta` |

---

## 5. Edge cases to verify

| Case | Request | Expected |
|---|---|---|
| Missing cert URL | body with no cert field | `400`, `{ "vs_pass": false, "error": "No TrustedForm certificate URL found..." }` |
| Bad/expired cert | valid-looking URL, claim fails | `200`, `vs_pass:false`, `vs_classification:"inconclusive"`, `vs_status:"review"` |
| Wrong/missing API key (when `INTERNAL_API_KEY` set) | omit `x-api-key` | `401`, `{ "vs_pass": false, "error": "Unauthorized..." }` |
| Duplicate cert | same cert twice | Second call returns the cached analysis |

---

## 6. No-secret smoke test (scoring only, no live TrustedForm)

You still need `DATABASE_URL` to boot, but this path skips the cert claim, so it
doesn't need `ACTIVEPROSPECT_API_KEY`. Uses the built-in sample event logs:

```bash
curl -X POST http://localhost:3000/api/score-and-route/from-text \
  -H "Content-Type: application/json" \
  -d '{ "event_log_text": "<paste GOOD_LEAD_EVENT_LOG from src/fixtures/sample_leads.ts>" }'
```

Confirms the scoring pipeline runs end-to-end before you wire in real certs.

---

## 7. Confirm persistence

After a successful call, a row should exist in `lead_submissions`:

```sql
SELECT id, certificate_id, status, processed_at
FROM lead_submissions
ORDER BY processed_at DESC
LIMIT 5;
```

`raw_payload_json` holds the original Lead Prosper body; `score_json` holds the full score.

---

## Known limitations (v1)

- **Form-specific field inference.** `src/services/field_inference.ts` has hardcoded
  TrustedForm field IDs for one specific form. Leads from a different form fall back to
  regex heuristics — scores will be rougher until those overrides are extended.
- **Conservative classification.** `classifyLead` defaults to `inconclusive` on weak
  signals and `vs_return_eligible` is intentionally strict. Tune against real data per
  `SCORING_MODEL_TUNING_PLAN.md`.
- **Flat response isn't separately stored.** It's reproducible from `score_json`; no
  dedicated columns added in v1.
