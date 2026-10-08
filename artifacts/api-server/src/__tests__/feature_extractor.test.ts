import { describe, it, expect } from "vitest";
import { extract_features, empty_features } from "../services/feature_extractor.js";
import real_claim from "./fixtures/claim_with_scans.json";

// The fixture is a real TrustedForm v4 response captured on 2026-10-08, with IP,
// city and postal code redacted. Keeping tests anchored to a real payload is the
// point: the previous parser was written against guessed key names and returned
// nothing on live data.

describe("extract_features — against a real claim response", () => {
  const f = extract_features(real_claim);

  it("reads authenticity signals from insights.properties", () => {
    expect(f.bot_detected).toBe(false);
    expect(f.input_methods).toEqual(["typing", "autofill"]);
    expect(f.seconds_on_page).toBe(133);
  });

  it("derives input-method flags from the array, which may contain several", () => {
    expect(f.typed).toBe(true);
    expect(f.autofilled).toBe(true);
    expect(f.pasted).toBe(false);
  });

  it("reads consent from the verify block", () => {
    expect(f.form_submitted).toBe(true);
    expect(f.consent_verified).toBe(false);
    expect(f.consent_language_approved).toBe(false);
    // one_to_one came back null — unevaluable, which is not the same as "failed"
    expect(f.consent_one_to_one).toBeNull();
  });

  it("reads the per-term scan breakdown", () => {
    expect(f.consent_terms_found).toContain("consent");
    expect(f.consent_terms_missing).toContain("prior express written consent");
    expect(f.consent_terms_missing).toContain("automatic telephone dialing system");
  });

  it("reads provenance and environment", () => {
    expect(f.domain).toBe("solar-advisors.org");
    expect(f.is_framed).toBe(true);
    expect(f.is_mobile).toBe(true);
    expect(f.os_name).toBe("iOS");
    expect(f.geo_state).toBe("New Jersey");
  });

  it("captures kpm/wpm without implying they are usable", () => {
    // Recorded for calibration only. See docs/TRUSTEDFORM_FEATURE_MAP.md §7 —
    // the units do not match the names, so no scoring rule may read these.
    expect(typeof f.form_input_kpm).toBe("number");
    expect(typeof f.form_input_wpm).toBe("number");
  });

  it("is deterministic", () => {
    expect(extract_features(real_claim)).toEqual(extract_features(real_claim));
  });
});

describe("unknown is never false", () => {
  it("returns null, not false, when the payload is empty", () => {
    const f = extract_features({});
    expect(f.bot_detected).toBeNull();
    expect(f.typed).toBeNull();
    expect(f.consent_verified).toBeNull();
    expect(f.form_submitted).toBeNull();
    expect(f.seconds_on_page).toBeNull();
  });

  it("returns null for derived flags when form_input_method is absent", () => {
    // The dangerous case: absent input methods must not read as "did not type".
    const f = extract_features({ insights: { properties: { bot_detected: false } } });
    expect(f.bot_detected).toBe(false);
    expect(f.input_methods).toBeNull();
    expect(f.typed).toBeNull();
    expect(f.autofilled).toBeNull();
    expect(f.pasted).toBeNull();
  });

  it("distinguishes an absent consent block from a failed consent check", () => {
    const absent = extract_features({ insights: { properties: {} } });
    expect(absent.consent_verified).toBeNull();

    const failed = extract_features({ verify: { result: { success: false } } });
    expect(failed.consent_verified).toBe(false);

    expect(absent.consent_verified).not.toBe(failed.consent_verified);
  });

  it("distinguishes absent scans from scans that found nothing", () => {
    const absent = extract_features({ insights: { properties: {} } });
    expect(absent.consent_terms_found).toBeNull();

    const empty = extract_features({
      insights: { properties: {}, scans: { result: { required: { found: [], not_found: [] } } } },
    });
    expect(empty.consent_terms_found).toEqual([]);
  });
});

describe("malformed input", () => {
  it.each([null, undefined, "a string", 42, []])("yields empty features for %p", (bad) => {
    const f = extract_features(bad);
    expect(f.bot_detected).toBeNull();
    expect(f.parse_notes.length).toBeGreaterThan(0);
  });

  it("ignores wrongly typed values rather than coercing them", () => {
    const f = extract_features({
      insights: { properties: { bot_detected: "yes", seconds_on_page: "133" } },
    });
    expect(f.bot_detected).toBeNull();
    expect(f.seconds_on_page).toBeNull();
  });

  it("drops non-string entries from form_input_method", () => {
    const f = extract_features({
      insights: { properties: { form_input_method: ["typing", 7, null] } },
    });
    expect(f.input_methods).toEqual(["typing"]);
    expect(f.typed).toBe(true);
  });
});

describe("parse notes", () => {
  it("records why a claim produced nothing", () => {
    const f = extract_features({});
    expect(f.parse_notes.join(" ")).toMatch(/insights/i);
    expect(f.parse_notes.join(" ")).toMatch(/verify/i);
  });

  it("flags a missing scan result so an absent consent check is visible", () => {
    const f = extract_features({ insights: { properties: {} }, verify: { result: {} } });
    expect(f.parse_notes.join(" ")).toMatch(/required_scan_terms/i);
  });

  it("empty_features carries the supplied note", () => {
    expect(empty_features("boom").parse_notes).toEqual(["boom"]);
  });
});
