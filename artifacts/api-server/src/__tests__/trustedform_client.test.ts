import { describe, it, expect, vi, afterEach } from "vitest";
import { claim_certificate } from "../services/trustedform_client.js";

// TrustedForm bills per Insights property returned, so the claim must ask for
// exactly what the detectors read. Adding a property here is a pricing change.
describe("claim_certificate request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["ACTIVEPROSPECT_API_KEY"];
  });

  it("requests only the nine Insights properties the detectors use", async () => {
    process.env["ACTIVEPROSPECT_API_KEY"] = "test-key";
    let sent: Record<string, any> = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({}),
        text: async () => "",
      };
    });

    await claim_certificate(`https://cert.trustedform.com/${"a".repeat(40)}`);

    expect([...sent.insights.properties].sort()).toEqual(
      [
        "age_seconds",
        "approx_ip_geo",
        "bot_detected",
        "form_input_kpm",
        "form_input_method",
        "form_input_wpm",
        "os",
        "page_url",
        "seconds_on_page",
      ].sort(),
    );
    expect(sent.verify).toBeDefined();
    expect(sent.insights.scans.required.length).toBeGreaterThan(0);
  });
});
