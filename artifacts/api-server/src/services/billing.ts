import { logger } from "../lib/logger.js";
import { sign_token, verify_token } from "../lib/crypto.js";
import { stripe_request } from "./stripe_client.js";
import { compute_minimum_topup } from "./usage.js";
import {
  create_paid_customer,
  customer_exists_for_email,
  find_customer_by_stripe,
  list_user_emails,
  set_customer_status,
  type CustomerStatus,
  type Tier,
} from "./customer_store.js";
import { payment_failed_email, send_email, set_password_email } from "./email.js";

// Paid plans on the VerifiedSubmission Stripe account. Each is a metered price
// on the `verified_lead` meter; the monthly minimum is applied by
// apply_minimum_topup when the month's invoice is drafted, because Stripe has
// no native minimum. Enterprise is set up by hand, never through Checkout.
export const TIERS = {
  starter: { label: "Starter", rate_cents: 15, monthly_minimum_cents: 50_000, price_env: "STRIPE_PRICE_STARTER" },
  growth: { label: "Growth", rate_cents: 12, monthly_minimum_cents: 200_000, price_env: "STRIPE_PRICE_GROWTH" },
  founder: { label: "Founder", rate_cents: 8, monthly_minimum_cents: 0, price_env: "STRIPE_PRICE_FOUNDER" },
} as const;

export type CheckoutTier = keyof typeof TIERS;

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

// ── Invites ─────────────────────────────────────────────────────────────────

export interface Invite extends Record<string, unknown> {
  email: string;
  name?: string;
  company?: string;
  role?: "seller" | "buyer" | "both";
  founder?: boolean;
  exp: number;
}

function invite_secret(): string {
  const s = process.env["INVITE_SIGNING_SECRET"];
  if (!s) throw new BillingError("INVITE_SIGNING_SECRET is not set", 503);
  return s;
}

export function create_invite_token(invite: Omit<Invite, "exp">, ttl_days = 14): string {
  return sign_token({ ...invite, exp: Math.floor(Date.now() / 1000) + ttl_days * 86_400 }, invite_secret());
}

export function read_invite_token(token: string): Invite | null {
  const invite = verify_token<Invite>(token, invite_secret());
  return invite && typeof invite.email === "string" && invite.email.includes("@") ? invite : null;
}

export function join_url(token: string): string {
  const base = (process.env["PORTAL_URL"] ?? "https://portal.verifiedsubmission.com").replace(/\/$/, "");
  return `${base}/join?t=${encodeURIComponent(token)}`;
}

// ── Checkout ────────────────────────────────────────────────────────────────

// Founders always get the founder price; nobody else can choose it.
export function resolve_checkout_tier(invite: Invite, requested: string | undefined): CheckoutTier {
  if (invite.founder) return "founder";
  if (requested === "enterprise") throw new BillingError("Enterprise is set up with our team. Email hello@verifiedsubmission.com.", 400);
  if (requested === "starter" || requested === "growth") return requested;
  throw new BillingError("tier must be starter or growth", 400);
}

export function tier_for_price(price_id: string | null | undefined): CheckoutTier | null {
  if (!price_id) return null;
  for (const [tier, t] of Object.entries(TIERS)) {
    if (process.env[t.price_env] === price_id) return tier as CheckoutTier;
  }
  return null;
}

