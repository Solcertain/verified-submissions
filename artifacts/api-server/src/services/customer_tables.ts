import { pgTable, text, uuid, timestamp, index, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// The customer-account tables, declared here rather than imported from
// @workspace/db, matching submission_store and outcome_store: Vercel compiles
// this package file by file and does not ship the workspace package's .ts
// sources, so importing them crashes the function at startup. Keep in step with
// lib/db/src/schema/index.ts and migration 0003.

// Solcertain's own traffic, seeded by 0003. The env secrets resolve to this id.
export const SOLCERTAIN_CUSTOMER_ID = "00000000-0000-0000-0000-000000000001";

export const customersTable = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  role: text("role").notNull().default("seller"),
  tier: text("tier").notNull(),
  status: text("status").notNull().default("pending_payment"),
  monthly_minimum_cents: integer("monthly_minimum_cents").notNull().default(0),
  stripe_customer_id: text("stripe_customer_id").unique(),
  stripe_subscription_id: text("stripe_subscription_id").unique(),
  waitlist_email: text("waitlist_email"),
  past_due_since: timestamp("past_due_since", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Customer = typeof customersTable.$inferSelect;

export const customerUsersTable = pgTable(
  "customer_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customer_id: uuid("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    password_hash: text("password_hash"),
    reset_token_hash: text("reset_token_hash"),
    reset_expires_at: timestamp("reset_expires_at", { withTimezone: true }),
    last_login_at: timestamp("last_login_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("customer_users_email_idx").on(sql`lower(${table.email})`),
    index("customer_users_customer_idx").on(table.customer_id),
  ],
);

export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customer_id: uuid("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull().unique(),
    key_hash: text("key_hash").notNull(),
    label: text("label"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_customer_idx").on(table.customer_id)],
);

export const customerSecretsTable = pgTable("customer_secrets", {
  customer_id: uuid("customer_id").primaryKey().references(() => customersTable.id, { onDelete: "cascade" }),
  activeprospect_key_encrypted: text("activeprospect_key_encrypted"),
  validated_at: timestamp("validated_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const outcomeTokensTable = pgTable("outcome_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  customer_id: uuid("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
  token_hash: text("token_hash").notNull().unique(),
  label: text("label"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
});

export const usageEventsTable = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customer_id: uuid("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
    submission_id: uuid("submission_id"),
    certificate_id: text("certificate_id").notNull(),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    reported_to_stripe_at: timestamp("reported_to_stripe_at", { withTimezone: true }),
    report_attempts: integer("report_attempts").notNull().default(0),
    last_report_error: text("last_report_error"),
  },
  (table) => [uniqueIndex("usage_events_customer_cert_idx").on(table.customer_id, table.certificate_id)],
);
