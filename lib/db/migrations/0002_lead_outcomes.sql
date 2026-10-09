-- Outcome labels from Lead Prosper.
--
-- This is the table that turns a guessed scoring model into a measurable one.
-- Every row is a lead whose fate is known — accepted, rejected, sold, returned —
-- which is the supervision the authenticity model currently lacks entirely.
--
-- Deliberately NOT a foreign key to lead_submissions: an outcome can arrive for a
-- certificate we never analysed (claim expired, API down, lead predates the
-- integration), and losing that label would be worse than leaving it unlinked.
-- analysis_id is resolved opportunistically on insert.

create table if not exists lead_outcomes (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  lp_lead_id text,
  certificate_url text,
  outcome text,
  buyer text,
  sell_price numeric,
  return_reason text,
  supplier text,
  raw_payload_json jsonb,
  analysis_id uuid
);

-- Joining labels back to analyses happens by certificate, and reporting happens
-- by lead and by supplier.
create index if not exists lead_outcomes_lp_lead_id_idx on lead_outcomes (lp_lead_id);
create index if not exists lead_outcomes_certificate_url_idx on lead_outcomes (certificate_url);
create index if not exists lead_outcomes_analysis_id_idx on lead_outcomes (analysis_id);
create index if not exists lead_outcomes_supplier_idx on lead_outcomes (supplier);

-- Same posture as lead_submissions: the payload carries lead PII, so no client
-- role may read it. Enabled, not forced, because the API connects as owner.
alter table lead_outcomes enable row level security;
