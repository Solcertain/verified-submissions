import { describe, it, expect, vi, beforeEach } from "vitest";

// Key auth and customer scoping, end to end through the routes. The database
// edges are mocked; what is under test is which customer each request resolves
// to and that nothing crosses from one customer to another.
vi.mock("../services/customer_store.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/customer_store.js")>();
  return {
    ...actual,
    find_customer_by_api_key: vi.fn(),
    find_customer_by_outcome_token: vi.fn(async () => null),
    get_activeprospect_key: vi.fn(),
    create_manual_customer: vi.fn(async () => "cccccccc-0000-0000-0000-00000000000c"),
  };
});
vi.mock("../services/submission_store.js", () => ({
  save_submission: vi.fn(async () => ({ id: "analysis-1" })),
  get_submission_by_certificate: vi.fn(async () => null),
  leadSubmissionsTable: {},
}));
vi.mock("../services/usage.js", () => ({ record_usage: vi.fn(async () => ({ billable: true })) }));
vi.mock("../services/outcome_store.js", () => ({
  save_outcome: vi.fn(async () => ({ id: "outcome-1", analysis_id: null })),
  normalize_outcome_payload: vi.fn(),
}));
vi.mock("../services/report_store.js", () => ({ load_report_rows: vi.fn(async () => ({ subs: [], outcomes: [] })) }));
vi.mock("../services/google_sheets.js", () => ({
  append_review_row: vi.fn(async () => ({ success: true, row_id: "r1", error: null })),
}));
vi.mock("../services/webhook_dispatcher.js", () => ({
  dispatch_outbound_webhook: vi.fn(async () => ({ success: true })),
}));
vi.mock("../services/trustedform_client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/trustedform_client.js")>();
  return { ...actual, claim_certificate: vi.fn() };
});

import express, { type Express } from "express";
import request from "supertest";
import router from "../routes/index.js";
import {
  DuplicateCustomerError,
  SOLCERTAIN,
  create_manual_customer,
  find_customer_by_api_key,
  find_customer_by_outcome_token,
  get_activeprospect_key,
  type CustomerContext,
} from "../services/customer_store.js";
import { get_submission_by_certificate, save_submission } from "../services/submission_store.js";
import { claim_certificate } from "../services/trustedform_client.js";
import { record_usage } from "../services/usage.js";
import { save_outcome } from "../services/outcome_store.js";
import { load_report_rows } from "../services/report_store.js";
import { append_review_row } from "../services/google_sheets.js";
import { access_refusal } from "../middlewares/api_key.js";
import agent_claim from "./fixtures/botlab/agents/chatgpt_agent_2026-10-16.json";

const INTERNAL = "internal-test-key";
const KEY_A = "vsk_aaaaaaaaaa_customerAsecretcustomerAsecret";
const KEY_B = "vsk_bbbbbbbbbb_customerBsecretcustomerBsecret";
const CERT = `https://cert.trustedform.com/${"c".repeat(40)}`;

function customer(id: string, over: Partial<CustomerContext> = {}): CustomerContext {
  return {
    id,
    name: `Customer ${id}`,
    tier: "starter",
    status: "active",
    internal: false,
    stripe_customer_id: `cus_${id}`,
    past_due_since: null,
    ...over,
  };
}
const A = customer("aaaaaaaa-0000-0000-0000-00000000000a");
const B = customer("bbbbbbbb-0000-0000-0000-00000000000b");

const HUMAN_CLAIM = {
  insights: {
    properties: {
      bot_detected: false,
      form_input_method: ["typing"],
      form_input_kpm: 120,
      form_input_wpm: 30,
      seconds_on_page: 180,
      age_seconds: 5,
      page_url: "https://example.com/form",
      os: { name: "iOS", is_mobile: true },
      approx_ip_geo: { state: "Ohio", country_code: "US" },
    },
  },
  verify: { result: { success: true } },
};

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

const mocked = <T extends (...args: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env["INTERNAL_API_KEY"] = INTERNAL;
  process.env["LP_CALLBACK_TOKEN"] = "lp-token";
  mocked(find_customer_by_api_key).mockImplementation(async (key: string) =>
    key === KEY_A ? A : key === KEY_B ? B : null,
  );
  mocked(get_activeprospect_key).mockImplementation(async (c: CustomerContext) =>
    c.internal ? "solcertain-env-key" : `ap-key-${c.id}`,
  );
  mocked(claim_certificate).mockResolvedValue({ ok: true, status_code: 200, data: HUMAN_CLAIM, error: null });
  mocked(get_submission_by_certificate).mockResolvedValue(null);
  mocked(find_customer_by_outcome_token).mockResolvedValue(null);
});

