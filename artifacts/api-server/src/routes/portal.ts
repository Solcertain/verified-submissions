import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_MS,
  create_session,
  delete_session,
  login,
  request_password_reset,
  resolve_session,
  set_password_with_token,
  type PortalSession,
} from "../services/portal_auth.js";
import {
  create_api_key,
  create_outcome_token,
  has_activeprospect_key,
  list_api_keys,
  list_outcome_tokens,
  revoke_api_key,
  revoke_outcome_token,
  set_activeprospect_key,
} from "../services/customer_store.js";
import { load_report_rows } from "../services/report_store.js";
import { build_report, type ReportSubmission } from "../services/verification_report.js";
import { password_reset_email, send_email } from "../services/email.js";

// The customer portal's JSON API, under /api/portal. Signed-in requests carry
// an httpOnly, SameSite=Strict session cookie; nothing here accepts an API key,
// and nothing returns a secret except once, at creation.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portal?: PortalSession;
    }
  }
}

export const SESSION_COOKIE = "vs_session";

const router = Router();

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function read_cookie(req: Request, name: string): string {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

// Secure everywhere except plain-http local development.
function is_local(req: Request): boolean {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.header("host") ?? "");
}

function set_session_cookie(req: Request, res: Response, token: string): void {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${is_local(req) ? "" : "; Secure"}`,
  );
}

function clear_session_cookie(req: Request, res: Response): void {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${is_local(req) ? "" : "; Secure"}`);
}

function origin_of(req: Request): string {
  const proto = is_local(req) ? "http" : "https";
  return `${proto}://${req.header("host")}`;
}

// Refuses state-changing requests sent from another site. SameSite=Strict
// already keeps the cookie off them; this is the second lock.
function same_origin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (req.method !== "GET" && origin && origin !== origin_of(req)) {
    res.status(403).json({ ok: false, error: "Cross-site request refused" });
    return;
  }
  next();
}

async function require_session(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await resolve_session(read_cookie(req, SESSION_COOKIE));
    if (!session) {
      res.status(401).json({ ok: false, error: "Sign in to continue" });
      return;
    }
    req.portal = session;
    next();
  } catch (err) {
    logger.error({ err }, "Session lookup failed");
    res.status(500).json({ ok: false, error: "Something went wrong" });
  }
}

router.use("/portal", same_origin);

// ── Sign-in ─────────────────────────────────────────────────────────────────

router.post("/portal/login", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = str(body["email"]);
  const password = typeof body["password"] === "string" ? body["password"] : "";
  if (!email || !password) {
    res.status(400).json({ ok: false, error: "Enter your email and password" });
    return;
  }
  try {
    const result = await login(email, password);
    if (!result.ok) {
      const error =
        result.reason === "locked"
          ? "Too many attempts. Try again in 15 minutes, or reset your password."
          : result.reason === "canceled"
            ? "This account is canceled."
            : "That email and password don't match.";
      res.status(result.reason === "invalid" ? 401 : 403).json({ ok: false, error });
      return;
    }
    set_session_cookie(req, res, await create_session(result.user_id, result.customer_id));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Login failed");
    res.status(500).json({ ok: false, error: "Something went wrong" });
  }
});

router.post("/portal/logout", async (req: Request, res: Response) => {
  await delete_session(read_cookie(req, SESSION_COOKIE)).catch((err: unknown) => logger.warn({ err }, "Logout failed"));
  clear_session_cookie(req, res);
  res.json({ ok: true });
});

// Set a password from an emailed or hand-delivered link, then sign in.
router.post("/portal/set-password", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = str(body["token"]) ?? "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  try {
    const user = await set_password_with_token(token, password);
    if (!user) {
      res.status(400).json({ ok: false, error: "This link has expired or was already used. Ask for a new one." });
      return;
    }
    set_session_cookie(req, res, await create_session(user.user_id, user.customer_id));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Set password failed");
    res.status(500).json({ ok: false, error: "Something went wrong" });
  }
});

// Always answers the same, so it cannot be used to find out who has an account.
router.post("/portal/forgot", async (req: Request, res: Response) => {
  const email = str(((req.body ?? {}) as Record<string, unknown>)["email"]);
  if (email && email.includes("@")) {
    try {
      const token = await request_password_reset(email);
      if (token) await send_email({ to: email, ...password_reset_email({ token }) });
    } catch (err) {
      logger.error({ err }, "Password reset request failed");
    }
  }
  res.json({ ok: true });
});

// ── Account ─────────────────────────────────────────────────────────────────

