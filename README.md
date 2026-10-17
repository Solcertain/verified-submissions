# Verified Submissions

Lead verification engine: scores whether a real person, giving real consent,
produced each lead, using TrustedForm certificate data. Runs as an Express API
on Vercel and plugs into Lead Prosper as a pre-ping.

**Documentation: [docs/README.md](docs/README.md)** — start with
[SCORING_MODEL.md](docs/SCORING_MODEL.md) and [OPERATIONS.md](docs/OPERATIONS.md).

---

_The original notes for this folder follow. They describe the June 2026 source
docs, which are now historical._

# Verified Submissions Source Docs

This folder contains Markdown source files that can be added to the repo or uploaded into an AI coding tool as project context.

## Files

| File | Purpose |
|---|---|
| `API_REFERENCE.md` | Core Verified Submissions API behavior, endpoint contract, scoring output, database logging, and security notes. |
| `LEAD_PROSPER_INTEGRATION.md` | Lead Prosper integration source, including useful endpoints, recommended MVP flow, and service skeleton. |

## Recommended Repo Location

```txt
verified-submissions/
  docs/
    API_REFERENCE.md
    LEAD_PROSPER_INTEGRATION.md
```

## How to Use With a Developer

Give these docs to the developer before coding and say:

> Build only what is described in `API_REFERENCE.md` first. Then add the read-only Lead Prosper lookup flow from `LEAD_PROSPER_INTEGRATION.md`. Do not build dashboard, billing, auto-return, or pause-buyer automation in the MVP.

## How to Use With Cursor, Codex, or GitHub Copilot

Add the files to the `docs/` folder, then prompt the coding tool:

```txt
Read docs/API_REFERENCE.md and docs/LEAD_PROSPER_INTEGRATION.md.
Build the MVP backend exactly from these docs using Node.js, TypeScript, Express, and Supabase.
Keep the implementation modular with separate TrustedForm, Lead Prosper, scoring, and Supabase service files.
```
