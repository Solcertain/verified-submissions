-- Portal sign-in: sessions and a lockout after repeated failed passwords.
--
-- A session is a random token held in an httpOnly cookie; only its sha256 is
-- stored, so a database read cannot replay one. Sign-out and password changes
-- delete the rows, which ends the session at once.
--
-- Additive only: the code currently in production keeps working with this
-- applied.

create table if not exists customer_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_users (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index if not exists customer_sessions_user_idx on customer_sessions (user_id);
create index if not exists customer_sessions_expires_idx on customer_sessions (expires_at);

alter table customer_users add column if not exists failed_logins integer not null default 0;
alter table customer_users add column if not exists locked_until timestamptz;

alter table customer_sessions enable row level security;
