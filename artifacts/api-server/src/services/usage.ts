import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import pg from "pg";
import { customersTable, usageEventsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { stripe_request } from "./stripe_client.js";
import type { CustomerContext } from "./customer_store.js";

// The billable unit: one unique TrustedForm certificate scored for a customer.
// Rejected leads count (the work was done); cache hits and forced rescores of a
// certificate already counted do not, which the unique (customer_id,
// certificate_id) index enforces.
//
// Each new usage row is sent to the Stripe meter straight away, without holding
// up the response. Anything that did not get through is resent by the daily
// cron with the same identifier, which Stripe deduplicates.

export const METER_EVENT_NAME = "verified_lead";
// Stripe accepts meter events up to 35 days old; older rows are given up on.
const MAX_REPORT_AGE_MS = 35 * 86_400_000;
const MAX_REPORT_ATTEMPTS = 10;

const schema = { customersTable, usageEventsTable };
let db: NodePgDatabase<typeof schema> | undefined;

function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  db = drizzle(new pg.Pool({ connectionString: url }), { schema });
  return db;
}

export interface UsageRow {
  id: string;
  customer_id: string;
  certificate_id: string;
  occurred_at: Date;
}

// Inserts the usage row if this certificate has not been counted for this
// customer before. Returns the new row, or null when it was already counted.
export async function insert_usage(
  customer_id: string,
  certificate_id: string,
  submission_id: string | null,
): Promise<UsageRow | null> {
  const rows = await getDb()
    .insert(usageEventsTable)
    .values({ customer_id, certificate_id, submission_id })
    .onConflictDoNothing({ target: [usageEventsTable.customer_id, usageEventsTable.certificate_id] })
    .returning({
      id: usageEventsTable.id,
      customer_id: usageEventsTable.customer_id,
      certificate_id: usageEventsTable.certificate_id,
      occurred_at: usageEventsTable.occurred_at,
    });
  return rows[0] ?? null;
}

// Sends one usage row to the meter and records the result on the row.
export async function report_usage(row: UsageRow, stripe_customer_id: string): Promise<boolean> {
  try {
    await stripe_request("POST", "/billing/meter_events", {
      event_name: METER_EVENT_NAME,
      // The row id makes a resend a no-op on Stripe's side.
      identifier: row.id,
      timestamp: Math.floor(row.occurred_at.getTime() / 1000),
      payload: { stripe_customer_id, value: 1 },
    });
    await getDb()
      .update(usageEventsTable)
      .set({ reported_to_stripe_at: new Date(), last_report_error: null })
      .where(eq(usageEventsTable.id, row.id));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, usage_id: row.id }, "Meter event failed; the daily cron will retry");
    await getDb()
      .update(usageEventsTable)
      .set({
        report_attempts: sql`${usageEventsTable.report_attempts} + 1`,
        last_report_error: message.slice(0, 500),
      })
      .where(eq(usageEventsTable.id, row.id))
      .catch((e: unknown) => logger.error({ err: e }, "Could not record meter failure"));
    return false;
  }
}

// Called once a certificate has been scored for a customer. Never throws: a
// metering problem must not fail the verification the customer is waiting on.
export async function record_usage(
  customer: CustomerContext,
  certificate_id: string,
  submission_id: string | null,
): Promise<{ billable: boolean }> {
  if (!certificate_id) return { billable: false };
  try {
    const row = await insert_usage(customer.id, certificate_id, submission_id);
    if (!row) return { billable: false };
    // Solcertain's own traffic is counted but not billed.
    if (customer.stripe_customer_id) {
      void report_usage(row, customer.stripe_customer_id);
    }
    return { billable: true };
  } catch (err) {
    logger.error({ err, customer_id: customer.id }, "Could not record usage");
    return { billable: false };
  }
}

// Resends usage rows Stripe has not acknowledged. Run by the daily cron.
export async function retry_unreported_usage(limit = 500): Promise<{ attempted: number; reported: number }> {
  const since = new Date(Date.now() - MAX_REPORT_AGE_MS);
  const rows = await getDb()
    .select({
      id: usageEventsTable.id,
      customer_id: usageEventsTable.customer_id,
      certificate_id: usageEventsTable.certificate_id,
      occurred_at: usageEventsTable.occurred_at,
      stripe_customer_id: customersTable.stripe_customer_id,
    })
    .from(usageEventsTable)
    .innerJoin(customersTable, eq(customersTable.id, usageEventsTable.customer_id))
    .where(
      and(
        isNull(usageEventsTable.reported_to_stripe_at),
        isNotNull(customersTable.stripe_customer_id),
        gt(usageEventsTable.occurred_at, since),
        lt(usageEventsTable.report_attempts, MAX_REPORT_ATTEMPTS),
      ),
    )
    .orderBy(asc(usageEventsTable.occurred_at))
    .limit(limit);

  let reported = 0;
  for (const row of rows) {
    if (await report_usage(row, row.stripe_customer_id!)) reported++;
  }
  return { attempted: rows.length, reported };
}

// The top-up that brings a month's charge up to the tier minimum. Pure, so the
// arithmetic is tested without Stripe.
export function compute_minimum_topup(minimum_cents: number, usage_cents: number): number {
  if (!Number.isFinite(minimum_cents) || minimum_cents <= 0) return 0;
  const usage = Number.isFinite(usage_cents) ? Math.max(0, usage_cents) : 0;
  return Math.max(0, Math.round(minimum_cents - usage));
}
