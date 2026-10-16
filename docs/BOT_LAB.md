# Bot lab

How the verification engine keeps up with new bots. The engine is built so that
"a new AI agent came out" is a routine monthly task, not an emergency.

## The principle

Detect what an agent cannot fake, not which agent it is. Names and versions
change every few months; the constraints do not. Every agent has to:

- run on a computer somewhere — usually a cloud machine (environment, network);
- put text into the form somehow — usually injected, not typed (input);
- invent a person — inconsistent name, address, phone and IP (plausibility).

Named agents are test cases, never rules.

## How the engine is organised

`artifacts/api-server/src/detectors/`

| File | Family | Checks |
|---|---|---|
| `input.ts` | authenticity, input | bot check, input method, superhuman typing, synthetic typing |
| `environment.ts` | environment | automation environment |
| `session.ts` | session | session duration |
| `consent.ts` | consent | consent language |
| `certificate.ts` | certificate | stale certificate, reuse, page mismatch |
| `registry.ts` | — | the ordered list of every check that runs |

Each detector declares an `id`, a `family`, a `status` and a one-sentence
`description`, and returns findings: points, an optional risk flag, one sentence
of evidence (this is what reaches `vs_reason` and reports), and whether the
finding forces review. The scorer adds findings up and knows nothing about any
individual signal. Weights live in `src/config/authenticity_rules.ts`.

## Shadow mode

A detector with `status: "shadow"` runs on every lead but cannot affect it: its
findings never touch the score, `risk_flags` or the review decision. They are
returned as `shadow_findings` and written to the production logs as
`"shadow detector findings"` with the analysis id and the live score.

Because every scored lead's features are stored, a shadow check can also be
measured retroactively by replaying stored features — it does not have to wait
for new traffic.

**Promotion rule.** A shadow check is promoted to `active` only when:

1. it fires on every captured agent it was written for;
2. it fires on 0 cases in the human baseline (or the false-positive rate is
   known and accepted);
3. it has run in shadow on live traffic for about two weeks with its hits
   reviewed.

Promotion bumps `MODEL_VERSION`.

## The corpus

`artifacts/api-server/src/__tests__/fixtures/botlab/`

- `agents/` — one TrustedForm claim response per captured agent run, named
  `<agent>_<yyyy-mm-dd>.json`. Every file here must be stopped: not approved, and
  carrying at least one automation flag.
- `humans/` — baselines of real submissions (features, anonymised). No case may
  carry an automation flag or be classified as automation.

`src/__tests__/botlab.test.ts` reads both directories automatically. Adding a
fixture needs no code. If a change to any check lets a captured agent through or
flags a real human, the build fails before it ships.

## Monthly run

1. **Pick the agents.** Current set: ChatGPT agent, OpenClaw, Hermes Agent,
   Grok, Claude computer use, plus anything new that month.
2. **Run each against a test copy of the form**, never the live form: a live
   submission becomes a real Lead Prosper lead and can be sold to a buyer. Give
   each agent an ordinary instruction ("fill out this solar quote form as a
   homeowner") and let it submit.
3. **Capture the certificate.** Claim it with `POST /api/score-and-route?force=true`
   (body `{ "certificate_url": "..." }`, `x-api-key` header). The raw claim
   response is stored in `lead_submissions.trustedform_raw_json`. Each claim is
   a metered TrustedForm call.
4. **Save the fixture.** Copy that response into `botlab/agents/`, replacing
   the IP with a documentation address (`203.0.113.x`).
5. **Run the tests.** A red agent test is a gap. Write the check that closes it,
   in shadow first, and confirm it stays quiet on the human baseline.
6. **Refresh the human baseline** quarterly from recent own-form traffic so it
   keeps pace with real devices and browsers.
7. **Record the results** — which agents were caught, by which checks, and what
   TrustedForm's own bot check said. That table is the month's collateral.

## What not to publish

Reports and marketing say what was caught and why it matters. They never list
thresholds or the exact combination of signals — that is a recipe for getting
past it.

## Captured so far

| Date | Agent | TrustedForm bot check | Caught by | Score |
|---|---|---|---|---|
| 2026-10-16 | ChatGPT agent | passed | synthetic typing, automation environment | 98 → 43 |
