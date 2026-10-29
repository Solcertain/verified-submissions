import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import pg from "pg";
import {
  SOLCERTAIN_CUSTOMER_ID,
  apiKeysTable,
  customerSecretsTable,
  customerUsersTable,
  customersTable,
  outcomeTokensTable,
  type Customer,
} from "./customer_tables.js";
import { logger } from "../lib/logger.js";
import { decrypt_secret, encrypt_secret, random_token, safe_equal, sha256_hex } from "../lib/crypto.js";

// Who is calling and on whose ActiveProspect account. Tables come from the
// schema subpath, which builds no connection pool; the pool here is lazy,
// matching submission_store, so a missing DATABASE_URL never fails an import.

export { SOLCERTAIN_CUSTOMER_ID };

export type CustomerStatus = "pending_payment" | "active" | "past_due" | "canceled";
export type Tier = "starter" | "growth" | "founder" | "enterprise" | "internal";

export interface CustomerContext {
  id: string;
  name: string;
  tier: Tier;
  status: CustomerStatus;
  // Solcertain's own traffic: env ActiveProspect key, Sheets/webhook routing,
  // never billed.
  internal: boolean;
  stripe_customer_id: string | null;
  past_due_since: Date | null;
}

// What INTERNAL_API_KEY and LP_CALLBACK_TOKEN resolve to. Built in code rather
// than read from the database so the Lead Prosper pre-ping has no new
// dependency on the path it already serves.
export const SOLCERTAIN: CustomerContext = {
  id: SOLCERTAIN_CUSTOMER_ID,
  name: "Solcertain",
  tier: "internal",
  status: "active",
  internal: true,
  stripe_customer_id: null,
  past_due_since: null,
};

const schema = {
  customersTable,
  customerUsersTable,
  apiKeysTable,
  customerSecretsTable,
  outcomeTokensTable,
};

let db: NodePgDatabase<typeof schema> | undefined;

function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  db = drizzle(new pg.Pool({ connectionString: url }), { schema });
  return db;
}

export function to_context(row: Customer): CustomerContext {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier as Tier,
    status: row.status as CustomerStatus,
    internal: row.id === SOLCERTAIN_CUSTOMER_ID,
    stripe_customer_id: row.stripe_customer_id,
    past_due_since: row.past_due_since,
  };
}

// ── API keys ────────────────────────────────────────────────────────────────
//
// vsk_<10 hex>_<secret>. The "vsk_<10 hex>" part is the lookup prefix; only a
// sha256 of the whole key is stored, so a database read cannot replay one.

const KEY_PATTERN = /^(vsk_[0-9a-f]{10})_[A-Za-z0-9_-]{20,}$/;

export function api_key_prefix(key: string): string | null {
  return KEY_PATTERN.exec(key)?.[1] ?? null;
}

export async function create_api_key(
  customer_id: string,
  label?: string,
): Promise<{ id: string; key: string; prefix: string }> {
  const prefix = `vsk_${sha256_hex(random_token()).slice(0, 10)}`;
  const key = `${prefix}_${random_token(32)}`;
  const [row] = await getDb()
    .insert(apiKeysTable)
    .values({ customer_id, prefix, key_hash: sha256_hex(key), label: label ?? null })
    .returning({ id: apiKeysTable.id });
  return { id: row!.id, key, prefix };
}

export async function revoke_api_key(customer_id: string, key_id: string): Promise<boolean> {
  const rows = await getDb()
    .update(apiKeysTable)
    .set({ revoked_at: new Date() })
    .where(and(eq(apiKeysTable.id, key_id), eq(apiKeysTable.customer_id, customer_id), isNull(apiKeysTable.revoked_at)))
    .returning({ id: apiKeysTable.id });
  return rows.length > 0;
}

// What the portal shows of a customer's keys: never the key itself.
export async function list_api_keys(customer_id: string): Promise<
  { id: string; prefix: string; label: string | null; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]
> {
  return getDb()
    .select({
      id: apiKeysTable.id,
      prefix: apiKeysTable.prefix,
      label: apiKeysTable.label,
      created_at: apiKeysTable.created_at,
      last_used_at: apiKeysTable.last_used_at,
      revoked_at: apiKeysTable.revoked_at,
    })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.customer_id, customer_id))
    .orderBy(apiKeysTable.created_at);
}

