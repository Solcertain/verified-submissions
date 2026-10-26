import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pipeline's external edges so tests are hermetic (no DB, no network,
// no Google Sheets). Mocking submission_store also prevents @workspace/db from
// loading (it throws unless DATABASE_URL is set).
vi.mock("../services/submission_store.js", () => ({
  save_submission: vi.fn(async () => ({ id: "analysis-123" })),
  get_submission_by_certificate: vi.fn(async () => null),
  leadSubmissionsTable: {},
}));
vi.mock("../services/google_sheets.js", () => ({
  append_review_row: vi.fn(async () => ({ success: true, row_id: "r1", error: null })),
}));
vi.mock("../services/webhook_dispatcher.js", () => ({
  dispatch_outbound_webhook: vi.fn(async () => ({ success: true })),
}));
vi.mock("../services/usage.js", () => ({
  record_usage: vi.fn(async () => ({ billable: false })),
}));
vi.mock("../services/trustedform_client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/trustedform_client.js")>();
  return { ...actual, claim_certificate: vi.fn() };
});

import express, { type Express } from "express";
import request from "supertest";
import router from "../routes/index.js";
import { claim_certificate } from "../services/trustedform_client.js";
import { get_submission_by_certificate, save_submission } from "../services/submission_store.js";
import { MODEL_VERSION } from "../config/authenticity_rules.js";
import { extract_features } from "../services/feature_extractor.js";
import agent_claim from "./fixtures/botlab/agents/chatgpt_agent_2026-10-16.json";

// A clean own-form human as TrustedForm v4 returns it: typed, 180s, verified consent.
const HUMAN_CLAIM = {
  insights: {
    properties: {
      bot_detected: false,
      form_input_method: ["typing"],
      form_input_kpm: 120,
      form_input_wpm: 30,
      seconds_on_page: 180,
      age_seconds: 5,
      page_url: "https://solarenergynerds.com/form-step/",
      os: { name: "iOS", is_mobile: true },
      approx_ip_geo: { state: "Ohio", country_code: "US" },
    },
  },
  verify: { result: { success: true } },
};

const VALID_URL = `https://cert.trustedform.com/${"a".repeat(40)}`;

const FLAT_KEYS = [
  "vs_pass",
  "vs_score",
  "vs_score_1_10",
  "vs_status",
  "vs_confidence",
  "vs_classification",
  "vs_recommended_action",
  "vs_return_eligible",
  "vs_certificate_id",
  "vs_consent_detected",
  "vs_session_seconds",
  "vs_meaningful_event_count",
  "vs_risk_flags",
  "vs_reason",
  "vs_analysis_id",
  "vs_model_version",
];

// These tests exercise the pipeline as Solcertain; auth has its own tests in
// customer_accounts.test.ts.
const INTERNAL_KEY = "internal-test-key";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers["x-api-key"] ??= INTERNAL_KEY;
    next();
  });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["INTERNAL_API_KEY"] = INTERNAL_KEY;
  (get_submission_by_certificate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe("POST /api/leadprosper/pre-ping", () => {
  it("returns the full flat vs_* contract for a valid pre-ping payload", async () => {
    (claim_certificate as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status_code: 200,
      data: HUMAN_CLAIM,
      error: null,
    });

    const res = await request(makeApp()).post("/api/leadprosper/pre-ping").send({
      lp_lead_id: "test-lp-123",
      lp_campaign_id: "solar-campaign-1",
      trustedform_cert_url: VALID_URL,
      email: "test@example.com",
      phone: "5555555555",
      first_name: "Test",
      last_name: "Lead",
    });

    expect(res.status).toBe(200);
    for (const key of FLAT_KEYS) expect(res.body).toHaveProperty(key);
    expect(typeof res.body.vs_score).toBe("number");
    expect(res.body.vs_score).toBeGreaterThanOrEqual(0);
    expect(res.body.vs_score).toBeLessThanOrEqual(100);
    expect(["approved", "review", "reject"]).toContain(res.body.vs_status);
    expect(res.body.vs_model_version).toBe(MODEL_VERSION);
    expect(res.body.vs_analysis_id).toBe("analysis-123");
    expect(res.body.vs_pass).toBe(true);
    expect(res.body.vs_score).toBe(98);
    expect(res.body.vs_status).toBe("approved");
  });

  it("400s when no certificate URL is present in the payload", async () => {
    const res = await request(makeApp())
      .post("/api/leadprosper/pre-ping")
      .send({ email: "x@y.com" });
    expect(res.status).toBe(400);
    expect(res.body.vs_pass).toBe(false);
    expect(claim_certificate).not.toHaveBeenCalled();
  });

  it("returns inconclusive (HTTP 200) when the certificate claim fails", async () => {
    (claim_certificate as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status_code: 404,
      data: {},
      error: "missing",
    });
    const res = await request(makeApp())
      .post("/api/leadprosper/pre-ping")
      .send({ certificate_url: VALID_URL });
    expect(res.status).toBe(200);
    expect(res.body.vs_pass).toBe(false);
    expect(res.body.vs_classification).toBe("INCONCLUSIVE");
    expect(res.body.vs_status).toBe("review");
  });
});

