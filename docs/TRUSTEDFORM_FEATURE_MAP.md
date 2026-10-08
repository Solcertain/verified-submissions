# TrustedForm Feature Map

What the TrustedForm API **actually returns**, captured from a successful live claim on
2026-10-08. Everything below is observed, not inferred from documentation. Supersedes the guessed
key names in `parse_trustedform_payload` and the event-log model in `event_parser.ts`.

> Sources: [Run certificate operations](https://developers.activeprospect.com/api-reference/certificate-url/run-certificate-operations.md),
> [Insights operation](https://developers.activeprospect.com/api-reference/trustedform/v4/operations/insights.md),
> [claims_api-v4.yaml](https://developers.activeprospect.com/api-reference/claims_api-v4.yaml).

---

## 1. The request that works

```
POST https://cert.trustedform.com/{cert_id}
Accept: application/json
Content-Type: application/json          <-- REQUIRED (the body is optional, the header is not)
Api-Version: 4.0
Authorization: Basic base64("API:<api_key>")

{"insights": {"properties": ["bot_detected", "form_input_method", ...]}}
```

Two traps, both of which cost us a failed claim each:

1. **No `Content-Type` → opaque `HTTP 400`.** The original client sent only `Accept` and
   `Authorization`.
2. **No operation key in the body → `{"reason":"No valid products detected","outcome":"error"}`.**
   v4 selects products via operation keys (`insights`, `verify`, `retain`, `match_lead`) in the
   body. Having Insights enabled on the account is necessary but not sufficient — the request
   must ask for it. A bad key returns 401 and an unfunded account returns 402, so a 400 here is
   neither.

### Valid `insights.properties` (complete enum, 21 values)

`age_seconds` · `approx_ip_geo` · `bot_detected` · `browser` · `confirmed_owner` · `created_at` ·
`domain` · `expires_at` · `form_input_kpm` · `form_input_method` · `form_input_wpm` · `ip` ·
`is_framed` · `is_masked` · `num_sensitive_content_elements` · `num_sensitive_form_elements` ·
`os` · `page_url` · `parent_page_url` · `seconds_on_page` · `session_replay_status`

Only contracted properties may be queried, and billing is per property returned, so
`INSIGHTS_PROPERTIES` in `trustedform_client.ts` is a deliberate subset.

---

## 2. The verified response shape

Captured from cert `a7a4a15ca…`, stored in `lead_submissions.trustedform_raw_json`:

```json
{
  "reason": null,
  "outcome": "success",
  "insights": {
    "scans": { "result": { "success": null,
                           "required":  { "found": [], "not_found": [] },
                           "forbidden": { "found": [], "not_found": [] } },
                "required": [], "forbidden": [] },
    "properties": {
      "ip": "35.39.112.1",
      "os": { "full": "iOS 18.7", "name": "iOS",
              "version": { "full": "18.7", "major": "18", "minor": "7", "patch": null },
              "is_mobile": true },
      "domain": "solar-advisors.org",
      "browser": { "full": "Mobile Safari 26.6", "name": "Mobile Safari",
                   "version": { ... }, "user_agent": "Mozilla/5.0 (iPhone; ...)" },
      "page_url": "https://survey.solar-advisors.org/",
      "is_framed": true,
      "created_at": "2026-10-06T21:04:12Z",
      "expires_at": "2027-01-07T21:04:12Z",
      "age_seconds": 175046,
      "bot_detected": false,
      "approx_ip_geo": { "lat": 33.4532, "lon": -112.0748, "city": null, "state": "Arizona",
                         "time_zone": "America/Phoenix", "postal_code": null,
                         "country_code": "US" },
      "form_input_kpm": 65531.098653316585,
      "form_input_wpm": 9010.54497015666,
      "seconds_on_page": 57,
      "form_input_method": ["typing", "autofill"]
    }
  }
}
```

### Five things that are not obvious and will bite

1. **Everything lives under `insights.properties`.** Not top level, and **not** under a `cert`
   object as the v3 documentation describes. `parse_trustedform_payload` reads `payload["id"]`,
   `["fields"]`, `["answers"]`, `["events"]` — not one of those exists.
2. **`form_input_method` is an ARRAY**, not a string: `["typing", "autofill"]`. A single
   certificate can be both, because different fields were filled differently. Any code treating
   it as a scalar will be wrong on exactly the mixed cases that matter most.
3. **`form_input_kpm` = 65531.1 and `form_input_wpm` = 9010.5 on a certificate with
   `bot_detected: false`, `form_input_method` including `typing`, and a plausible
   `seconds_on_page: 57`.** Those rates are not physically meaningful as "keystrokes per minute"
   and "words per minute". Units or semantics differ from the names, and the published
   descriptions for the two already look transposed. **Do not write a threshold rule against
   these until their distribution is understood.** A naive `kpm > 1000 → bot` would reject
   essentially all traffic.
4. **`scans` came back empty because we did not ask.** Consent detection requires sending
   `required_scan_terms` with the consent language. Consent is a core product requirement and we
   are currently not requesting it.
5. **`domain` is `solar-advisors.org`, not `solarenergynerds.com`.** This lead reached campaign
   23668 carrying a certificate from a third-party publisher. Traffic is more heterogeneous than
   "our form" — which is further reason the engine must not depend on per-form field maps.

### Timing

`age_seconds: 175046` ≈ 48.6 hours at claim time, against a **~72 hour claim window**.
`expires_at` is 90 days out, but that is retention, not claimability. Certificates must be claimed
within roughly three days of creation, so shadow-mode capture has to run close to real time.

---

## 3. The gap between this and the code

| Code assumes | Reality |
|---|---|
| A whitespace-delimited event log (`parse_trustedform_text`) | The API returns no event log in any variant. The 120-event sample in `attached_assets/` came from the web UI |
| `payload["id"]`, `["fields"]`, `["answers"]`, `["events"]` | Real path is `insights.properties.*` |
| Per-form field IDs in `field_inference.ts` | No field-level data is returned at all |
| Consent found by matching log text | Consent comes from `scans`, and only if `required_scan_terms` is sent |
| `form_input_method` as a scalar | It is an array |
| Character-level typing progression must be reconstructed | TrustedForm computes it as `form_input_method` |

**This is good news.** The signals are vendor-computed and carry no form coupling, so retiring the
Heyflow form stops mattering. All three Heyflow couplings can be deleted along with the event-log
model.

---

## 4. Spec features: what is actually derivable

| 8-8 spec feature | Status against the real API |
|---|---|
| `keystrokes_present` | **Yes** — `form_input_method` contains `typing` |
| `changed_value_only_fields`, instant/rapid injection | **Yes** — `form_input_method` contains `autofill` or `paste` |
| TrustedForm Insights `bot_detected` | **Yes** — a real property, returned as a boolean |
| session duration | **Yes** — `seconds_on_page` |
| consent signal | **Yes**, but only if `required_scan_terms` is sent |
| typing speed | **Returned** as `form_input_kpm` / `form_input_wpm`, but see §2.3 — unusable until calibrated |
| `backspaces` | **No.** No keystroke-level data exists |
| per-field interaction timing | **No.** Only `seconds_on_page` overall |
| mouse activity | **No** |
| scroll activity | **No** |
| linear navigation / flow | **No** |
| meaningful event count | **No** |

Six of twelve are genuinely available, one is returned but not yet trustworthy, five cannot be
derived. Document the five as gaps rather than fabricating them, per Prompt 3.

Beyond the spec, the API also offers signals worth using: `is_framed`, `os.is_mobile`,
`approx_ip_geo` versus the lead's stated location, `domain` / `page_url` provenance, and
`num_sensitive_form_elements`.

---

## 5. Next actions

1. **Rewrite `parse_trustedform_payload` against §2.** Read `insights.properties`, treat
   `form_input_method` as an array, and keep every field `unknown`-capable — absent must not
   collapse to false.
2. **Send `required_scan_terms`** with the real consent language so `scans` returns something.
3. **Rebuild scoring** on `bot_detected`, `form_input_method`, `seconds_on_page`, `is_framed` and
   geo/device plausibility. Leave `form_input_kpm` / `form_input_wpm` out of the score until their
   distribution is understood.
4. **Delete the event-log path** from production: the three Heyflow couplings,
   `field_inference.ts`'s override map, and `parse_trustedform_text` (or keep the latter strictly
   as a QA aid with its line-format bug fixed).
5. **Capture at scale, close to real time** — the claim window is ~72 hours, so a nightly batch
   would miss certificates.

---

## 6. The `verify` operation — contracted, and what it found

`verify` **is** available on the account (`consent_language_acceptance_enabled: true`). Request:

```json
{"insights": {"properties": [...]},
 "verify": {"advertiser_name": "Solar Energy Nerds",
            "opt_in_types_allowed": ["manual", "pre-selected", "non-interactive"]}}
```

Result on a live certificate from `survey.solar-advisors.org`:

```json
"outcome": "failure",
"reason": "Consent language not detected in the certificate. This form has not been
           setup to allow use of One to One Consent Check. The form did not contain
           any consent items. The form may not be set up correctly.",
"verify": { "result": { "success": false,
                        "form_submitted": true,
                        "language_approved": false,
                        "one_to_one": null,
                        "opt_in_types_satisfied": null },
            "languages": [],
            "consent_language_acceptance_enabled": true }
```

`form_submitted: true` — the certificate is genuine and a form was submitted. But **no consent
items were captured at all**, so TrustedForm cannot evaluate consent or one-to-one for it.

### Read this carefully — it has two possible meanings

1. The source form genuinely carries no consent language. That is a live compliance exposure.
2. The form has consent language but has not implemented TrustedForm **tagged consent**
   (`data-tf-element-role` attributes), so it is present on the page but invisible to `verify`.

**Nothing observed so far distinguishes these.** Do not report this as a consent failure until it
is settled.

### How to settle it

Send `required_scan_terms` with generic TCPA phrasing — `"prior express written consent"`,
`"automatic telephone dialing system"` — which text-scans the page snapshot rather than relying on
tagging. If the scan also finds nothing, reading 1 is strongly supported. If the scan finds the
language, it is reading 2: a detection gap, and the fix is asking the publisher to tag consent.

This is also why scan terms remain necessary alongside `verify`: our own form uses tagged consent,
but certificates arriving from other domains may not, and `verify` alone cannot tell "absent" from
"untagged".

### Open question

Both certificates claimed so far originated at `survey.solar-advisors.org`, not
`solarenergynerds.com`. Whether that domain is a Solcertain property or a third-party publisher
changes who owns the fix and how urgent it is. **Unresolved.**

---

## 7. First real finding — partner consent gap (settled)

The §6 ambiguity is resolved. A page-snapshot scan of a `survey.solar-advisors.org` certificate
(partner traffic reaching campaign 23668 via supplier **Simple Tree**) returned:

```
found:     "consent", "Terms", "Privacy Policy", "text messages"
not_found: "prior express written consent", "automatic telephone dialing system",
           "autodialed", "prerecorded", "Do Not Call"
```

So the page is **not** blank on consent — it carries a generic consent/terms blurb. What it lacks
is every phrase that makes consent valid for autodialed or prerecorded contact. This is therefore
**not** a tagging or detection artifact: the required language is genuinely absent.

For contrast, our own form's `TCPA_TEXT` (`sen-site/form-app/src/steps/Submit.jsx:15`) contains
all five: prior express written consent, automatic telephone dialing system, artificial or
prerecorded voice, and state/federal/corporate Do Not Call list.

**Scans and verify are complementary and both are needed.** `verify` returned
`language_approved: false` with `languages: []` and could not say why; the scan produced the
per-term breakdown that made the finding actionable.

### The lead itself

| Signal | Value |
|---|---|
| `bot_detected` | `false` |
| `form_input_method` | `["typing", "autofill"]` |
| `seconds_on_page` | 133 |
| `os` | iOS 18.7, mobile |
| `approx_ip_geo` | New Providence, **New Jersey** |
| Lead `state` field | **"NY"** |
| Lead `zip_code` | 07974 — which is New Providence, **NJ** |
| Lead `utility_provider` | "Pg&e" — a **California** utility |

A real human spent over two minutes typing on a phone. The person is genuine; the **data** is
broken. IP geo agrees with the zip code, so `state` is simply mis-populated, and the utility is
from the wrong coast entirely.

Every buyer rejected it — `state is invalid`, `zip_code is invalid`, `utility_provider is invalid`.

**Two distinct problems, and the engine must not conflate them:**

1. **Compliance** — consent language missing the TCPA essentials, on leads being resold onward.
2. **Data quality** — a broken `state` field and wrong `utility_provider` making leads unsellable.

Neither is bot fraud, and a bot-only model would score this lead clean. Authenticity, consent, and
sellability are three different axes.

### Still unusable

`form_input_kpm` 9651.9 and `form_input_wpm` 3453.1 across 133 seconds — again not physically
meaningful, and the ratio between them differs from the earlier certificate, so it is not a fixed
scaling factor. Keep both out of scoring pending ActiveProspect's answer on units.