export async function find_customer_by_api_key(key: string): Promise<CustomerContext | null> {
  const prefix = api_key_prefix(key);
  if (!prefix) return null;
  const rows = await getDb()
    .select({ key_id: apiKeysTable.id, key_hash: apiKeysTable.key_hash, customer: customersTable })
    .from(apiKeysTable)
    .innerJoin(customersTable, eq(customersTable.id, apiKeysTable.customer_id))
    .where(and(eq(apiKeysTable.prefix, prefix), isNull(apiKeysTable.revoked_at)))
    .limit(1);
  const row = rows[0];
  if (!row || !safe_equal(sha256_hex(key), row.key_hash)) return null;

  // Best effort; a failed timestamp must not fail the request.
  getDb()
    .update(apiKeysTable)
    .set({ last_used_at: new Date() })
    .where(eq(apiKeysTable.id, row.key_id))
    .catch((err: unknown) => logger.warn({ err }, "Could not record API key use"));

  return to_context(row.customer);
}

// ── Outcome tokens ──────────────────────────────────────────────────────────

export async function create_outcome_token(customer_id: string, label?: string): Promise<string> {
  const token = random_token(32);
  await getDb()
    .insert(outcomeTokensTable)
    .values({ customer_id, token_hash: sha256_hex(token), label: label ?? null });
  return token;
}

export async function list_outcome_tokens(
  customer_id: string,
): Promise<{ id: string; label: string | null; created_at: Date; revoked_at: Date | null }[]> {
  return getDb()
    .select({
      id: outcomeTokensTable.id,
      label: outcomeTokensTable.label,
      created_at: outcomeTokensTable.created_at,
      revoked_at: outcomeTokensTable.revoked_at,
    })
    .from(outcomeTokensTable)
    .where(eq(outcomeTokensTable.customer_id, customer_id))
    .orderBy(outcomeTokensTable.created_at);
}

export async function revoke_outcome_token(customer_id: string, token_id: string): Promise<boolean> {
  const rows = await getDb()
    .update(outcomeTokensTable)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(outcomeTokensTable.id, token_id),
        eq(outcomeTokensTable.customer_id, customer_id),
        isNull(outcomeTokensTable.revoked_at),
      ),
    )
    .returning({ id: outcomeTokensTable.id });
  return rows.length > 0;
}

export async function find_customer_by_outcome_token(token: string): Promise<CustomerContext | null> {
  if (!token) return null;
  const rows = await getDb()
    .select({ customer: customersTable })
    .from(outcomeTokensTable)
    .innerJoin(customersTable, eq(customersTable.id, outcomeTokensTable.customer_id))
    .where(and(eq(outcomeTokensTable.token_hash, sha256_hex(token)), isNull(outcomeTokensTable.revoked_at)))
    .limit(1);
  return rows[0] ? to_context(rows[0].customer) : null;
}

// ── ActiveProspect key ──────────────────────────────────────────────────────

// The key every claim for this customer is made with. Solcertain keeps using
// the env key; anyone else uses only their own, so one customer's leads never
// draw on another's ActiveProspect account.
export async function get_activeprospect_key(customer: CustomerContext): Promise<string | null> {
  if (customer.internal) return process.env["ACTIVEPROSPECT_API_KEY"] ?? null;
  const rows = await getDb()
    .select({ enc: customerSecretsTable.activeprospect_key_encrypted })
    .from(customerSecretsTable)
    .where(eq(customerSecretsTable.customer_id, customer.id))
    .limit(1);
  const enc = rows[0]?.enc;
  if (!enc) return null;
  try {
    return decrypt_secret(enc);
  } catch (err) {
    logger.error({ err, customer_id: customer.id }, "Could not decrypt ActiveProspect key");
    return null;
  }
}

export async function has_activeprospect_key(customer_id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ enc: customerSecretsTable.activeprospect_key_encrypted })
    .from(customerSecretsTable)
    .where(eq(customerSecretsTable.customer_id, customer_id))
    .limit(1);
  return !!rows[0]?.enc;
}

export async function set_activeprospect_key(customer_id: string, key: string): Promise<void> {
  const enc = encrypt_secret(key);
  await getDb()
    .insert(customerSecretsTable)
    .values({ customer_id, activeprospect_key_encrypted: enc, updated_at: new Date() })
    .onConflictDoUpdate({
      target: customerSecretsTable.customer_id,
      set: { activeprospect_key_encrypted: enc, validated_at: null, updated_at: new Date() },
    });
}

// ── Customers ───────────────────────────────────────────────────────────────

export async function get_customer(id: string): Promise<CustomerContext | null> {
  const rows = await getDb().select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  return rows[0] ? to_context(rows[0]) : null;
}

