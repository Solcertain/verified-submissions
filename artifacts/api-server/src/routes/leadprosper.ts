import { Router, type Request, type Response } from "express";
import { require_api_key } from "../middlewares/api_key.js";
import { normalizeLeadProsperPayload } from "../services/leadprosper_adapter.js";
import { scoreAndRouteLead } from "../services/score_and_route_service.js";
import { mapToLeadProsperFlatFields } from "../services/leadprosper_flat_fields.js";
import { get_activeprospect_key } from "../services/customer_store.js";

const router = Router();

// POST /api/leadprosper/pre-ping
// Lead Prosper sends a pre-ping payload; we normalize it, run the shared
// score-and-route pipeline, and return flat vs_* fields synchronously.
router.post(
  "/leadprosper/pre-ping",
  require_api_key,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { certificate_url, raw_payload } = normalizeLeadProsperPayload(body);

    // Missing certificate URL is a hard client error.
    if (!certificate_url) {
      res.status(400).json({
        vs_pass: false,
        error:
          "No TrustedForm certificate URL found in payload. Provide one of: certificate_url, trustedform_cert_url, xxTrustedFormCertUrl, etc.",
      });
      return;
    }

    // Solcertain's INTERNAL_API_KEY or a customer's own key; either way the
    // claim runs on that caller's ActiveProspect account.
    const customer = req.customer!;
    const outcome = await scoreAndRouteLead({
      customer,
      activeprospect_key: await get_activeprospect_key(customer),
      raw_url: certificate_url,
      raw_payload,
      source: "leadprosper",
    });

    // Always return flat fields with HTTP 200 — including the inconclusive case
    // for claim failures / invalid certs — so Lead Prosper can store and branch
    // on the vs_* fields rather than handling an error status.
    const flat = mapToLeadProsperFlatFields(outcome);
    res.status(200).json(flat);
  },
);

export default router;
