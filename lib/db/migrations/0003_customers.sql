-- Customer accounts: who is calling, what they pay, and what they used.
--
-- Until now the API had exactly one caller (Solcertain) identified by shared env
-- secrets. Outside customers bring their own ActiveProspect key, call with their
-- own API keys and are billed per unique certificate scored for them.
--
-- Solcertain is seeded as customer #1 with a fixed id, and every existing row is
-- backfilled to it. The env secrets (INTERNAL_API_KEY, ACTIVEPROSPECT_API_KEY,
-- LP_CALLBACK_TOKEN) keep resolving to that id in code, so the live Lead Prosper
-- flow (campaign 23668) changes nothing.
--
-- Additive only: the code currently in production keeps working with this
-- applied. The old global certificate index is dropped by 0004, which must run
-- AFTER the code that uses the per-customer index is deployed.

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'seller' check (role in ('seller', 'buyer', 'both', 'internal')),
  tier text not null check (tier in ('starter', 'growth', 'founder', 'enterprise', 'internal')),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'past_due', 'canceled')),
  -- Charged as a top-up line when a month's usage falls short. Copied from the
  -- tier at checkout so an enterprise deal can carry its own figure.
  monthly_minimum_cents integer not null default 0,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  waitlist_email text,
  past_due_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists customers_waitlist_email_idx on customers (lower(waitlist_email));

insert into customers (id, name, role, tier, status)
values ('00000000-0000-0000-0000-000000000001', 'Solcertain', 'internal', 'internal', 'active')
on conflict (id) do nothing;

-- Portal logins. password_hash is null until the user sets one from the emailed
-- link; the reset token is stored hashed, never as sent.
create table if not exists customer_users (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  email text not null,
  password_hash text,
  reset_token_hash text,
  reset_expires_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists customer_users_email_idx on customer_users (lower(email));
create index if not exists customer_users_customer_idx on customer_users (customer_id);

-- API keys are shown once. Only a lookup prefix and a sha256 of the full key
-- are kept.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  prefix text not null unique,
  key_hash text not null,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_keys_customer_idx on api_keys (customer_id);

-- The customer's own ActiveProspect key, AES-256-GCM encrypted with
-- SECRETS_ENCRYPTION_KEY. Every claim for that customer is made with it.
create table if not exists customer_secrets (
  customer_id uuid primary key references customers (id) on delete cascade,
  activeprospect_key_encrypted text,
  validated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Secret path segments for outcome callbacks, stored hashed.
create table if not exists outcome_tokens (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One row per unique certificate scored for a customer: the billable unit. The
-- unique index is what makes a retried or forced rescore free.
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  submission_id uuid,
  certificate_id text not null,
  occurred_at timestamptz not null default now(),
  reported_to_stripe_at timestamptz,
  report_attempts integer not null default 0,
  last_report_error text
);

create unique index if not exists usage_events_customer_cert_idx on usage_events (customer_id, certificate_id);
create index if not exists usage_events_unreported_idx on usage_events (occurred_at) where reported_to_stripe_at is null;

-- Existing rows are all Solcertain's. The default attributes anything the
-- previous deployment writes between this migration and the new code going live.
alter table lead_submissions
  add column if not exists customer_id uuid references customers (id)
  default '00000000-0000-0000-0000-000000000001';
alter table lead_outcomes
  add column if not exists customer_id uuid references customers (id)
  default '00000000-0000-0000-0000-000000000001';

update lead_submissions set customer_id = '00000000-0000-0000-0000-000000000001' where customer_id is null;
update lead_outcomes set customer_id = '00000000-0000-0000-0000-000000000001' where customer_id is null;

-- The certificate cache becomes per customer: a buyer scoring a certificate its
-- seller already scored gets its own claim and its own row, never the seller's.
create unique index if not exists lead_submissions_customer_certificate_idx
  on lead_submissions (customer_id, certificate_url);
create index if not exists lead_outcomes_customer_idx on lead_outcomes (customer_id);

-- Same posture as the existing tables: no client-facing role reads these.
alter table customers enable row level security;
alter table customer_users enable row level security;
alter table api_keys enable row level security;
alter table customer_secrets enable row level security;
alter table outcome_tokens enable row level security;
alter table usage_events enable row level security;
