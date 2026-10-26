# Customer accounts and billing (Phase 2)

Outside customers call the API with their own keys, verify on their own
ActiveProspect account, and pay per verified lead through Stripe. Solcertain is
customer #1 (`00000000-0000-0000-0000-000000000001`); `INTERNAL_API_KEY`,
`ACTIVEPROSPECT_API_KEY` and `LP_CALLBACK_TOKEN` resolve to it in code, so the
Lead Prosper flow (campaign 23668) is unchanged.

## Endpoints

| Route | Auth | What it does |
|---|---|---|
| `POST /api/v1/verify` | `x-api-key` | Scores a certificate for the calling customer. Returns status, action, score, flags, reasons, consent, `billable`. |
| `POST /api/v1/outcomes/:token` | path token | Records `accepted / sold / returned / rejected` for a lead, under the token's customer. |
| `POST /api/leadprosper/pre-ping` | `x-api-key` | Unchanged response; now resolves the customer from the key. |
| `POST /api/leadprosper/outcome/:token` | path token | Unchanged; `LP_CALLBACK_TOKEN` is Solcertain, other tokens are looked up. |
| `GET /api/reports/verification` | `x-api-key` | Customer keys see only their own leads. `INTERNAL_API_KEY` sees Solcertain's by default, `?customer_id=<uuid>` or `?customer_id=all`. |
| `POST /api/billing/checkout` | invite token | `{ invite_token, tier }` → Stripe Checkout URL (subscription, metered price). |
| `POST /api/stripe/webhook` | Stripe signature | Mounted with `express.raw()` before `express.json()` in `app.ts`. |
| `GET /api/cron/report-usage` | `CRON_SECRET` / internal key | Daily resend of usage Stripe has not acknowledged. |
| `POST /api/admin/invites` | internal key | Signed invite token + join URL (no email; the waitlist admin wiring is step 6). |
| `POST /api/admin/customers/:id/api-keys` | internal key | New `vsk_…` key, shown once. `DELETE …/api-keys/:key_id` revokes. |
| `PUT /api/admin/customers/:id/activeprospect-key` | internal key | Stores the customer's ActiveProspect key, AES-256-GCM encrypted. |
| `POST /api/admin/customers/:id/outcome-tokens` | internal key | New outcome URL token, shown once. |

`/api/score-lead`, `/api/score-lead/from-text` and `/api/score-and-route/from-text`
answer 403 to customer keys: they claim without metering or feed Solcertain's
review sheet. A customer's leads never go to the Google Sheet or the outbound
webhook.

Auth fails closed: with `INTERNAL_API_KEY` unset only customer keys work
(previously everything was let through).

## Billing

- Billable unit: one unique certificate scored for a customer (`usage_events`,
  unique on `customer_id, certificate_id`). Cache hits, forced rescores and
  failed claims are free; rejected leads count.
- Each new usage row is sent to the `verified_lead` meter without waiting; the
  usage row id is the meter event `identifier`, so resends are deduplicated.
- Tiers (`services/billing.ts`): Starter $0.15 / $500 minimum, Growth $0.12 /
  $2,000, Founder $0.08 / none. Founder invites always get the founder price.
  Enterprise is set up by hand.
- `invoice.created` (renewal invoices, while draft): adds one
  "Monthly minimum top-up" invoice item for `minimum − subtotal` when usage fell
  short, keyed `vs-topup-<invoice id>`.
- `invoice.payment_failed` → `past_due` (emails once); verify keeps working for
  `PAST_DUE_GRACE_DAYS` (default 7), then 402. `customer.subscription.updated`
  follows status and plan changes; `deleted` → `canceled` (403).

## Environment

| Variable | Needed for |
|---|---|
| `STRIPE_SECRET_KEY` | Checkout, meter events, top-ups |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature (503 without it) |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_FOUNDER` | Metered prices on meter `verified_lead` |
| `RESEND_API_KEY`, `MAIL_FROM` | Email (nothing is sent without the key) |
| `SECRETS_ENCRYPTION_KEY` | 32 bytes, hex or base64: encrypts customers' ActiveProspect keys |
| `INVITE_SIGNING_SECRET` | Signs invite tokens |
| `PORTAL_URL` | Links in emails and Checkout return URLs (default `https://portal.verifiedsubmission.com`) |
| `PAST_DUE_GRACE_DAYS` | Optional, default 7 |
| `SESSION_SECRET` | Reserved for the Phase 3 portal login |

## Deploy order

1. `DATABASE_URL=… node lib/db/migrate.mjs --until 0003` (additive; the current
   production code keeps working).
2. Deploy this branch.
3. `DATABASE_URL=… node lib/db/migrate.mjs` to apply 0004, which drops the
   global one-row-per-certificate index so two customers can each score the
   same certificate.
