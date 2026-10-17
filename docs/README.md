# Verified Submissions documentation

## Current — start here

| Document | What it covers |
|---|---|
| [SCORING_MODEL.md](SCORING_MODEL.md) | **How a lead is scored.** Every check, weight, threshold, classification, status and response field; observed performance; known limitations |
| [OPERATIONS.md](OPERATIONS.md) | Endpoints, auth, environment, Lead Prosper and ActiveProspect configuration, outcomes and calibration, deploying, routine tasks, open items |
| [VERIFICATION_PLAN.md](VERIFICATION_PLAN.md) | Acceptance criteria and schedule for a verified engine by 2026-10-28; return backtest results |
| [BOT_LAB.md](BOT_LAB.md) | How the engine keeps up with new bots: detector architecture, shadow mode, the agent/human corpus, the monthly run |
| [TRUSTEDFORM_FEATURE_MAP.md](TRUSTEDFORM_FEATURE_MAP.md) | Research notes on what TrustedForm v4 returns and what each field means. Background, not a spec |

## Historical — do not build from these

These describe earlier designs (a 100-and-deduct event-log model, Supabase,
lowercase classification labels, a Replit deployment). Each carries a banner
pointing here. They are kept for the reasoning they record.

| Document | Era |
|---|---|
| `../API_REFERENCE.md` | Original MVP API spec, June 2026 |
| `../LEAD_PROSPER_INTEGRATION.md` | Original Lead Prosper integration plan, June 2026 |
| `../LEADPROSPER_ADAPTER_SCOPE.md`, `../LEADPROSPER_TESTING.md` | Pre-ping adapter scope and test notes, June 2026 |
| `../SCORING_MODEL_TUNING_PLAN.md` | Event-log tuning plan, June 2026; superseded by the insights model |
| `../CURRENT_STATE.md` | June 2026 snapshot |
| `../OVERVIEW.md`, `../replit.md` | Original Replit-era overview, March 2026 |
| `MVP_STATUS.md` | Repository audit, 2026-10-05 |

## Keeping this accurate

Any change that alters scoring updates SCORING_MODEL.md in the same commit:
the tables in §4, the version history in §10, and the "Last verified" date.
Any change to Lead Prosper, ActiveProspect or Vercel configuration updates
OPERATIONS.md.