describe("POST /api/score-and-route (after refactor to shared service)", () => {
  it("still returns the original rich response shape for a scored lead", async () => {
    (claim_certificate as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status_code: 200,
      data: HUMAN_CLAIM,
      error: null,
    });

    const res = await request(makeApp())
      .post("/api/score-and-route")
      .send({ certificate_url: VALID_URL });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.model_version).toBe(MODEL_VERSION);
    expect(res.body.score).toMatchObject({ value: 98, status: "approved" });
    expect(res.body).toHaveProperty("parsed_lead");
    expect(res.body).toHaveProperty("score");
    expect(res.body).toHaveProperty("routing");
    expect(res.body.claim_result).toEqual({ ok: true, status_code: 200 });
  });

  it("400s when certificate_url is missing", async () => {
    const res = await request(makeApp()).post("/api/score-and-route").send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns a cached result when a stored submission exists", async () => {
    (get_submission_by_certificate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "cached-row",
      processed_at: new Date("2026-01-01T00:00:00Z"),
      parsed_submission_json: { certificate_id: "CID" },
      score_json: { value: 88, status: "approved" },
    });

    const res = await request(makeApp())
      .post("/api/score-and-route")
      .send({ certificate_url: VALID_URL });

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.score).toEqual({ value: 88, status: "approved" });
    expect(claim_certificate).not.toHaveBeenCalled();
  });
});

// One model everywhere: the generic endpoint, routing and the stored status
// must reach the same decision as the Lead Prosper response for the same lead.
describe("one model across endpoints", () => {
  async function both(claim: unknown) {
    (claim_certificate as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status_code: 200, data: claim, error: null });
    const lp = await request(makeApp()).post("/api/leadprosper/pre-ping").send({ certificate_url: VALID_URL });
    const generic = await request(makeApp()).post("/api/score-and-route").send({ certificate_url: VALID_URL });
    return { lp: lp.body, generic: generic.body };
  }

  it("sends the AI agent to review on both endpoints, and stores review", async () => {
    const { lp, generic } = await both(agent_claim);
    expect(lp.vs_status).toBe("review");
    expect(generic.score.status).toBe("review");
    expect(generic.score.value).toBe(lp.vs_score);
    expect(generic.routing.decision).toBe("sent_to_review");
    const saved = (save_submission as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(saved.status).toBe("review");
    expect(saved.score_json.model_version).toBe(MODEL_VERSION);
    expect(saved.score_json.legacy).toBeDefined();
  });

  it("approves the clean human on both endpoints", async () => {
    const { lp, generic } = await both(HUMAN_CLAIM);
    expect(lp.vs_status).toBe("approved");
    expect(generic.score.status).toBe("approved");
    expect(generic.score.value).toBe(lp.vs_score);
  });

  it("rescores a cached certificate on the current model", async () => {
    (get_submission_by_certificate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "cached-row",
      processed_at: new Date("2026-10-16T00:00:00Z"),
      raw_payload_json: {},
      parsed_submission_json: { legacy: { certificate_id: "CID" }, features: { ...extract_agent() } },
      score_json: { value: 98, status: "approved" },
    });
    const res = await request(makeApp()).post("/api/score-and-route").send({ certificate_url: VALID_URL });
    expect(res.body.cached).toBe(true);
    expect(res.body.score.status).toBe("review");
    expect(res.body.model_version).toBe(MODEL_VERSION);
  });
});

function extract_agent() {
  return extract_features(agent_claim);
}