export async function customer_exists_for_email(email: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(sql`lower(${customersTable.waitlist_email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows.length > 0;
}

export interface NewCustomer {
  name: string;
  role: string;
  tier: Tier;
  monthly_minimum_cents: number;
  email: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
}

// Creates the paid customer and its first portal user in one transaction.
// Stripe redelivers webhooks, so a second delivery for the same subscription
// finds the existing customer and creates nothing.
export async function create_paid_customer(
  input: NewCustomer,
  set_password_ttl_ms = 7 * 86_400_000,
): Promise<{ created: boolean; customer_id: string; set_password_token: string | null }> {
  return getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.stripe_subscription_id, input.stripe_subscription_id))
      .limit(1);
    if (existing[0]) return { created: false, customer_id: existing[0].id, set_password_token: null };

    const [customer] = await tx
      .insert(customersTable)
      .values({
        name: input.name,
        role: input.role,
        tier: input.tier,
        status: "active",
        monthly_minimum_cents: input.monthly_minimum_cents,
        stripe_customer_id: input.stripe_customer_id,
        stripe_subscription_id: input.stripe_subscription_id,
        waitlist_email: input.email,
      })
      .returning({ id: customersTable.id });

    const token = random_token(32);
    await tx.insert(customerUsersTable).values({
      customer_id: customer!.id,
      email: input.email,
      reset_token_hash: sha256_hex(token),
      reset_expires_at: new Date(Date.now() + set_password_ttl_ms),
    });
    return { created: true, customer_id: customer!.id, set_password_token: token };
  });
}

export interface ManualCustomer {
  name: string;
  email: string;
  role: string;
  tier: Exclude<Tier, "internal">;
}

export class DuplicateCustomerError extends Error {}

// A customer set up by hand (beta testers, enterprise deals): active at once,
// no Stripe subscription. With no stripe_customer_id their usage is counted but
// never sent to a meter, so nothing is charged until they move to checkout.
export async function create_manual_customer(input: ManualCustomer): Promise<string> {
  if (await customer_exists_for_email(input.email)) {
    throw new DuplicateCustomerError(`A customer already exists for ${input.email}`);
  }
  return getDb().transaction(async (tx) => {
    const [customer] = await tx
      .insert(customersTable)
      .values({
        name: input.name,
        role: input.role,
        tier: input.tier,
        status: "active",
        monthly_minimum_cents: 0,
        waitlist_email: input.email,
      })
      .returning({ id: customersTable.id });
    await tx.insert(customerUsersTable).values({ customer_id: customer!.id, email: input.email });
    return customer!.id;
  });
}

export async function list_customers(): Promise<
  Array<Pick<Customer, "id" | "name" | "role" | "tier" | "status" | "waitlist_email" | "created_at"> & { billed: boolean }>
> {
  const rows = await getDb().select().from(customersTable).orderBy(customersTable.created_at);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    tier: r.tier,
    status: r.status,
    waitlist_email: r.waitlist_email,
    created_at: r.created_at,
    billed: r.stripe_customer_id !== null,
  }));
}

export async function find_customer_by_stripe(
  ids: { subscription?: string | null; customer?: string | null },
): Promise<(CustomerContext & { monthly_minimum_cents: number }) | null> {
  const where = ids.subscription
    ? eq(customersTable.stripe_subscription_id, ids.subscription)
    : ids.customer
      ? eq(customersTable.stripe_customer_id, ids.customer)
      : null;
  if (!where) return null;
  const rows = await getDb().select().from(customersTable).where(where).limit(1);
  const row = rows[0];
  return row ? { ...to_context(row), monthly_minimum_cents: row.monthly_minimum_cents } : null;
}

// past_due_since is set on the first failure and kept until the customer is
// active again, so the grace period counts from when payment first failed.
export async function set_customer_status(
  customer_id: string,
  status: CustomerStatus,
  changes: { tier?: Tier; monthly_minimum_cents?: number } = {},
): Promise<void> {
  await getDb()
    .update(customersTable)
    .set({
      status,
      ...changes,
      past_due_since:
        status === "past_due" ? sql`coalesce(${customersTable.past_due_since}, now())` : null,
      updated_at: new Date(),
    })
    .where(eq(customersTable.id, customer_id));
}

export async function list_user_emails(customer_id: string): Promise<string[]> {
  const rows = await getDb()
    .select({ email: customerUsersTable.email })
    .from(customerUsersTable)
    .where(eq(customerUsersTable.customer_id, customer_id));
  return rows.map((r) => r.email);
}

