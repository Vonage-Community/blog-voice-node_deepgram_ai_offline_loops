import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp, type VoiceApp } from "../src/server.js";

let app: VoiceApp;
const priorBaseUrl = process.env.BASE_URL;
const priorDbPath = process.env.DB_PATH;

beforeAll(() => {
  process.env.BASE_URL = "https://x.ngrok-free.app";
  process.env.DB_PATH = ":memory:"; // don't touch disk in tests
  app = buildApp();
});

afterAll(() => {
  process.env.BASE_URL = priorBaseUrl;
  process.env.DB_PATH = priorDbPath;
});

describe("server routes", () => {
  it("GET /health returns 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /answer returns 200 with a JSON NCCO array", async () => {
    const res = await request(app).get("/answer").query({ uuid: "call-1", from: "15550001111" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[1].action).toBe("connect");
    expect(res.body[1].endpoint[0].uri).toBe("wss://x.ngrok-free.app/socket?callUuid=call-1");
  });

  it("GET /answer returns 500 when BASE_URL is unset", async () => {
    const saved = process.env.BASE_URL;
    delete process.env.BASE_URL;
    try {
      const res = await request(buildApp()).get("/answer");
      expect(res.status).toBe(500);
    } finally {
      process.env.BASE_URL = saved;
    }
  });

  it("POST /event returns 200", async () => {
    const res = await request(app).post("/event").send({ status: "answered", uuid: "call-1" });
    expect(res.status).toBe(200);
  });

  it("POST /event with a completed status still returns 200", async () => {
    const res = await request(app).post("/event").send({ status: "completed", uuid: "call-1" });
    expect(res.status).toBe(200);
  });

  it("unknown routes 404", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
  });
});