describe("API key auth", () => {
  it("refuses a request with no key", async () => {
    const res = await request(app()).post("/api/v1/verify").send({ certificate_url: CERT });
    expect(res.status).toBe(401);
    expect(claim_certificate).not.toHaveBeenCalled();
  });

  it("fails closed when INTERNAL_API_KEY is unset (it used to let everything through)", async () => {
    delete process.env["INTERNAL_API_KEY"];
    const pre = await request(app()).post("/api/leadprosper/pre-ping").send({ certificate_url: CERT });
    const legacy = await request(app()).post("/api/score-and-route").set("x-api-key", "anything").send({ certificate_url: CERT });
    expect(pre.status).toBe(401);
    expect(legacy.status).toBe(401);
    expect(claim_certificate).not.toHaveBeenCalled();
  });

  it("still accepts customer keys when INTERNAL_API_KEY is unset", async () => {
    delete process.env["INTERNAL_API_KEY"];
    const res = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.status).toBe(200);
  });

  it("maps INTERNAL_API_KEY to Solcertain without a database lookup", async () => {
    const res = await request(app()).post("/api/leadprosper/pre-ping").set("x-api-key", INTERNAL).send({ certificate_url: CERT });
    expect(res.status).toBe(200);
    expect(find_customer_by_api_key).not.toHaveBeenCalled();
    expect(claim_certificate).toHaveBeenCalledWith(CERT, "solcertain-env-key", expect.anything());
  });

  it("refuses an unknown or malformed customer key", async () => {
    const bad = await request(app()).post("/api/v1/verify").set("x-api-key", "vsk_aaaaaaaaaa_wrongsecretwrongsecretx").send({ certificate_url: CERT });
    const junk = await request(app()).post("/api/v1/verify").set("x-api-key", "not-a-key").send({ certificate_url: CERT });
    expect(bad.status).toBe(401);
    expect(junk.status).toBe(401);
    expect(find_customer_by_api_key).toHaveBeenCalledTimes(1); // junk never reaches the database
  });

  it("keeps customer keys off the legacy Solcertain-only endpoints", async () => {
    const res = await request(app()).post("/api/score-lead").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.status).toBe(403);
    expect(claim_certificate).not.toHaveBeenCalled();
  });

  it("refuses unpaid, lapsed and canceled accounts", async () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(access_refusal(customer("x", { status: "pending_payment" }), now)?.status).toBe(402);
    expect(access_refusal(customer("x", { status: "canceled" }), now)?.status).toBe(403);
    expect(access_refusal(customer("x", { status: "past_due", past_due_since: new Date("2026-11-17T00:00:00Z") }), now)).toBeNull();
    expect(access_refusal(customer("x", { status: "past_due", past_due_since: new Date("2026-11-10T00:00:00Z") }), now)?.status).toBe(402);
    expect(access_refusal(SOLCERTAIN, now)).toBeNull();
  });

  it("answers 402 on verify once the grace period has run out", async () => {
    mocked(find_customer_by_api_key).mockResolvedValueOnce(
      customer("x", { status: "past_due", past_due_since: new Date(Date.now() - 30 * 86_400_000) }),
    );
    const res = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.status).toBe(402);
  });
});