router.get("/portal/me", require_session, async (req: Request, res: Response) => {
  const { customer, email } = req.portal!;
  const [keys, tokens, ap] = await Promise.all([
    list_api_keys(customer.id),
    list_outcome_tokens(customer.id),
    has_activeprospect_key(customer.id),
  ]);
  const base = origin_of(req);
  res.json({
    ok: true,
    email,
    customer: { name: customer.name, tier: customer.tier, status: customer.status },
    activeprospect_key_set: ap,
    verify_url: `${base}/api/v1/verify`,
    outcome_url_base: `${base}/api/v1/outcomes/`,
    api_keys: keys,
    outcome_tokens: tokens,
  });
});

router.post("/portal/api-keys", require_session, async (req: Request, res: Response) => {
  const label = str(((req.body ?? {}) as Record<string, unknown>)["label"])?.slice(0, 60);
  const key = await create_api_key(req.portal!.customer.id, label);
  res.status(201).json({ ok: true, ...key });
});

router.delete("/portal/api-keys/:id", require_session, async (req: Request, res: Response) => {
  const revoked = await revoke_api_key(req.portal!.customer.id, String(req.params["id"]));
  res.status(revoked ? 200 : 404).json({ ok: revoked });
});

router.post("/portal/outcome-tokens", require_session, async (req: Request, res: Response) => {
  const label = str(((req.body ?? {}) as Record<string, unknown>)["label"])?.slice(0, 60);
  const token = await create_outcome_token(req.portal!.customer.id, label);
  res.status(201).json({ ok: true, url: `${origin_of(req)}/api/v1/outcomes/${token}` });
});

router.delete("/portal/outcome-tokens/:id", require_session, async (req: Request, res: Response) => {
  const revoked = await revoke_outcome_token(req.portal!.customer.id, String(req.params["id"]));
  res.status(revoked ? 200 : 404).json({ ok: revoked });
});

router.put("/portal/activeprospect-key", require_session, async (req: Request, res: Response) => {
  const key = str(((req.body ?? {}) as Record<string, unknown>)["key"]);
  if (!key) {
    res.status(400).json({ ok: false, error: "Paste your ActiveProspect API key" });
    return;
  }
  try {
    await set_activeprospect_key(req.portal!.customer.id, key);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Could not store ActiveProspect key");
    res.status(503).json({ ok: false, error: "We couldn't save the key just now. Contact us and we'll set it up." });
  }
});

// ── Dashboard ───────────────────────────────────────────────────────────────

export interface RecentLead {
  id: string;
  certificate_id: string | null;
  received_at: string;
  score: number | null;
  status: string | null;
  flags: string[];
  source: string;
}

// The newest leads and a per-day count, from the same rows as the report.
export function portal_activity(subs: ReportSubmission[], start: Date, end: Date, limit = 50) {
  const recent: RecentLead[] = [...subs]
    .sort((a, b) => b.received_at.getTime() - a.received_at.getTime())
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      certificate_id: s.certificate_id ?? null,
      received_at: s.received_at.toISOString(),
      score: s.score,
      status: s.status,
      flags: s.risk_flags,
      source: s.source,
    }));
  // One bucket per UTC calendar day the period touches, today included.
  const days: Record<string, { approved: number; review: number; reject: number }> = {};
  const first_day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let t = first_day; t < end.getTime(); t += 86_400_000) {
    days[new Date(t).toISOString().slice(0, 10)] = { approved: 0, review: 0, reject: 0 };
  }
  for (const s of subs) {
    const day = days[s.received_at.toISOString().slice(0, 10)];
    if (day && (s.status === "approved" || s.status === "review" || s.status === "reject")) day[s.status]++;
  }
  return { recent, daily: Object.entries(days).map(([date, c]) => ({ date, ...c })) };
}

router.get("/portal/dashboard", require_session, async (req: Request, res: Response) => {
  const days = Number(req.query["days"]) === 30 ? 30 : 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  try {
    const { subs, outcomes } = await load_report_rows(start, end, req.portal!.customer.id);
    const report = build_report(subs, outcomes, { start, end });
    res.json({
      ok: true,
      days,
      scored: report.leads.scored,
      by_status: report.leads.by_status,
      consent_verified: report.leads.consent_verified,
      risk_flags: report.risk_flags,
      by_source: report.leads.by_source,
      outcomes: {
        sold: report.outcomes.sold,
        unsold: report.outcomes.unsold,
        returned: report.outcomes.returned,
      },
      ...portal_activity(subs, start, end),
    });
  } catch (err) {
    logger.error({ err }, "Portal dashboard failed");
    res.status(500).json({ ok: false, error: "Couldn't load your activity" });
  }
});

export default router;
