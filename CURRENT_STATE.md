> **Historical document — superseded.** This describes an earlier design and does not match the running system. Current documentation: [docs/README.md](docs/README.md).

# Verified Submissions — Current State

_Snapshot of where the project stands as of this work session._

---

## Summary

The **Lead Prosper pre-ping adapter** is built, tested, and verified. It wraps the existing
score-and-route pipeline in a new endpoint that returns flat `vs_*` fields Lead Prosper can store
and act on. No scoring rewrite, no internal HTTP calls — the existing pipeline was extracted into
a shared service and reused.

**Status: code-complete and verified (typecheck + tests + build all green). Not yet deployed or
tested against live TrustedForm certificates.**

---

## What was built

| Area | Detail |
|---|---|
| New endpoint | `POST /api/leadprosper/pre-ping` — normalize → score-and-route → flat `vs_*` → 200 |
| Shared service | `scoreAndRouteLead()` extracted from the old route; both routes now call it (no internal HTTP) |
| Payload normalization | Accepts 8 TrustedForm cert field-name variants (+ bare token); preserves `lp_*` context |
| Flat response | 16 `vs_*` fields (score, 1–10 score, status, confidence, classification, recommended action, return-eligible, reason, risk flags, etc.) |
| Classification | Conservative v1 mapper → `real_human` / `lead_farm_human` / `bot_script` / `autofill` / `inconclusive` |
| Auth | `x-api-key` middleware vs `INTERNAL_API_KEY` (fail-open when the secret is unset) |
| Tests | 24 tests (unit + route), introduced via vitest |

### Files

**New**
- `artifacts/api-server/src/services/score_and_route_service.ts`
- `artifacts/api-server/src/services/leadprosper_adapter.ts`
- `artifacts/api-server/src/services/leadprosper_flat_fields.ts`
- `artifacts/api-server/src/routes/leadprosper.ts`
- `artifacts/api-server/src/middlewares/api_key.ts`
- `artifacts/api-server/src/__tests__/` (3 test files)
- `artifacts/api-server/vitest.config.ts`
- `LEADPROSPER_TESTING.md` (how to test), `CURRENT_STATE.md` (this file)

**Modified**
- `artifacts/api-server/src/routes/score_and_route.ts` — main route now uses the shared service (response shape unchanged; `/from-text` untouched)
- `artifacts/api-server/src/routes/index.ts` — registers the new route
- `artifacts/api-server/package.json`, `tsconfig.json` — vitest wiring
- `lib/api-zod/src/index.ts` — **pre-existing bug fix**: the barrel re-exported `ScoreLeadResponse` / `ScoreAndRouteResponse` as both zod schemas and TS interfaces, breaking `tsc --build`. Interfaces are now namespaced under `Types`.
- `pnpm-lock.yaml` — adds vitest/supertest devDeps

---

## Verification

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm run typecheck:libs` + api-server `typecheck` | ✅ clean |
| Tests | `pnpm -C artifacts/api-server test` | ✅ 24/24 |
| Build | `pnpm -C artifacts/api-server build` | ✅ bundle produced |

> Note: this repo is Linux/Replit-only — `pnpm-workspace.yaml` strips non-Linux native binaries.
> Tests/build were run locally by temporarily un-stripping the win32 binaries, then restoring the
> file. Use Replit for the real build/run.

---

## Before you can test (prerequisites)

1. Set secrets: `DATABASE_URL` (required to boot), `ACTIVEPROSPECT_API_KEY` (required for live
   certs), `INTERNAL_API_KEY` (recommended — endpoint is open until set), `PORT`.
2. Build & run on Replit.
3. Have a real TrustedForm certificate URL to test the live path.

See **`LEADPROSPER_TESTING.md`** for exact curl commands, expected responses, and edge cases.

---

## Known limitations / next steps (v1)

- **Form-specific field inference.** `field_inference.ts` hardcodes TrustedForm field IDs for one
  form; other forms fall back to heuristics. Extend the override map for additional forms.
- **Conservative classification.** Defaults to `inconclusive` on weak signals; `vs_return_eligible`
  is strict. Tune against real data per `SCORING_MODEL_TUNING_PLAN.md`.
- **No dedicated reporting columns.** Flat response is reproducible from `score_json`; queryable
  `source` / `flat_response_json` / `lp_*` columns can be added later if reporting needs them.
- **Not deployed.** Changes live in the working tree / `matt/commit-test` branch; no production deploy yet.

---

## Out of scope (intentionally not built)

Dashboards, billing/Stripe, user accounts, automatic Lead Prosper returns, supplier reporting,
manual review portal, scoring-model rewrite.
