import { describe, it, expect, vi, beforeEach } from "vitest";

// The customer portal through its routes: sign-in, the session cookie, scoping
// every read and write to the signed-in customer, and the page shell. Database
// edges are mocked.
vi.mock("../services/portal_auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/portal_auth.js")>();
  return {
    ...actual,
    login: vi.fn(),
    create_session: vi.fn(async () => "session-token"),
    resolve_session: vi.fn(),
    delete_session: vi.fn(async () => undefined),
    set_password_with_token: vi.fn(),
    request_password_reset: vi.fn(),
    issue_password_token: vi.fn(),
  };
});
vi.mock("../services/customer_store.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/customer_store.js")>();
  return {
    ...actual,
    get_customer: vi.fn(async (id: string) => (id === A.id ? A : null)),
    create_api_key: vi.fn(async () => ({ id: "k-new", key: "vsk_0123456789_newsecretnewsecretnewsecret", prefix: "vsk_0123456789" })),
    revoke_api_key: vi.fn(async () => true),
    create_outcome_token: vi.fn(async () => "outcome-secret"),
    revoke_outcome_token: vi.fn(async () => true),
    list_api_keys: vi.fn(async () => [
      { id: "k1", prefix: "vsk_aaaaaaaaaa", label: "LP", created_at: new Date("2026-10-20"), last_used_at: null, revoked_at: null },
    ]),
    list_outcome_tokens: vi.fn(async () => []),
    has_activeprospect_key: vi.fn(async () => false),
    set_activeprospect_key: vi.fn(async () => undefined),
    find_customer_id_by_email: vi.fn(async () => null),
    create_manual_customer: vi.fn(async () => "cccccccc-0000-0000-0000-00000000000c"),
  };
});
vi.mock("../services/report_store.js", () => ({ load_report_rows: vi.fn(async () => ({ subs: [], outcomes: [] })) }));
vi.mock("../services/email.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/email.js")>();
  return { ...actual, send_email: vi.fn(async () => ({ sent: true, id: "e1", error: null })) };
});

import express, { type Express } from "express";
import request from "supertest";
import router from "../routes/index.js";
import portalPages from "../routes/portal_pages.js";
import { portal_activity } from "../routes/portal.js";
import {
  issue_password_token,
  login,
  request_password_reset,
  resolve_session,
  set_password_with_token,
} from "../services/portal_auth.js";
import {
  create_api_key,
  create_manual_customer,
  find_customer_id_by_email,
  list_api_keys,
  revoke_api_key,
  set_activeprospect_key,
  type CustomerContext,
} from "../services/customer_store.js";
import { load_report_rows } from "../services/report_store.js";
import { send_email } from "../services/email.js";
import type { ReportSubmission } from "../services/verification_report.js";

const A: CustomerContext = {
  id: "aaaaaaaa-0000-0000-0000-00000000000a",
  name: "Acme Leads",
  tier: "founder",
  status: "active",
  internal: false,
  stripe_customer_id: null,
  past_due_since: null,
};
const COOKIE = "vs_session=good-session";
const INTERNAL = "internal-test-key";

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  a.use("/portal", portalPages);
  return a;
}

const mocked = <T extends (...args: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env["INTERNAL_API_KEY"] = INTERNAL;
  mocked(resolve_session).mockImplementation(async (token: string) =>
    token === "good-session" ? { user_id: "u1", email: "ops@acme.example", customer: A } : null,
  );
});

