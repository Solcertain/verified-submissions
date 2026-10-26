import { describe, it, expect, vi, beforeEach } from "vitest";

// Stripe is mocked at the request boundary (stripe_request); signature checks,
// tier rules, the top-up arithmetic and the webhook mount are real.
vi.mock("../services/stripe_client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/stripe_client.js")>();
  return { ...actual, stripe_request: vi.fn(async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/cs_test_1" })) };
});
vi.mock("../services/customer_store.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/customer_store.js")>();
  return {
    ...actual,
    customer_exists_for_email: vi.fn(async () => false),
    create_paid_customer: vi.fn(async () => ({ created: true, customer_id: "cust-1", set_password_token: "setpw" })),
    find_customer_by_stripe: vi.fn(),
    set_customer_status: vi.fn(async () => undefined),
    list_user_emails: vi.fn(async () => ["owner@acme.com"]),
  };
});
vi.mock("../services/email.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/email.js")>();
  return { ...actual, send_email: vi.fn(async () => ({ sent: true, id: "e1", error: null })) };
});

import request from "supertest";
import app from "../app.js";
import { stripe_request, sign_stripe_payload, verify_stripe_signature, encode_form } from "../services/stripe_client.js";
import {
  create_paid_customer,
  customer_exists_for_email,
  find_customer_by_stripe,
  set_customer_status,
} from "../services/customer_store.js";
import { send_email } from "../services/email.js";
import { apply_minimum_topup, create_invite_token, status_for_subscription } from "../services/billing.js";
import { compute_minimum_topup } from "../services/usage.js";
import { sign_token } from "../lib/crypto.js";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const WEBHOOK_SECRET = "whsec_test";