export async function create_checkout_session(
  invite_token: string,
  requested_tier: string | undefined,
): Promise<{ id: string; url: string; tier: CheckoutTier }> {
  const invite = read_invite_token(invite_token);
  if (!invite) throw new BillingError("This invite link is invalid or has expired", 401);

  const tier = resolve_checkout_tier(invite, requested_tier);
  const price = process.env[TIERS[tier].price_env];
  if (!price) throw new BillingError(`${TIERS[tier].price_env} is not set`, 503);

  if (await customer_exists_for_email(invite.email)) {
    throw new BillingError("An account already exists for this email. Sign in to the portal instead.", 409);
  }

  const metadata = {
    tier,
    invite_email: invite.email,
    name: invite.company ?? invite.name ?? invite.email,
    role: invite.role ?? "seller",
  };
  const session = await stripe_request<{ id: string; url: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    // Metered: no quantity; usage arrives through the meter.
    line_items: [{ price }],
    customer_email: invite.email,
    success_url: `${join_url(invite_token).replace("/join?", "/join/success?")}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: join_url(invite_token),
    metadata,
    subscription_data: { metadata },
  });
  return { id: session.id, url: session.url, tier };
}

// ── Webhook events ──────────────────────────────────────────────────────────

type Obj = Record<string, any>;

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Obj };
}

// Basil moved the invoice's subscription under parent; older versions had it
// at the top level. Read either.
function invoice_subscription_id(invoice: Obj): string | null {
  return (
    invoice["parent"]?.["subscription_details"]?.["subscription"] ??
    (typeof invoice["subscription"] === "string" ? invoice["subscription"] : invoice["subscription"]?.["id"]) ??
    null
  );
}

function id_of(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Obj)["id"] === "string") return (v as Obj)["id"];
  return null;
}

async function on_checkout_completed(session: Obj): Promise<string> {
  if (session["mode"] !== "subscription") return "ignored: not a subscription checkout";
  const meta = (session["metadata"] ?? {}) as Record<string, string>;
  const tier = meta["tier"] as CheckoutTier | undefined;
  const email = meta["invite_email"] ?? session["customer_details"]?.["email"] ?? session["customer_email"];
  const stripe_customer_id = id_of(session["customer"]);
  const stripe_subscription_id = id_of(session["subscription"]);
  if (!tier || !(tier in TIERS) || !email || !stripe_customer_id || !stripe_subscription_id) {
    logger.error({ session_id: session["id"] }, "Checkout session is missing tier, email or ids");
    return "ignored: incomplete session";
  }

  const result = await create_paid_customer({
    name: meta["name"] || email,
    role: meta["role"] || "seller",
    tier,
    monthly_minimum_cents: TIERS[tier].monthly_minimum_cents,
    email,
    stripe_customer_id,
    stripe_subscription_id,
  });
  if (!result.created) return "duplicate: customer already exists";

  if (result.set_password_token) {
    await send_email({ to: email, ...set_password_email({ token: result.set_password_token }) });
  }
  logger.info({ customer_id: result.customer_id, tier }, "Customer created from checkout");
  return "customer created";
}

// Adds the "minimum top-up" line to a month's draft invoice when usage came in
// under the tier minimum. Only on renewal invoices (the first, at signup, is
// $0 for a metered plan), only while the invoice is still a draft, and only
// once per invoice.
export async function apply_minimum_topup(invoice: Obj): Promise<string> {
  if (invoice["billing_reason"] !== "subscription_cycle") return "skipped: not a renewal invoice";
  if (invoice["status"] !== "draft") return "skipped: invoice is not a draft";

  const customer = await find_customer_by_stripe({
    subscription: invoice_subscription_id(invoice),
    customer: id_of(invoice["customer"]),
  });
  if (!customer) return "skipped: unknown customer";

  const lines = (invoice["lines"]?.["data"] ?? []) as Obj[];
  if (lines.some((l) => l["metadata"]?.["vs_minimum_topup"] === "1")) return "skipped: top-up already added";

  const usage_cents = Number(invoice["subtotal"] ?? 0);
  const topup = compute_minimum_topup(customer.monthly_minimum_cents, usage_cents);
  if (topup === 0) return "skipped: usage met the minimum";

  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  await stripe_request(
    "POST",
    "/invoiceitems",
    {
      customer: id_of(invoice["customer"]),
      invoice: invoice["id"],
      amount: topup,
      currency: invoice["currency"] ?? "usd",
      description: `Monthly minimum top-up: ${dollars(customer.monthly_minimum_cents)} minimum, ${dollars(usage_cents)} usage`,
      metadata: { vs_minimum_topup: "1" },
    },
    { idempotency_key: `vs-topup-${invoice["id"]}` },
  );
  logger.info({ customer_id: customer.id, topup }, "Added minimum top-up to invoice");
  return `top-up added: ${topup}`;
}

export function status_for_subscription(stripe_status: string): CustomerStatus {
  switch (stripe_status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "incomplete":
      return "pending_payment";
    default:
      // canceled, incomplete_expired, paused
      return "canceled";
  }
}

async function on_subscription_changed(sub: Obj, deleted: boolean): Promise<string> {
  const customer = await find_customer_by_stripe({ subscription: id_of(sub["id"]) });
  if (!customer) return "skipped: unknown subscription";
  const status = deleted ? "canceled" : status_for_subscription(String(sub["status"]));

  // A plan change in the Stripe Dashboard or Customer Portal moves the tier and
  // its minimum with it.
  const price_id = sub["items"]?.["data"]?.[0]?.["price"]?.["id"] as string | undefined;
  const tier = tier_for_price(price_id);
  const changes: { tier?: Tier; monthly_minimum_cents?: number } =
    tier && tier !== customer.tier ? { tier, monthly_minimum_cents: TIERS[tier].monthly_minimum_cents } : {};

  await set_customer_status(customer.id, status, changes);
  return `status ${status}${changes.tier ? `, tier ${changes.tier}` : ""}`;
}

async function on_payment_failed(invoice: Obj): Promise<string> {
  const customer = await find_customer_by_stripe({
    subscription: invoice_subscription_id(invoice),
    customer: id_of(invoice["customer"]),
  });
  if (!customer) return "skipped: unknown customer";
  const already = customer.status === "past_due";
  await set_customer_status(customer.id, "past_due");
  // Stripe retries a failed card several times; email on the first failure only.
  if (!already) {
    const to = await list_user_emails(customer.id);
    const grace = Number(process.env["PAST_DUE_GRACE_DAYS"] ?? 7) || 7;
    if (to.length > 0) await send_email({ to, ...payment_failed_email({ name: customer.name, grace_days: grace }) });
  }
  return "status past_due";
}

export async function handle_stripe_event(event: StripeEvent): Promise<string> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
      return on_checkout_completed(obj);
    case "invoice.created":
      return apply_minimum_topup(obj);
    case "customer.subscription.updated":
      return on_subscription_changed(obj, false);
    case "customer.subscription.deleted":
      return on_subscription_changed(obj, true);
    case "invoice.payment_failed":
      return on_payment_failed(obj);
    default:
      return "ignored";
  }
}
