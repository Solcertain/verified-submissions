import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import pg from "pg";
import { customerSessionsTable, customerUsersTable, customersTable } from "./customer_tables.js";
import { to_context, type CustomerContext } from "./customer_store.js";
import { hash_password, random_token, sha256_hex, verify_password } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

// Portal sign-in. Passwords are scrypt hashes; sessions and one-time password
// links are random tokens of which only a sha256 is stored. Connection is lazy,
// matching the other stores, so a missing DATABASE_URL never fails an import.

export const SESSION_TTL_MS = 14 * 86_400_000;
export const SET_PASSWORD_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 60 * 60_000;
export const MIN_PASSWORD_LENGTH = 10;
const LOCK_AFTER_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

const schema = { customerSessionsTable, customerUsersTable, customersTable };
let db: NodePgDatabase<typeof schema> | undefined;

function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  db = drizzle(new pg.Pool({ connectionString: url }), { schema });
  return db;
}

export interface PortalSession {
  user_id: string;
  email: string;
  customer: CustomerContext;
}

// ── One-time password links ─────────────────────────────────────────────────

// Issues a set-password link for a customer's user (the first one, or the one
// with this email). Replaces any link issued before. null if there is no user.
export async function issue_password_token(
  customer_id: string,
  ttl_ms: number,
  email?: string,
): Promise<{ token: string; email: string } | null> {
  const where = email
    ? and(eq(customerUsersTable.customer_id, customer_id), sql`lower(${customerUsersTable.email}) = ${email.toLowerCase()}`)
    : eq(customerUsersTable.customer_id, customer_id);
  const users = await getDb()
    .select({ id: customerUsersTable.id, email: customerUsersTable.email })
    .from(customerUsersTable)
    .where(where)
    .orderBy(customerUsersTable.created_at)
    .limit(1);
  const user = users[0];
  if (!user) return null;
  const token = random_token(32);
  await getDb()
    .update(customerUsersTable)
    .set({ reset_token_hash: sha256_hex(token), reset_expires_at: new Date(Date.now() + ttl_ms) })
    .where(eq(customerUsersTable.id, user.id));
  return { token, email: user.email };
}

// For "forgot password": a one-hour link, or null when no active account has
// this email. The caller answers the same either way.
export async function request_password_reset(email: string): Promise<string | null> {
  const rows = await getDb()
    .select({ customer_id: customerUsersTable.customer_id, status: customersTable.status })
    .from(customerUsersTable)
    .innerJoin(customersTable, eq(customersTable.id, customerUsersTable.customer_id))
    .where(sql`lower(${customerUsersTable.email}) = ${email.toLowerCase()}`)
    .limit(1);
  const row = rows[0];
  if (!row || row.status === "canceled") return null;
  const issued = await issue_password_token(row.customer_id, RESET_TTL_MS, email);
  return issued?.token ?? null;
}

// Uses a set-password or reset link. Signs out every other session for the
// user, clears any lockout, and returns who it was for; null if the link is
// unknown or expired.
export async function set_password_with_token(
  token: string,
  password: string,
): Promise<{ user_id: string; customer_id: string } | null> {
  if (!token) return null;
  const rows = await getDb()
    .select({ id: customerUsersTable.id, customer_id: customerUsersTable.customer_id })
    .from(customerUsersTable)
    .where(and(eq(customerUsersTable.reset_token_hash, sha256_hex(token)), gt(customerUsersTable.reset_expires_at, new Date())))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  const password_hash = await hash_password(password);
  await getDb()
    .update(customerUsersTable)
    .set({ password_hash, reset_token_hash: null, reset_expires_at: null, failed_logins: 0, locked_until: null })
    .where(eq(customerUsersTable.id, user.id));
  await getDb().delete(customerSessionsTable).where(eq(customerSessionsTable.user_id, user.id));
  return { user_id: user.id, customer_id: user.customer_id };
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

let dummy_hash: Promise<string> | undefined;

export type LoginResult =
  | { ok: true; user_id: string; customer_id: string }
  | { ok: false; reason: "invalid" | "locked" | "canceled" };

// Five wrong passwords lock the user out for 15 minutes. An unknown email
// still costs one scrypt, so response time does not reveal which emails exist.
export async function login(email: string, password: string, now = new Date()): Promise<LoginResult> {
  const rows = await getDb()
    .select({ user: customerUsersTable, status: customersTable.status })
    .from(customerUsersTable)
    .innerJoin(customersTable, eq(customersTable.id, customerUsersTable.customer_id))
    .where(sql`lower(${customerUsersTable.email}) = ${email.toLowerCase()}`)
    .limit(1);
  const row = rows[0];
  if (!row || !row.user.password_hash) {
    dummy_hash ??= hash_password(random_token());
    await verify_password(password, await dummy_hash);
    return { ok: false, reason: "invalid" };
  }
  const user = row.user;
  if (user.locked_until && user.locked_until > now) return { ok: false, reason: "locked" };

  if (!(await verify_password(password, user.password_hash!))) {
    const failures = user.failed_logins + 1;
    await getDb()
      .update(customerUsersTable)
      .set(
        failures >= LOCK_AFTER_FAILURES
          ? { failed_logins: 0, locked_until: new Date(now.getTime() + LOCK_MS) }
          : { failed_logins: failures },
      )
      .where(eq(customerUsersTable.id, user.id));
    return { ok: false, reason: failures >= LOCK_AFTER_FAILURES ? "locked" : "invalid" };
  }
  if (row.status === "canceled") return { ok: false, reason: "canceled" };

  await getDb()
    .update(customerUsersTable)
    .set({ failed_logins: 0, locked_until: null, last_login_at: now })
    .where(eq(customerUsersTable.id, user.id));
  return { ok: true, user_id: user.id, customer_id: user.customer_id };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function create_session(user_id: string, customer_id: string): Promise<string> {
  const token = random_token(32);
  await getDb()
    .insert(customerSessionsTable)
    .values({ user_id, customer_id, token_hash: sha256_hex(token), expires_at: new Date(Date.now() + SESSION_TTL_MS) });
  // Housekeeping, best effort: expired sessions are never read again.
  getDb()
    .delete(customerSessionsTable)
    .where(lt(customerSessionsTable.expires_at, new Date()))
    .catch((err: unknown) => logger.warn({ err }, "Could not clear expired sessions"));
  return token;
}

export async function resolve_session(token: string): Promise<PortalSession | null> {
  if (!token) return null;
  const rows = await getDb()
    .select({ session_id: customerSessionsTable.id, user_id: customerUsersTable.id, email: customerUsersTable.email, customer: customersTable })
    .from(customerSessionsTable)
    .innerJoin(customerUsersTable, eq(customerUsersTable.id, customerSessionsTable.user_id))
    .innerJoin(customersTable, eq(customersTable.id, customerSessionsTable.customer_id))
    .where(and(eq(customerSessionsTable.token_hash, sha256_hex(token)), gt(customerSessionsTable.expires_at, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  getDb()
    .update(customerSessionsTable)
    .set({ last_seen_at: new Date() })
    .where(eq(customerSessionsTable.id, row.session_id))
    .catch((err: unknown) => logger.warn({ err }, "Could not record session use"));
  return { user_id: row.user_id, email: row.email, customer: to_context(row.customer) };
}

export async function delete_session(token: string): Promise<void> {
  if (!token) return;
  await getDb().delete(customerSessionsTable).where(eq(customerSessionsTable.token_hash, sha256_hex(token)));
}
