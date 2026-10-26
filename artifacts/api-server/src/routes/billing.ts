import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { BillingError, create_checkout_session, handle_stripe_event, type StripeEvent } from "../services/billing.js";
import { StripeError, verify_stripe_signature } from "../services/stripe_client.js";

const router = Router();

// POST /api/billing/checkout   { "invite_token": "...", "tier": "starter" | "growth" }
//
// The invite link's token is the only credential: it names the email the
// account will belong to, and whether the founder price applies.
router.post("/billing/checkout", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body["invite_token"] === "string" ? body["invite_token"] : "";
  const tier = typeof body["tier"] === "string" ? body["tier"] : undefined;
  if (!token) {
    res.status(400).json({ ok: false, error: "invite_token is required" });
    return;
  }
  try {
    const session = await create_checkout_session(token, tier);
    res.status(200).json({ ok: true, url: session.url, session_id: session.id, tier: session.tier });
  } catch (err) {
    if (err instanceof BillingError) {
      res.status(err.status).json({ ok: false, error: err.message });
      return;
    }
    logger.error({ err }, "Checkout session failed");
    res.status(502).json({ ok: false, error: err instanceof StripeError ? err.message : "Checkout failed" });
  }
});

// POST /api/stripe/webhook
//
// Mounted in app.ts with express.raw() BEFORE the global express.json(): the
// signature covers the exact bytes Stripe sent, so the body must not be
// re-serialized. Answers 500 on a handling failure so Stripe redelivers;
// every handler is safe to run twice.
export async function stripe_webhook(req: Request, res: Response): Promise<void> {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) {
    logger.error("STRIPE_WEBHOOK_SECRET is not set — rejecting webhook");
    res.status(503).json({ ok: false, error: "Webhook is not configured" });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!verify_stripe_signature(raw, req.header("stripe-signature"), secret)) {
    res.status(400).json({ ok: false, error: "Invalid signature" });
    return;
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw.toString("utf8")) as StripeEvent;
  } catch {
    res.status(400).json({ ok: false, error: "Invalid JSON" });
    return;
  }

  try {
    const result = await handle_stripe_event(event);
    logger.info({ event_id: event.id, type: event.type, result }, "Stripe webhook handled");
    res.status(200).json({ received: true, result });
  } catch (err) {
    logger.error({ err, event_id: event.id, type: event.type }, "Stripe webhook failed");
    res.status(500).json({ ok: false, error: "Handler failed" });
  }
}

export default router;
