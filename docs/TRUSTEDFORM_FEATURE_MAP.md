# TrustedForm Feature Map

What the TrustedForm API **actually returns**, verified against the live service on 2026-10-08,
versus what this codebase assumes. Supersedes guesses in `event_parser.ts` and
`parse_trustedform_payload`.

> Sources: [Claiming a certificate](https://developers.activeprospect.com/api-reference/claiming-certificates/claiming-a-certificate),
> [Retrieve certificate insights](https://developers.activeprospect.com/api-reference/retrieving-insights/retrieve-certificate-insights.md),
> [Claiming Certificates v3](https://activeprospect.redoc.ly/docs/trustedform/api/v3.0/tag/Claiming-Certificates/).

---

## 1. The request

```
POST https://cert.trustedform.com/{cert_id}
Accept: application/json
Content-Type: application/json          <-- REQUIRED. The body is optional.
Authorization: Basic base64("API:<api_key>")
```

`Content-Type` being required while the body is optional is the trap. The original client sent a
bare `POST` with only `Accept` and `Authorization`, and every claim failed with an opaque
`HTTP 400`. Fixed in `trustedform_client.ts`.

Optional body fields (all of them): `email` / `email_N`, `phone` / `phone_N`, `fingerprints`,
`reference`, `vendor`, `required_scan_terms`, `forbidden_scan_terms`, `scan_delimiter`.
`reference` is the natural home for the Lead Prosper lead id.

**Products are not selected in the request.** They are entitlements on the ActiveProspect account
behind the API key. Which response variant you receive — `ConsentClaimResponse`,
`ConsentAndInsightsClaimResponse`, `RetainResponse`, `InsightsResponse` — follows from that.

### Current blocker

```json
{"reason": "No valid products detected", "outcome": "error"}   // HTTP 400
```

The key **authenticates** (a bad key returns 401, and funding problems return 402), so this is
purely a product entitlement: the account has no TrustedForm product enabled for claiming.
**Insights must be enabled before any of the work below is possible.**

---

## 2. What the response actually contains

Top level: `outcome`, `reason`, `warnings`, `is_masked`, `masked_cert_url`, `scans`,
`fingerprints`, and `cert`.

The `cert` object is where every behavioral signal lives:

| Field | Meaning |
|---|---|
| `form_input_method` | **`autofill` \| `paste` \| `typing`** |
| `kpm`, `wpm` | Typing-rate metrics (note: the spec's descriptions for these two look transposed — verify against real data before trusting the names) |
| `event_duration_ms` | Script load → most recent event |
| `age_seconds` | Seconds since the last user interaction |
| `created_at`, `expires_at` | Certificate lifetime |
| `is_mobile`, `browser`, `operating_system`, `user_agent` | Device and client |
| `is_framed` | Whether the form was iframed |
| `ip`, `approx_ip_geo` | Network origin |
| `domain`, `page_url`, `parent_page_url`, `page_id` | Page identity |
| `scans` | `required_found` / `required_not_found` / `forbidden_found` / `forbidden_not_found` — this is the consent-language check |
| `fingerprints` | `matching` / `non_matching` against submitted email and phone |

---

## 3. The gap between this and the code

**There is no event log in the API response.** None of the four response variants contains one.
The 120-event log in `attached_assets/` was copy-pasted out of the TrustedForm **web UI**; it is
not something the API returns.

That invalidates the core assumption of the current engine:

| Code assumes | Reality |
|---|---|
| `parse_trustedform_text` parses a whitespace-delimited event log | The API never returns one |
| `parse_trustedform_payload` reads `payload["id"]`, `["fields"]`, `["answers"]`, `["events"]` | None of those keys exist. Real keys are `outcome`, `cert`, `scans`, `fingerprints`, `warnings` |
| Character-level progression across `changed value` events reveals typing | TrustedForm already computes this as `form_input_method` plus `kpm`/`wpm` |
| `field_inference.ts` maps per-form field IDs | No field-level data is returned at all |
| Consent detected by matching log text | Consent comes from `scans` against `required_scan_terms` you supply |

**This is good news for the product.** `form_input_method ∈ {autofill, paste, typing}` is a
cleaner, vendor-computed version of the signal the engine was trying to reconstruct by hand, and
it arrives without any form-specific coupling. The Heyflow/React problem disappears with it.

---

## 4. Spec features that cannot be derived

Per the 8-8 prompt: *"Identify features we expected to have but cannot actually derive reliably…
Document those gaps rather than fabricating them."*

| Spec feature | Status |
|---|---|
| `keystrokes_present` | **Proxy only** — `form_input_method = "typing"`, with `kpm`/`wpm` as rate |
| `changed_value_only_fields`, instant/rapid injection | **Proxy only** — `form_input_method` = `paste` or `autofill` |
| `backspaces` | **Not available.** No keystroke-level data |
| field interaction timing | **Not available** per field; only `event_duration_ms` overall |
| session duration | **Proxy** — `event_duration_ms`, `age_seconds` |
| mouse activity | **Not available** |
| scroll activity | **Not available** |
| linear navigation / flow | **Not available** |
| meaningful event count | **Not available** as a count |
| TrustedForm Insights `bot_detected` | **Does not exist** in the spec. Do not build against it |
| consent signal | **Available** via `scans` + `required_scan_terms` |

Seven of the twelve are unavailable or proxy-only. The scoring model must be rebuilt around what
exists rather than around an event log.

---

## 5. Recommended engine inputs

A deterministic model over these, with every field explicitly `unknown`-capable:

- `form_input_method` — the primary authenticity signal
- `kpm` / `wpm` — implausibly high rates indicate automation; verify the transposed naming first
- `event_duration_ms` — near-zero means programmatic submission
- `is_framed`, `is_mobile`, `browser`, `operating_system`, `user_agent` — environment plausibility
- `scans` — consent present or absent
- `fingerprints.matching` — does the submitted contact data match what was typed on the page
- `approx_ip_geo` versus the lead's stated location — mismatch as a soft signal

None of these require form-specific field maps, which removes the entire class of breakage that
retiring the Heyflow form introduced.

---

## 6. Next actions

1. **Enable TrustedForm Insights on the ActiveProspect account.** Everything else is blocked on it.
2. Claim one certificate and record the real `cert` object verbatim, then write the parser against
   that rather than this document.
3. Replace `parse_trustedform_payload`'s guessed keys with the real schema.
4. Retire `parse_trustedform_text` from the production path, or keep it strictly as a QA aid for
   UI-pasted logs with its line-format bug fixed.
5. Rebuild scoring on §5, and delete the three Heyflow couplings along with the event-log model.