describe("portal sign-in", () => {
  it("sets an httpOnly, Secure, SameSite=Strict session cookie on a good password", async () => {
    mocked(login).mockResolvedValue({ ok: true, user_id: "u1", customer_id: A.id });
    const res = await request(app()).post("/api/portal/login").set("host", "portal.example").send({ email: "ops@acme.example", password: "correct horse" });
    expect(res.status).toBe(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("vs_session=session-token");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("answers a wrong password with 401 and no cookie, and a lockout with 403", async () => {
    mocked(login).mockResolvedValueOnce({ ok: false, reason: "invalid" });
    const bad = await request(app()).post("/api/portal/login").send({ email: "ops@acme.example", password: "nope" });
    mocked(login).mockResolvedValueOnce({ ok: false, reason: "locked" });
    const locked = await request(app()).post("/api/portal/login").send({ email: "ops@acme.example", password: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(locked.status).toBe(403);
    expect(locked.body.error).toMatch(/15 minutes/);
  });

  it("refuses a sign-in posted from another site", async () => {
    const res = await request(app())
      .post("/api/portal/login")
      .set("host", "portal.example")
      .set("origin", "https://evil.example")
      .send({ email: "ops@acme.example", password: "x" });
    expect(res.status).toBe(403);
    expect(login).not.toHaveBeenCalled();
  });

  it("sets a password from a valid link and signs the user in", async () => {
    mocked(set_password_with_token).mockResolvedValue({ user_id: "u1", customer_id: A.id });
    const short = await request(app()).post("/api/portal/set-password").send({ token: "t", password: "short" });
    const ok = await request(app()).post("/api/portal/set-password").send({ token: "t", password: "long enough pw" });
    mocked(set_password_with_token).mockResolvedValue(null);
    const expired = await request(app()).post("/api/portal/set-password").send({ token: "old", password: "long enough pw" });
    expect(short.status).toBe(400);
    expect(ok.status).toBe(200);
    expect(String(ok.headers["set-cookie"])).toContain("vs_session=session-token");
    expect(expired.status).toBe(400);
  });

  it("answers forgot-password the same whether or not the account exists", async () => {
    mocked(request_password_reset).mockResolvedValueOnce("reset-token").mockResolvedValueOnce(null);
    const known = await request(app()).post("/api/portal/forgot").send({ email: "ops@acme.example" });
    const unknown = await request(app()).post("/api/portal/forgot").send({ email: "nobody@x.example" });
    expect(known.body).toEqual(unknown.body);
    expect(send_email).toHaveBeenCalledTimes(1);
  });
});

describe("signed-in portal", () => {
  it("refuses every account route without a session", async () => {
    const me = await request(app()).get("/api/portal/me");
    const dash = await request(app()).get("/api/portal/dashboard");
    const key = await request(app()).post("/api/portal/api-keys").send({});
    expect([me.status, dash.status, key.status]).toEqual([401, 401, 401]);
    expect(create_api_key).not.toHaveBeenCalled();
  });

  it("does not accept an API key in place of a session", async () => {
    const res = await request(app()).get("/api/portal/me").set("x-api-key", INTERNAL);
    expect(res.status).toBe(401);
  });

  it("shows the account without any secret", async () => {
    const res = await request(app()).get("/api/portal/me").set("cookie", COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.customer.name).toBe("Acme Leads");
    expect(res.body.api_keys[0]).toMatchObject({ prefix: "vsk_aaaaaaaaaa", label: "LP" });
    expect(JSON.stringify(res.body)).not.toMatch(/key_hash|token_hash|encrypted/);
    expect(list_api_keys).toHaveBeenCalledWith(A.id);
  });

  it("creates, revokes and stores keys for the signed-in customer only", async () => {
    const created = await request(app()).post("/api/portal/api-keys").set("cookie", COOKIE).send({ label: "LP" });
    await request(app()).delete("/api/portal/api-keys/k1").set("cookie", COOKIE);
    await request(app()).put("/api/portal/activeprospect-key").set("cookie", COOKIE).send({ key: "ap-secret" });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^vsk_/);
    expect(create_api_key).toHaveBeenCalledWith(A.id, "LP");
    expect(revoke_api_key).toHaveBeenCalledWith(A.id, "k1");
    expect(set_activeprospect_key).toHaveBeenCalledWith(A.id, "ap-secret");
  });

  it("returns the outcome URL once, on this host", async () => {
    const res = await request(app()).post("/api/portal/outcome-tokens").set("host", "portal.example").set("cookie", COOKIE).send({});
    expect(res.body.url).toBe("https://portal.example/api/v1/outcomes/outcome-secret");
  });

  it("builds the dashboard from the signed-in customer's leads only", async () => {
    const res = await request(app()).get("/api/portal/dashboard?days=30").set("cookie", COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(mocked(load_report_rows).mock.calls[0]![2]).toBe(A.id);
  });

  it("signs out by deleting the session and clearing the cookie", async () => {
    const res = await request(app()).post("/api/portal/logout").set("cookie", COOKIE).send({});
    expect(String(res.headers["set-cookie"])).toMatch(/vs_session=;.*Max-Age=0/);
  });
});

describe("portal activity", () => {
  function sub(id: string, iso: string, status: string): ReportSubmission {
    return {
      id, received_at: new Date(iso), score: 90, status, classification: null, model_version: "0.4-insights",
      consent_verdict: null, risk_flags: [], shadow_flags: [], source: "site.example", is_mobile: true, certificate_id: `cert-${id}`,
    };
  }

  it("lists newest first and counts each day in the period", () => {
    const start = new Date("2026-10-20T00:00:00Z");
    const end = new Date("2026-10-23T00:00:00Z");
    const { recent, daily } = portal_activity(
      [sub("a", "2026-10-20T10:00:00Z", "approved"), sub("b", "2026-10-22T09:00:00Z", "review"), sub("c", "2026-10-22T11:00:00Z", "approved")],
      start,
      end,
    );
    expect(recent.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(recent[0]!.certificate_id).toBe("cert-c");
    expect(daily).toEqual([
      { date: "2026-10-20", approved: 1, review: 0, reject: 0 },
      { date: "2026-10-21", approved: 0, review: 0, reject: 0 },
      { date: "2026-10-22", approved: 1, review: 1, reject: 0 },
    ]);
  });

  it("includes today when the period does not start at midnight", () => {
    const end = new Date("2026-10-29T11:00:00Z");
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const { daily } = portal_activity([sub("t", "2026-10-29T10:30:00Z", "approved")], start, end);
    expect(daily[0]!.date).toBe("2026-10-22");
    expect(daily.at(-1)).toEqual({ date: "2026-10-29", approved: 1, review: 0, reject: 0 });
  });
});

describe("portal pages and admin link", () => {
  it("serves the page shell with a strict CSP on every portal path", async () => {
    for (const path of ["/portal", "/portal/login", "/portal/set-password?t=abc"]) {
      const res = await request(app()).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<script src="/portal/app.js">');
      expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const js = await request(app()).get("/portal/app.js");
    expect(js.headers["content-type"]).toMatch(/javascript/);
    const theme = await request(app()).get("/portal/theme.js");
    expect(theme.text).toContain("vs.portal.theme");
    for (const logo of ["/portal/brand/logo-light.svg", "/portal/brand/logo-dark.svg", "/portal/brand/mark.svg"]) {
      const res = await request(app()).get(logo);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/);
    }
  });

  it("issues a set-password link to the internal key only", async () => {
    mocked(issue_password_token).mockResolvedValue({ token: "tok", email: "ops@acme.example" });
    const denied = await request(app()).post(`/api/admin/customers/${A.id}/password-link`).set("cookie", COOKIE).send({});
    const ok = await request(app()).post(`/api/admin/customers/${A.id}/password-link`).set("x-api-key", INTERNAL).send({});
    expect(denied.status).toBe(401);
    expect(ok.status).toBe(201);
    expect(ok.body.link).toMatch(/\/portal\/set-password\?t=tok$/);
  });
});

describe("POST /api/admin/onboard (waitlist Approve)", () => {
  beforeEach(() => {
    mocked(issue_password_token).mockResolvedValue({ token: "tok", email: "ops@new.example" });
  });

  it("is internal-only", async () => {
    const res = await request(app()).post("/api/admin/onboard").set("cookie", COOKIE).send({ email: "ops@new.example" });
    expect(res.status).toBe(401);
    expect(create_manual_customer).not.toHaveBeenCalled();
  });

  it("creates a founder-tier customer for a founder and returns a portal link", async () => {
    const res = await request(app())
      .post("/api/admin/onboard")
      .set("x-api-key", INTERNAL)
      .send({ email: "OPS@New.example", name: "Pat", company: "New Leads Co", role: "buyer", founder: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, created: true, customer_id: "cccccccc-0000-0000-0000-00000000000c" });
    expect(res.body.link).toMatch(/\/portal\/set-password\?t=tok$/);
    expect(create_manual_customer).toHaveBeenCalledWith({ name: "New Leads Co", email: "ops@new.example", role: "buyer", tier: "founder" });
  });

  it("gives everyone else the starter tier", async () => {
    await request(app()).post("/api/admin/onboard").set("x-api-key", INTERNAL).send({ email: "a@b.example" });
    expect(mocked(create_manual_customer).mock.calls[0]![0]).toMatchObject({ name: "a@b.example", tier: "starter", role: "seller" });
  });

  it("reuses an existing customer and only issues a new link (Re-send invite)", async () => {
    mocked(find_customer_id_by_email).mockResolvedValueOnce(A.id);
    const res = await request(app()).post("/api/admin/onboard").set("x-api-key", INTERNAL).send({ email: "ops@acme.example" });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(create_manual_customer).not.toHaveBeenCalled();
    expect(issue_password_token).toHaveBeenCalledWith(A.id, expect.any(Number), "ops@acme.example");
  });

  it("rejects a missing or malformed email", async () => {
    const res = await request(app()).post("/api/admin/onboard").set("x-api-key", INTERNAL).send({ email: "nope" });
    expect(res.status).toBe(400);
  });
});
