import { describe, it, expect } from "vitest";
import {
  categorize_return_reason,
  fetch_returned_leads,
  to_return_outcome,
  VERIFICATION_CATEGORIES,
  type LpLead,
} from "../services/leadprosper_returns.js";
import { scrub_pii } from "../services/pii.js";

describe("categorize_return_reason", () => {
  it.each([
    ["duplicate lead from Sept 28th", "duplicate"],
    ["Wrong number", "contact_invalid"],
    ["phone disconnected", "contact_invalid"],
    ["Customer said they never filled out a form", "consent_dispute"],
    ["didn't request info, asked to be put on DNC", "consent_dispute"],
    ["Fake name and address", "fraud"],
    ["bot lead", "fraud"],
    ["bad credit", "lead_quality"],
    ["renter, not homeowner", "lead_quality"],
    ["Not interested", "lead_quality"],
    ["", "other"],
    ["see notes", "other"],
  ])("%s → %s", (reason, category) => {
    expect(categorize_return_reason(reason)).toBe(category);
  });

  it("only treats fraud, invalid contact and consent disputes as verification failures", () => {
    expect([...VERIFICATION_CATEGORIES].sort()).toEqual(["consent_dispute", "contact_invalid", "fraud"]);
  });
});

// Shape of a real returned lead from campaign 23668 (personal details omitted).
const returned_lead: LpLead = {
  id: "0Rt7NqEB8J-QmL7XPEUM",
  lead_date_ms: "1791915408396",
  revenue: 90,
  returned: true,
  return_reason: "duplicate lead from Sept 28th",
  lead_data: {
    trustedform_cert_url: "https://cert.trustedform.com/" + "a".repeat(40),
    vs_analysis_id: "2750b945-76e1-40c8-8217-94c23412d80f",
    vs_score: "98",
    vs_model_version: "0.4-insights",
  },
  supplier: { name: "Solcertain - Custom Form" },
  buyers: [
    { name: "Ben - Oasis Energy Solar", sell_price: 0, returned: false, return_reason: "" },
    { name: "Progressive Solar CA - Joe Lopez", sell_price: 90, returned: true, return_reason: "duplicate lead from Sept 28th" },
  ],
};

describe("to_return_outcome", () => {
  const o = to_return_outcome(returned_lead);

  it("records the returning buyer, price and reason", () => {
    expect(o).toMatchObject({
      lp_lead_id: "0Rt7NqEB8J-QmL7XPEUM",
      outcome: "returned",
      buyer: "Progressive Solar CA - Joe Lopez",
      sell_price: "90",
      return_reason: "duplicate lead from Sept 28th",
      supplier: "Solcertain - Custom Form",
    });
  });

  it("categorises the reason and keeps what the engine said at the time", () => {
    expect(o.raw).toMatchObject({
      return_category: "duplicate",
      bears_on_verification: false,
      vs_score: "98",
      vs_model_version: "0.4-insights",
    });
  });
});

describe("fetch_returned_leads", () => {
  it("pages through every result and keeps only returned leads", async () => {
    const pages = [
      { leads: [returned_lead, { id: "x1", returned: false }], search_after: "cursor-1" },
      { leads: [{ ...returned_lead, id: "r2" }], search_after: null },
    ];
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => pages[urls.length - 1] };
    }) as unknown as typeof fetch;

    const leads = await fetch_returned_leads(
      { campaign: "23668", start_date: "2026-10-01", end_date: "2026-10-17" },
      "test-key",
      fake,
    );
    expect(leads.map((l) => l.id)).toEqual(["0Rt7NqEB8J-QmL7XPEUM", "r2"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("search_after=cursor-1");
    expect(urls[0]).toContain("campaign=23668");
  });

  it("surfaces an API error instead of reporting zero returns", async () => {
    const fake = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(
      fetch_returned_leads({ campaign: "23668", start_date: "a", end_date: "b" }, "bad", fake),
    ).rejects.toThrow("401");
  });
});

describe("scrub_pii", () => {
  it("drops consumer details, including nested ones, and keeps ids and scores", () => {
    const out = scrub_pii({
      lp_lead_id: "abc",
      first_name: "Pat",
      email: "pat@example.com",
      phone: "+14125550100",
      address: "1 Main St",
      vs_score: "95",
      lead_data: { last_name: "Lee", zip_code: "15473", trustedform_cert_url: "https://cert.trustedform.com/x" },
      supplier: { name: "Solcertain - Custom Form" },
    });
    expect(out).toEqual({
      lp_lead_id: "abc",
      vs_score: "95",
      lead_data: { trustedform_cert_url: "https://cert.trustedform.com/x" },
      supplier: { name: "Solcertain - Custom Form" },
    });
  });
});
