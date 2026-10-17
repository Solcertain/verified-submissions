import { logger } from "../lib/logger.js";
import { has_outcome, save_outcome } from "./outcome_store.js";
import { fetch_returned_leads, to_return_outcome, type Fetch } from "./leadprosper_returns.js";

export interface SyncResult {
  campaign: string;
  start_date: string;
  end_date: string;
  returned_found: number;
  recorded: number;
  already_recorded: number;
  failed: number;
  by_category: Record<string, number>;
}

// Returns usually land days after the sale, so the window looks back further
// than a day; already-recorded returns are skipped, so overlapping runs are safe.
export async function sync_returns(opts: {
  campaign: string;
  days: number;
  api_key: string;
  now?: Date;
  fetch_impl?: Fetch;
}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const end_date = now.toISOString().slice(0, 10);
  const start_date = new Date(now.getTime() - opts.days * 86_400_000).toISOString().slice(0, 10);

  const leads = await fetch_returned_leads(
    { campaign: opts.campaign, start_date, end_date },
    opts.api_key,
    opts.fetch_impl,
  );

  const result: SyncResult = {
    campaign: opts.campaign,
    start_date,
    end_date,
    returned_found: leads.length,
    recorded: 0,
    already_recorded: 0,
    failed: 0,
    by_category: {},
  };

  for (const lead of leads) {
    const outcome = to_return_outcome(lead);
    const category = String(outcome.raw["return_category"]);
    result.by_category[category] = (result.by_category[category] ?? 0) + 1;
    if (!outcome.lp_lead_id) {
      result.failed++;
      continue;
    }
    try {
      if (await has_outcome(outcome.lp_lead_id, "returned")) {
        result.already_recorded++;
        continue;
      }
      const stored = await save_outcome(outcome);
      if (stored) result.recorded++;
      else result.failed++;
    } catch (err) {
      logger.error({ err, lp_lead_id: outcome.lp_lead_id }, "Failed to record return");
      result.failed++;
    }
  }

  logger.info(result, "Lead Prosper returns sync");
  return result;
}