describe("customer scoping", () => {
  it("claims with the calling customer's own ActiveProspect key and scopes the cache to them", async () => {
    await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    await request(app()).post("/api/v1/verify").set("x-api-key", KEY_B).send({ certificate_url: CERT });

    expect(mocked(get_submission_by_certificate).mock.calls.map((c) => c[0])).toEqual([A.id, B.id]);
    expect(mocked(claim_certificate).mock.calls.map((c) => c[1])).toEqual([`ap-key-${A.id}`, `ap-key-${B.id}`]);
    expect(mocked(save_submission).mock.calls.map((c) => c[0].customer_id)).toEqual([A.id, B.id]);
    expect(mocked(record_usage).mock.calls.map((c) => c[0].id)).toEqual([A.id, B.id]);
  });

  it("never serves customer A's cached analysis to customer B", async () => {
    // The store only returns rows for the customer id it is asked about.
    mocked(get_submission_by_certificate).mockImplementation(async (customer_id: string) =>
      customer_id === A.id
        ? { id: "a-row", processed_at: new Date(), raw_payload_json: {}, parsed_submission_json: {}, score_json: {} }
        : null,
    );
    const b = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_B).send({ certificate_url: CERT });
    expect(b.body.cached).toBe(false);
    expect(b.body.analysis_id).toBe("analysis-1");
    expect(claim_certificate).toHaveBeenCalledWith(CERT, `ap-key-${B.id}`, expect.anything());
  });

  it("keeps a customer's leads out of Solcertain's review sheet", async () => {
    mocked(claim_certificate).mockResolvedValue({ ok: true, status_code: 200, data: agent_claim, error: null });
    const res = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.body.status).toBe("review");
    expect(append_review_row).not.toHaveBeenCalled();

    await request(app()).post("/api/score-and-route").set("x-api-key", INTERNAL).send({ certificate_url: CERT });
    expect(append_review_row).toHaveBeenCalledTimes(1);
  });

  it("limits a customer's report to their own leads, whatever they ask for", async () => {
    await request(app()).get(`/api/reports/verification?customer_id=${A.id}`).set("x-api-key", KEY_B);
    expect(mocked(load_report_rows).mock.calls[0]![2]).toBe(B.id);
  });

  it("gives Solcertain its own report by default, and any customer's on request", async () => {
    await request(app()).get("/api/reports/verification").set("x-api-key", INTERNAL);
    await request(app()).get(`/api/reports/verification?customer_id=${A.id}`).set("x-api-key", INTERNAL);
    await request(app()).get("/api/reports/verification?customer_id=all").set("x-api-key", INTERNAL);
    expect(mocked(load_report_rows).mock.calls.map((c) => c[2])).toEqual([SOLCERTAIN.id, A.id, undefined]);
  });

  it("files an outcome under the customer its token belongs to", async () => {
    mocked(find_customer_by_outcome_token).mockImplementation(async (t: string) => (t === "token-a" ? A : null));
    const ok = await request(app()).post("/api/v1/outcomes/token-a").send({ lead_id: "L1", outcome: "returned", reason: "bad phone", email: "x@y.com" });
    const bad = await request(app()).post("/api/v1/outcomes/nope").send({ lead_id: "L1", outcome: "returned" });
    const lp = await request(app()).post("/api/v1/outcomes/lp-token").send({ lead_id: "L2", outcome: "sold" });

    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);
    expect(lp.status).toBe(200);
    const calls = mocked(save_outcome).mock.calls;
    expect(calls.map((c) => c[1])).toEqual([A.id, SOLCERTAIN.id]);
    expect(calls[0]![0]).toMatchObject({ lp_lead_id: "L1", outcome: "returned", return_reason: "bad phone" });
    expect(calls[0]![0].raw).not.toHaveProperty("email");
  });

  it("rejects an outcome value it does not know", async () => {
    mocked(find_customer_by_outcome_token).mockResolvedValue(A);
    const res = await request(app()).post("/api/v1/outcomes/token-a").send({ lead_id: "L1", outcome: "maybe" });
    expect(res.status).toBe(400);
    expect(save_outcome).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/verify response", () => {
  it("returns score, status, flags and reasons for a scored lead", async () => {
    const res = await request(app())
      .post("/api/v1/verify")
      .set("x-api-key", KEY_A)
      .send({ certificate_url: CERT, lead: { email: "a@b.com", state: "OH" }, consent_terms: ["consent"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "approved", action: "accept", cached: false, billable: true });
    expect(typeof res.body.score).toBe("number");
    expect(Array.isArray(res.body.flags)).toBe(true);
    expect(Array.isArray(res.body.reasons)).toBe(true);
    expect(mocked(save_submission).mock.calls[0]![0].raw_payload_json).toMatchObject({ email: "a@b.com", consent_terms: "consent" });
  });

  it("answers 200 review, not billable, when the certificate cannot be claimed", async () => {
    mocked(claim_certificate).mockResolvedValue({ ok: false, status_code: 404, data: {}, error: "gone" });
    const res = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: "review", billable: false });
    expect(record_usage).not.toHaveBeenCalled();
  });

  it("does not count a cache hit", async () => {
    mocked(get_submission_by_certificate).mockResolvedValueOnce({
      id: "row", processed_at: new Date(), raw_payload_json: {}, parsed_submission_json: {}, score_json: {},
    });
    const res = await request(app()).post("/api/v1/verify").set("x-api-key", KEY_A).send({ certificate_url: CERT });
    expect(res.body.cached).toBe(true);
    expect(res.body.billable).toBe(false);
    expect(record_usage).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/customers (hand-onboarded beta)", () => {
  it("is internal-only: a customer key cannot create customers", async () => {
    const res = await request(app()).post("/api/admin/customers").set("x-api-key", KEY_A).send({ name: "X", email: "x@x.com" });
    expect(res.status).toBe(401);
    expect(create_manual_customer).not.toHaveBeenCalled();
  });

  it("creates an active founder-tier customer by default", async () => {
    const res = await request(app())
      .post("/api/admin/customers")
      .set("x-api-key", INTERNAL)
      .send({ name: "Beta Co", email: "ops@beta.example", role: "buyer" });
    expect(res.status).toBe(201);
    expect(res.body.customer_id).toBe("cccccccc-0000-0000-0000-00000000000c");
    expect(create_manual_customer).toHaveBeenCalledWith({ name: "Beta Co", email: "ops@beta.example", role: "buyer", tier: "founder" });
  });

  it("rejects a missing email, an unknown tier and a duplicate", async () => {
    const missing = await request(app()).post("/api/admin/customers").set("x-api-key", INTERNAL).send({ name: "Beta Co" });
    const tier = await request(app()).post("/api/admin/customers").set("x-api-key", INTERNAL).send({ name: "B", email: "b@b.com", tier: "internal" });
    mocked(create_manual_customer).mockRejectedValueOnce(new DuplicateCustomerError("exists"));
    const dup = await request(app()).post("/api/admin/customers").set("x-api-key", INTERNAL).send({ name: "B", email: "b@b.com" });
    expect([missing.status, tier.status, dup.status]).toEqual([400, 400, 409]);
  });
});
