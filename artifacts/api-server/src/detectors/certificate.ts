import * as R from "../config/authenticity_rules.js";
import { is_page_mismatch } from "../services/certificate_integrity.js";
import { NONE, type Detector } from "./types.js";

// We claim within seconds of submission, so age at claim is how long ago the
// consent happened. Hours-old consent attached to a lead sold now is stale.
export const stale_certificate: Detector = {
  id: "stale_certificate",
  family: "certificate",
  status: "active",
  description: "Consent captured long before the lead was sold.",
  evaluate({ features: f }) {
    if (f.age_seconds === null || f.age_seconds <= R.STALE_CERTIFICATE_SECONDS) return NONE;
    const hours = f.age_seconds / 3600;
    const age = hours >= 1.5 ? `${Math.round(hours)} hours` : `${Math.round(f.age_seconds / 60)} minutes`;
    return {
      findings: [
        {
          points: -R.STALE_CERTIFICATE,
          flag: "stale_certificate",
          evidence: `Certificate was ${age} old when claimed.`,
        },
      ],
    };
  },
};

// A certificate presented for a different lead than the one that first claimed
// it proves nothing about this lead's consent.
export const certificate_reuse: Detector = {
  id: "certificate_reuse",
  family: "certificate",
  status: "active",
  description: "The same consent certificate attached to more than one lead.",
  evaluate({ options }) {
    if (!options.certificate_reused) return NONE;
    return {
      findings: [
        {
          points: -R.CERTIFICATE_REUSED,
          flag: "certificate_reused",
          forces_review: true,
          evidence: "This certificate was already claimed for a different lead.",
        },
      ],
    };
  },
};

// The certificate was captured on a different site than the lead's landing page.
// Inert until the request carries landing_page_url.
export const certificate_page_mismatch: Detector = {
  id: "certificate_page_mismatch",
  family: "certificate",
  status: "active",
  description: "Consent captured on a different website than the lead claims to come from.",
  evaluate({ features: f, options }) {
    if (!is_page_mismatch(f.page_url, options.landing_page_url)) return NONE;
    return {
      findings: [
        {
          points: -R.CERTIFICATE_PAGE_MISMATCH,
          flag: "certificate_page_mismatch",
          forces_review: true,
          evidence: `Certificate was captured on ${f.page_url}, not the lead's landing page ${options.landing_page_url}.`,
        },
      ],
    };
  },
};
