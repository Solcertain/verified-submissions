import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory stand-in for the usage_events table that honours its unique
// (customer_id, certificate_id) index the way Postgres does with
// ON CONFLICT DO NOTHING ... RETURNING: a duplicate returns no row.
const table = new Map<string, { id: string; customer_id: string; certificate_id: string; occurred_at: Date }>();
let next_id = 0;

const fake_db = {
  insert: () => ({
    values: (v: { customer_id: string; certificate_id: string }) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          const key = `${v.customer_id}|${v.certificate_id}`;
          if (table.has(key)) return [];
          const row = { id: `usage-${++next_id}`, customer_id: v.customer_id, certificate_id: v.certificate_id, occurred_at: new Date("2026-11-01T12:00:00Z") };
          table.set(key, row);
          return [row];
        },
      }),
    }),
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => fake_db }));
vi.mock("../services/stripe_client.js", () => ({ stripe_request: vi.fn(async () => ({})) }));

import { record_usage, METER_EVENT_NAME } from "../services/usage.js";
import { stripe_request } from "../services/stripe_client.js";
import { SOLCERTAIN, type CustomerContext } from "../services/customer_store.js";

const A: CustomerContext = {
  id: "cust-a", name: "A", tier: "starter", status: "active", internal: false, stripe_customer_id: "cus_A", past_due_since: null,
};
const B: CustomerContext = { ...A, id: "cust-b", stripe_customer_id: "cus_B" };

beforeEach(() => {
  table.clear();
  vi.clearAllMocks();
  process.env["DATABASE_URL"] = "postgres://unused";
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("usage metering", () => {
  it("bills a certificate once per customer, however often it is scored", async () => {
    expect(await record_usage(A, "cert1", "s1")).toEqual({ billable: true });
    expect(await record_usage(A, "cert1", "s2")).toEqual({ billable: false });
    expect(await record_usage(A, "cert2", "s3")).toEqual({ billable: true });
    await flush();
    expect(stripe_request).toHaveBeenCalledTimes(2);
  });

  it("counts the same certificate separately for two customers", async () => {
    expect((await record_usage(A, "cert1", null)).billable).toBe(true);
    expect((await record_usage(B, "cert1", null)).billable).toBe(true);
    await flush();
    const customers = vi.mocked(stripe_request).mock.calls.map((c) => (c[2] as any).payload.stripe_customer_id);
    expect(customers).toEqual(["cus_A", "cus_B"]);
  });

  it("sends a meter event Stripe can deduplicate on resend", async () => {
    await record_usage(A, "cert1", null);
    await flush();
    expect(stripe_request).toHaveBeenCalledWith("POST", "/billing/meter_events", {
      event_name: METER_EVENT_NAME,
      identifier: "usage-" + next_id,
      timestamp: Math.floor(new Date("2026-11-01T12:00:00Z").getTime() / 1000),
      payload: { stripe_customer_id: "cus_A", value: 1 },
    });
  });

  it("counts Solcertain's own traffic without billing it", async () => {
    expect((await record_usage(SOLCERTAIN, "cert1", null)).billable).toBe(true);
    await flush();
    expect(stripe_request).not.toHaveBeenCalled();
  });

  it("never fails the verification when metering fails", async () => {
    vi.mocked(stripe_request).mockRejectedValueOnce(new Error("stripe down"));
    expect((await record_usage(A, "cert9", null)).billable).toBe(true);
    await flush();
  });
});
