import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../services/outcome_store.js", () => ({
  OPERATOR_LABELS: { fraud: "confirmed_fraud", genuine: "confirmed_genuine" },
  save_operator_label: vi.fn(),
}));

import express from "express";
import request from "supertest";
import router from "../routes/outcome_labels.js";
import { save_operator_label } from "../services/outcome_store.js";

const save = save_operator_label as ReturnType<typeof vi.fn>;
const app = express().use(express.json()).use("/api", router);
const KEY = "test-key";

const stored = (status: string, already = false) => ({
  id: "o1",
  analysis_id: "bd14ca1c-04ca-4896-a4ba-567ba5be5acd",
  outcome: "confirmed_fraud",
  already_recorded: already,
  engine: { score: 58, status, flags: ["synthetic_typing"], model_version: "0.4-insights", scored_at: "2026-10-17T20:32:21.182Z" },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env["INTERNAL_API_KEY"] = KEY;
});
afterEach(() => {
  delete process.env["INTERNAL_API_KEY"];
});

describe("POST /api/outcomes/label", () => {
  it("fails closed with no key configured", async () => {
    delete process.env["INTERNAL_API_KEY"];
    const res = await request(app).post("/api/outcomes/label").send({ analysis_id: "x", label: "fraud" });
    expect(res.status).toBe(401);
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects a wrong key", async () => {
    const res = await request(app).post("/api/outcomes/label").set("x-api-key", "nope").send({ analysis_id: "x", label: "fraud" });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown label or a missing lead reference", async () => {
    const a = await request(app).post("/api/outcomes/label").set("x-api-key", KEY).send({ analysis_id: "x", label: "bad" });
    const b = await request(app).post("/api/outcomes/label").set("x-api-key", KEY).send({ label: "fraud" });
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(save).not.toHaveBeenCalled();
  });

  it("returns 404 when no scored lead matches", async () => {
    save.mockResolvedValue(null);
    const res = await request(app).post("/api/outcomes/label").set("x-api-key", KEY).send({ lp_lead_id: "zzz", label: "fraud" });
    expect(res.status).toBe(404);
  });

  it("records fraud the engine held back as caught", async () => {
    save.mockResolvedValue(stored("review"));
    const res = await request(app)
      .post("/api/outcomes/label")
      .set("x-api-key", KEY)
      .send({ lp_lead_id: "ma2QS6EB8JeApcHIt-7B", label: "fraud", reason: "buyer call" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, engine_result: "caught", engine: { score: 58 } });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ lp_lead_id: "ma2QS6EB8JeApcHIt-7B", label: "fraud", reason: "buyer call" }));
  });

  it("reports approved fraud as missed, and a repeat as 200", async () => {
    save.mockResolvedValue(stored("approved", true));
    const res = await request(app).post("/api/outcomes/label").set("x-api-key", KEY).send({ analysis_id: "x", label: "fraud" });
    expect(res.status).toBe(200);
    expect(res.body.engine_result).toBe("missed");
  });

  it("reports a genuine lead that was held back as a false alarm", async () => {
    save.mockResolvedValue({ ...stored("review"), outcome: "confirmed_genuine" });
    const res = await request(app).post("/api/outcomes/label").set("x-api-key", KEY).send({ analysis_id: "x", label: "genuine" });
    expect(res.body.engine_result).toBe("false_alarm");
  });
});
