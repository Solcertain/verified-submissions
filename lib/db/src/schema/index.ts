import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    failed_logins: integer("failed_logins").notNull().default(0),
    locked_until: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("customer_users_email_idx").on(sql`lower(${table.email})`),
    index("customer_users_customer_idx").on(table.customer_id),
  ],
);

export const customerSessionsTable = pgTable(
  "customer_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").notNull().references(() => customerUsersTable.id, { onDelete: "cascade" }),
    customer_id: uuid("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("customer_sessions_user_idx").on(table.user_id)],
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
  (table) => [
    uniqueIndex("usage_events_customer_cert_idx").on(table.customer_id, table.certificate_id),
  ],
);

export type UsageEvent = typeof usageEventsTable.$inferSelect;

export const leadSubmissionsTable = pgTable(
  "lead_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    certificate_url: text("certificate_url"),
    certificate_id: text("certificate_id"),
    raw_payload_json: jsonb("raw_payload_json"),
    trustedform_raw_json: jsonb("trustedform_raw_json"),
    parsed_submission_json: jsonb("parsed_submission_json"),
    score_json: jsonb("score_json"),
    status: text("status"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    customer_id: uuid("customer_id")
      .references(() => customersTable.id)
      .default(SOLCERTAIN_CUSTOMER_ID),
  },
  (table) => [
    // Per customer since 0003/0004: each customer holds its own analysis.
    uniqueIndex("lead_submissions_customer_certificate_idx").on(table.customer_id, table.certificate_url),
  ],
);

export type LeadSubmission = typeof leadSubmissionsTable.$inferSelect;
export type InsertLeadSubmission = typeof leadSubmissionsTable.$inferInsert;

export const leadOutcomesTable = pgTable(
  "lead_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    lp_lead_id: text("lp_lead_id"),
    certificate_url: text("certificate_url"),
    outcome: text("outcome"),
    buyer: text("buyer"),
    sell_price: numeric("sell_price"),
    return_reason: text("return_reason"),
    supplier: text("supplier"),
    raw_payload_json: jsonb("raw_payload_json"),
    analysis_id: uuid("analysis_id"),
    customer_id: uuid("customer_id")
      .references(() => customersTable.id)
      .default(SOLCERTAIN_CUSTOMER_ID),
  },
  (table) => [
    index("lead_outcomes_lp_lead_id_idx").on(table.lp_lead_id),
    index("lead_outcomes_certificate_url_idx").on(table.certificate_url),
    index("lead_outcomes_customer_idx").on(table.customer_id),
  ],
);

export type LeadOutcome = typeof leadOutcomesTable.$inferSelect;
export type InsertLeadOutcome = typeof leadOutcomesTable.$inferInsert;