beforeEach(() => {
  vi.clearAllMocks();
  process.env["INVITE_SIGNING_SECRET"] = "invite-secret";
  process.env["STRIPE_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  process.env["STRIPE_PRICE_STARTER"] = "price_starter";
  process.env["STRIPE_PRICE_GROWTH"] = "price_growth";
  process.env["STRIPE_PRICE_FOUNDER"] = "price_founder";
  process.env["PORTAL_URL"] = "https://portal.example.com";
});

describe("minimum top-up math", () => {
  it("charges the shortfall below the minimum, and nothing at or above it", () => {
    expect(compute_minimum_topup(50_000, 12_000)).toBe(38_000); // Starter, 800 leads at $0.15
    expect(compute_minimum_topup(50_000, 0)).toBe(50_000);
    expect(compute_minimum_topup(50_000, 50_000)).toBe(0);
    expect(compute_minimum_topup(200_000, 312_000)).toBe(0); // Growth, 26,000 leads at $0.12
    expect(compute_minimum_topup(0, 100)).toBe(0); // Founder: no minimum
  });

  it("never goes negative or NaN on odd input", () => {
    expect(compute_minimum_topup(50_000, -500)).toBe(50_000);
    expect(compute_minimum_topup(50_000, Number.NaN)).toBe(50_000);
    expect(compute_minimum_topup(Number.NaN, 10)).toBe(0);
  });
});

describe("apply_minimum_topup (invoice.created)", () => {
  const starter = { id: "cust-1", name: "Acme", tier: "starter", status: "active", internal: false, stripe_customer_id: "cus_1", past_due_since: null, monthly_minimum_cents: 50_000 };
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: "in_1",
    customer: "cus_1",
    billing_reason: "subscription_cycle",
    status: "draft",
    currency: "usd",
    subtotal: 12_000,
    parent: { subscription_details: { subscription: "sub_1" } },
    lines: { data: [{ amount: 12_000, metadata: {} }] },
    ...over,
  });

  it("adds one top-up line for the shortfall, idempotently keyed to the invoice", async () => {
    mocked(find_customer_by_stripe).mockResolvedValue(starter);
    const result = await apply_minimum_topup(invoice());
    expect(result).toBe("top-up added: 38000");
    expect(find_customer_by_stripe).toHaveBeenCalledWith({ subscription: "sub_1", customer: "cus_1" });
    expect(stripe_request).toHaveBeenCalledWith(
      "POST",
      "/invoiceitems",
      expect.objectContaining({ invoice: "in_1", customer: "cus_1", amount: 38_000, currency: "usd", metadata: { vs_minimum_topup: "1" } }),
      { idempotency_key: "vs-topup-in_1" },
    );
  });

  it("skips when usage met the minimum, for founders, and when already added", async () => {
    mocked(find_customer_by_stripe).mockResolvedValue(starter);
    expect(await apply_minimum_topup(invoice({ subtotal: 60_000 }))).toMatch(/usage met/);
    expect(await apply_minimum_topup(invoice({ lines: { data: [{ metadata: { vs_minimum_topup: "1" } }] } }))).toMatch(/already/);
    mocked(find_customer_by_stripe).mockResolvedValue({ ...starter, tier: "founder", monthly_minimum_cents: 0 });
    expect(await apply_minimum_topup(invoice())).toMatch(/usage met/);
    expect(stripe_request).not.toHaveBeenCalled();
  });

  it("leaves the signup invoice and finalized invoices alone", async () => {
    mocked(find_customer_by_stripe).mockResolvedValue(starter);
    expect(await apply_minimum_topup(invoice({ billing_reason: "subscription_create" }))).toMatch(/not a renewal/);
    expect(await apply_minimum_topup(invoice({ status: "open" }))).toMatch(/not a draft/);
    expect(stripe_request).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/checkout", () => {
  it("creates a metered subscription Checkout Session for the chosen tier", async () => {
    const token = create_invite_token({ email: "owner@acme.com", company: "Acme", role: "buyer" });
    const res = await request(app).post("/api/billing/checkout").send({ invite_token: token, tier: "growth" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, url: "https://checkout.stripe.com/c/cs_test_1", tier: "growth" });
    const [, path, params] = mocked(stripe_request).mock.calls[0]!;
    expect(path).toBe("/checkout/sessions");
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_growth" }],
      customer_email: "owner@acme.com",
      metadata: { tier: "growth", invite_email: "owner@acme.com", name: "Acme", role: "buyer" },
    });
    expect(params.success_url).toContain("https://portal.example.com/join/success?t=");
  });

  it("puts founders on the founder price whatever tier they pick, and nobody else", async () => {
    const founder = create_invite_token({ email: "f@x.com", founder: true });
    const res = await request(app).post("/api/billing/checkout").send({ invite_token: founder, tier: "starter" });
    expect(res.body.tier).toBe("founder");
    expect(mocked(stripe_request).mock.calls[0]![2].line_items).toEqual([{ price: "price_founder" }]);

    const regular = create_invite_token({ email: "r@x.com" });
    const denied = await request(app).post("/api/billing/checkout").send({ invite_token: regular, tier: "founder" });
    expect(denied.status).toBe(400);
  });

  it("sends enterprise to sales, and refuses bad, expired or reused invites", async () => {
    const token = create_invite_token({ email: "e@x.com" });
    expect((await request(app).post("/api/billing/checkout").send({ invite_token: token, tier: "enterprise" })).status).toBe(400);
    expect((await request(app).post("/api/billing/checkout").send({ invite_token: token + "x", tier: "starter" })).status).toBe(401);

    const expired = sign_token({ email: "e@x.com", exp: Math.floor(Date.now() / 1000) - 60 }, "invite-secret");
    expect((await request(app).post("/api/billing/checkout").send({ invite_token: expired, tier: "starter" })).status).toBe(401);

    mocked(customer_exists_for_email).mockResolvedValueOnce(true);
    expect((await request(app).post("/api/billing/checkout").send({ invite_token: token, tier: "starter" })).status).toBe(409);
    expect(stripe_request).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/webhook", () => {
  function post(event: unknown, secret = WEBHOOK_SECRET) {
    const body = JSON.stringify(event);
    return request(app)
      .post("/api/stripe/webhook")
      .set("content-type", "application/json")
      .set("stripe-signature", sign_stripe_payload(body, secret))
      .send(body);
  }

  const completed = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        mode: "subscription",
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { tier: "starter", invite_email: "owner@acme.com", name: "Acme", role: "seller" },
      },
    },
  };

  it("verifies the signature over the raw body before express.json touches it", async () => {
    const res = await post(completed);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("customer created");
    expect(create_paid_customer).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "starter",
        monthly_minimum_cents: 50_000,
        email: "owner@acme.com",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
      }),
    );
    expect(mocked(send_email).mock.calls[0]![0]).toMatchObject({ to: "owner@acme.com", subject: expect.stringMatching(/password/i) });
  });

  it("rejects a bad signature and does nothing", async () => {
    const res = await post(completed, "whsec_wrong");
    expect(res.status).toBe(400);
    expect(create_paid_customer).not.toHaveBeenCalled();
  });

  it("does not create or email twice when Stripe redelivers", async () => {
    mocked(create_paid_customer).mockResolvedValueOnce({ created: false, customer_id: "cust-1", set_password_token: null });
    const res = await post(completed);
    expect(res.body.result).toMatch(/duplicate/);
    expect(send_email).not.toHaveBeenCalled();
  });

  it("marks the customer past due on a failed payment, emailing only the first time", async () => {
    const c = { id: "cust-1", name: "Acme", tier: "starter", status: "active", internal: false, stripe_customer_id: "cus_1", past_due_since: null, monthly_minimum_cents: 50_000 };
    mocked(find_customer_by_stripe).mockResolvedValueOnce(c).mockResolvedValueOnce({ ...c, status: "past_due" });
    const failed = { id: "evt_2", type: "invoice.payment_failed", data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1" } } };
    await post(failed);
    await post(failed);
    expect(mocked(set_customer_status).mock.calls).toEqual([["cust-1", "past_due"], ["cust-1", "past_due"]]);
    expect(send_email).toHaveBeenCalledTimes(1);
  });

  it("follows subscription status and plan changes", async () => {
    const c = { id: "cust-1", name: "Acme", tier: "starter", status: "past_due", internal: false, stripe_customer_id: "cus_1", past_due_since: new Date(), monthly_minimum_cents: 50_000 };
    mocked(find_customer_by_stripe).mockResolvedValue(c);
    await post({ id: "e", type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active", items: { data: [{ price: { id: "price_growth" } }] } } } });
    await post({ id: "e", type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled" } } });
    expect(mocked(set_customer_status).mock.calls).toEqual([
      ["cust-1", "active", { tier: "growth", monthly_minimum_cents: 200_000 }],
      ["cust-1", "canceled", {}],
    ]);
    expect(status_for_subscription("unpaid")).toBe("past_due");
    expect(status_for_subscription("incomplete_expired")).toBe("canceled");
  });

  it("refuses everything when the webhook secret is not configured", async () => {
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    const res = await post(completed);
    expect(res.status).toBe(503);
  });
});

describe("stripe_client helpers", () => {
  it("rejects a stale signature", () => {
    const body = "{}";
    const old = sign_stripe_payload(body, "s", 1_000);
    expect(verify_stripe_signature(body, old, "s", 300, 1_100)).toBe(true);
    expect(verify_stripe_signature(body, old, "s", 300, 2_000)).toBe(false);
  });

  it("form-encodes nested params the way Stripe expects", () => {
    expect(encode_form({ line_items: [{ price: "p" }], metadata: { a: "1" }, skip: undefined }).join("&")).toBe(
      "line_items%5B0%5D%5Bprice%5D=p&metadata%5Ba%5D=1",
    );
  });
});
