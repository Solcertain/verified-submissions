-- Drops the global one-row-per-certificate index so two customers can each hold
-- their own analysis of the same certificate (a seller and the buyer it sold
-- the lead to). 0003 already created the per-customer replacement.
--
-- Apply AFTER the customer-accounts code is deployed. The code before it upserts
-- with ON CONFLICT (certificate_url), which needs this index to exist:
--   node lib/db/migrate.mjs --until 0003   (before deploying)
--   node lib/db/migrate.mjs                (after deploying)

drop index if exists lead_submissions_certificate_url_idx;
