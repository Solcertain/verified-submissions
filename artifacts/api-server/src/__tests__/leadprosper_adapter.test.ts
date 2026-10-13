import { describe, it, expect } from "vitest";
import { normalizeLeadProsperPayload } from "../services/leadprosper_adapter.js";
import { certificate_id_from_url } from "../services/leadprosper_flat_fields.js";

const HASH = "a".repeat(40);
const URL = `https://cert.trustedform.com/${HASH}`;

describe("normalizeLeadProsperPayload", () => {
  it("resolves certificate_url from each known field-name variant", () => {
    const variants = [
      "certificate_url",
      "trustedform_cert_url",
      "trustedform_cert",
      "trustedform_url",
      "xxTrustedFormCertUrl",
      "tf_cert_url",
      "tf_cert",
    ];
    for (const key of variants) {
      const { certificate_url } = normalizeLeadProsperPayload({ [key]: URL });
      expect(certificate_url).toBe(URL);
    }
  });

  it("builds a certificate URL from a bare 40-char hex token", () => {
    const { certificate_url } = normalizeLeadProsperPayload({ xxTrustedFormToken: HASH });
    expect(certificate_url).toBe(URL);
  });

  it("returns null when no certificate field is present", () => {
    const { certificate_url } = normalizeLeadProsperPayload({ email: "a@b.com" });
    expect(certificate_url).toBeNull();
  });

  it("respects field priority (certificate_url wins over tf_cert)", () => {
    const a = `https://cert.trustedform.com/${"a".repeat(40)}`;
    const b = `https://cert.trustedform.com/${"b".repeat(40)}`;
    const { certificate_url } = normalizeLeadProsperPayload({ tf_cert: b, certificate_url: a });
    expect(certificate_url).toBe(a);
  });

  it("preserves known context fields and passes the raw payload through", () => {
    const body = {
      certificate_url: URL,
      lp_lead_id: "L1",
      lp_campaign_id: "C1",
      email: "x@y.com",
      junk_field: "ignored",
    };
    const { context, raw_payload } = normalizeLeadProsperPayload(body);
    expect(context).toEqual({ lp_lead_id: "L1", lp_campaign_id: "C1", email: "x@y.com" });
    expect(context).not.toHaveProperty("junk_field");
    expect(raw_payload).toBe(body);
  });

  it("ignores empty-string certificate values and falls through", () => {
    const { certificate_url } = normalizeLeadProsperPayload({ certificate_url: "  ", tf_cert: URL });
    expect(certificate_url).toBe(URL);
  });
});

describe("certificate_id_from_url", () => {
  it("reads the certificate id from the cert URL path", () => {
    expect(certificate_id_from_url(URL)).toBe(HASH);
  });

  it("returns an empty string for a non-TrustedForm URL", () => {
    expect(certificate_id_from_url("https://example.com/abc")).toBe("");
  });
});
