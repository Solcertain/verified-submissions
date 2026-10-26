import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";
import { internal_key_matches } from "../middlewares/api_key.js";
import {
  create_api_key,
  create_outcome_token,
  get_customer,
  revoke_api_key,
  set_activeprospect_key,
} from "../services/customer_store.js";
import { BillingError, create_invite_token, join_url } from "../services/billing.js";

// Solcertain-only account operations (INTERNAL_API_KEY, fails closed), until
// the portal does them self-serve. Each returns a secret exactly once.

const router = Router();

function internal(req: Request, res: Response, next: NextFunction): void {
  if (internal_key_matches(req)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

async function with_customer(req: Request, res: Response): Promise<string | null> {
  const id = String(req.params["id"] ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !(await get_customer(id))) {
    res.status(404).json({ ok: false, error: "No such customer" });
    return null;
  }
  return id;
}

// POST /api/admin/invites  { email, name?, company?, role?, founder? }
// Issues a signed invite link. Emailing it from the waitlist admin is step 6.
router.post("/admin/invites", internal, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = str(body["email"]);
  if (!email || !email.includes("@")) {
    res.status(400).json({ ok: false, error: "email is required" });
    return;
  }
  const role = str(body["role"]);
  try {
    const token = create_invite_token({
      email,
      name: str(body["name"]),
      company: str(body["company"]),
      role: role === "buyer" || role === "both" ? role : "seller",
      founder: body["founder"] === true,
    });
    res.status(201).json({ ok: true, token, join_url: join_url(token) });
  } catch (err) {
    const status = err instanceof BillingError ? err.status : 500;
    res.status(status).json({ ok: false, error: err instanceof Error ? err.message : "Invite failed" });
  }
});

// POST /api/admin/customers/:id/api-keys  { label? }
router.post("/admin/customers/:id/api-keys", internal, async (req: Request, res: Response) => {
  const id = await with_customer(req, res);
  if (!id) return;
  const key = await create_api_key(id, str((req.body ?? {})["label"]));
  res.status(201).json({ ok: true, ...key });
});

// DELETE /api/admin/customers/:id/api-keys/:key_id
router.delete("/admin/customers/:id/api-keys/:key_id", internal, async (req: Request, res: Response) => {
  const id = await with_customer(req, res);
  if (!id) return;
  const revoked = await revoke_api_key(id, String(req.params["key_id"]));
  res.status(revoked ? 200 : 404).json({ ok: revoked });
});

// PUT /api/admin/customers/:id/activeprospect-key  { key }
router.put("/admin/customers/:id/activeprospect-key", internal, async (req: Request, res: Response) => {
  const id = await with_customer(req, res);
  if (!id) return;
  const key = str((req.body ?? {})["key"]);
  if (!key) {
    res.status(400).json({ ok: false, error: "key is required" });
    return;
  }
  try {
    await set_activeprospect_key(id, key);
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Could not store ActiveProspect key");
    res.status(503).json({ ok: false, error: err instanceof Error ? err.message : "Could not store key" });
  }
});

// POST /api/admin/customers/:id/outcome-tokens  { label? }
router.post("/admin/customers/:id/outcome-tokens", internal, async (req: Request, res: Response) => {
  const id = await with_customer(req, res);
  if (!id) return;
  const token = await create_outcome_token(id, str((req.body ?? {})["label"]));
  res.status(201).json({ ok: true, token, path: `/api/v1/outcomes/${token}` });
});

export default router;
