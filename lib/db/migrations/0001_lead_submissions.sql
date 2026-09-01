-- Initial schema for the Verified Submissions analysis store.
-- Mirrors lib/db/src/schema/index.ts. Keep the two in sync: drizzle-kit push can
-- regenerate the table, but it does not emit the RLS statements below, so this
-- file is the source of truth for the deployed database.

create table if not exists lead_submissions (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  certificate_url text,
  certificate_id text,
  raw_payload_json jsonb,
  trustedform_raw_json jsonb,
  parsed_submission_json jsonb,
  score_json jsonb,
  status text,
  processed_at timestamptz
);

-- Drives the certificate dedupe cache: a repeat cert returns the stored analysis
-- instead of consuming another TrustedForm claim.
create unique index if not exists lead_submissions_certificate_url_idx
  on lead_submissions (certificate_url);

-- Rows hold lead PII (raw_payload_json) and full TrustedForm session data
-- (trustedform_raw_json), so no client-facing role may read this table.
-- Enabling RLS with zero policies denies every non-owner role by default. On
-- plain Postgres that is defence in depth; if this database is ever moved to
-- Supabase it is what keeps the anon and authenticated roles out.
--
-- Deliberately NOT "force row level security": the API connects directly over
-- DATABASE_URL as the table owner, and owners bypass RLS unless FORCE is set.
-- Adding FORCE here would lock out the application itself.
alter table lead_submissions enable row level security;
