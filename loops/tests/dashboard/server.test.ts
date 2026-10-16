// The dashboard's four JSON endpoints.
//
// `createDashboardApp` takes an open database, so every test here runs against
// `:memory:` and supertest drives the app without binding a port — no fixture
// server, no cleanup, and nothing that can touch the real data/calls.db.
//
// The HTML file is not tested, on purpose. It has no build step and no logic
// worth asserting that a browser would not immediately show you; the endpoints
// it reads are what has contracts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDashboardApp } from "../../src/dashboard/server.js";
import { ensureEvalSchema, insertEvalCase } from "../../src/db/eval-schema.js";
import { openDatabase } from "../../../src/storage/db.js";
import { writeCallRecord } from "../../../src/storage/call-records.js";
import type { CallRecord } from "../../../src/storage/db.js";

let db: DatabaseType;
let app: ReturnType<typeof createDashboardApp>;

beforeEach(() => {
  // Part 1's schema for call_records, Part 2's for eval_cases — the same pairing
  // the real file has.
  db = openDatabase(":memory:");
  ensureEvalSchema(db);
  app = createDashboardApp(db);
});

afterEach(() => {
  db.close();
});

/**
 * A proposal in whatever state the test needs. Shaped like one the review loop
 * writes: it carries its evidence in both `source_call_id` (one representative
 * call) and `source_call_ids` (the whole group).
 */
function evalCase(id: string, status: "pending" | "added" | "dismissed", input = id): void {
  insertEvalCase(db, {
    id,
    createdAt: "2026-08-28T10:00:00.000Z",
    input,
    expectedOutcome: "handoff",
    expectedHandoffReason: "returns",
    expectedFallback: false,
    expectedToolCalled: false,
    status,
    notes: `notes for ${id}`,
    sourceCallId: "call-a",
    sourceCallIds: ["call-a", "call-b"],
  });
}

/** A hand-written case, as the seed loader writes it: no source calls at all. */
function seedCase(id: string): void {
  insertEvalCase(db, {
    id,
    createdAt: "2026-08-01T10:00:00.000Z",
    input: "Where is order A1001?",
    expectedOutcome: "completed",
    expectedFallback: false,
    expectedToolCalled: true,
    mockToolResult: { status: "in_transit", estimatedDelivery: "2026-08-05" },
    status: "added",
    notes: "Happy path",
  });
}

/** Built with Part 1's own writer, so a fixture cannot drift from the live schema. */
function call(callId: string, startedAt: string): CallRecord {
  return {
    callId,
    agentVersion: "order-status-v1",
    startedAt,
    endedAt: startedAt,
    transcript: [{ speaker: "caller", text: "Where is order A1001?", timestampMs: 100 }],
    toolCalls: [],
    latency: { speechToTextMs: 0, modelMs: 0, toolMs: 0, textToSpeechMs: 0, totalTurnMs: 0 },
    fallbackUsed: false,
    handoffRequested: false,
    handoffReason: null,
    outcome: "completed",
  };
}

describe("GET /api/proposals", () => {
  it("returns only pending cases", async () => {
    evalCase("p-1", "pending");
    evalCase("a-1", "added");
    evalCase("d-1", "dismissed");

    const response = await request(app).get("/api/proposals");

    expect(response.status).toBe(200);
    expect(response.body.map((p: { id: string }) => p.id)).toEqual(["p-1"]);
  });

  it("parses source_call_ids into an array for the evidence count", async () => {
    evalCase("p-1", "pending");

    const { body } = await request(app).get("/api/proposals");

    expect(body[0].source_call_ids).toEqual(["call-a", "call-b"]);
    expect(body[0].notes).toBe("notes for p-1");
  });

  it("returns an empty array when nothing is waiting", async () => {
    const { body } = await request(app).get("/api/proposals");
    expect(body).toEqual([]);
  });
});

describe("POST /api/proposals/:id/add", () => {
  it("updates the status to added and returns 200", async () => {
    evalCase("p-1", "pending");

    const response = await request(app).post("/api/proposals/p-1/add");

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status FROM eval_cases WHERE id = 'p-1'").get()).toEqual({
      status: "added",
    });
  });

  it("removes the case from the pending queue", async () => {
    evalCase("p-1", "pending");
    await request(app).post("/api/proposals/p-1/add");

    const { body } = await request(app).get("/api/proposals");

    expect(body).toEqual([]);
  });

  it("returns 404 for an id that does not exist", async () => {
    const response = await request(app).post("/api/proposals/nope/add");

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("nope");
  });
});

describe("POST /api/proposals/:id/dismiss", () => {
  it("updates the status to dismissed and returns 200", async () => {
    evalCase("p-1", "pending");

    const response = await request(app).post("/api/proposals/p-1/dismiss");

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status FROM eval_cases WHERE id = 'p-1'").get()).toEqual({
      status: "dismissed",
    });
  });

  it("returns 404 for an id that does not exist", async () => {
    expect((await request(app).post("/api/proposals/nope/dismiss")).status).toBe(404);
  });

  it("leaves a dismissed case available to the review loop again", async () => {
    // Not an assertion about the dashboard so much as a guard on it: dismissing
    // through the UI has to land in exactly the state the review loop treats as
    // re-proposable, or the button quietly means something different from the
    // documented `sqlite3` command.
    evalCase("p-1", "pending");
    await request(app).post("/api/proposals/p-1/dismiss");

    const row = db.prepare("SELECT status FROM eval_cases WHERE id = 'p-1'").get() as {
      status: string;
    };
    expect(row.status).toBe("dismissed");
  });
});

describe("GET /api/eval-runs", () => {
  it("returns an array", async () => {
    const response = await request(app).get("/api/eval-runs");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe("GET /api/calls", () => {
  it("returns at most 20 rows, newest first", async () => {
    // 25 calls, one per day, so the ordering is unambiguous.
    for (let day = 1; day <= 25; day += 1) {
      const date = String(day).padStart(2, "0");
      writeCallRecord(db, call(`call-${date}`, `2026-08-${date}T10:00:00.000Z`));
    }

    const { body } = await request(app).get("/api/calls");

    expect(body).toHaveLength(20);
    expect(body[0].call_id).toBe("call-25");
    expect(body[19].call_id).toBe("call-06");
  });

  it("returns the columns the table renders", async () => {
    writeCallRecord(db, call("call-1", "2026-08-01T10:00:00.000Z"));

    const { body } = await request(app).get("/api/calls");

    expect(Object.keys(body[0]).sort()).toEqual([
      "agent_version",
      "call_id",
      "fallback_used",
      "handoff_reason",
      "outcome",
      "started_at",
    ]);
  });

  it("returns an empty array when no calls exist", async () => {
    expect((await request(app).get("/api/calls")).body).toEqual([]);
  });
});

describe("GET /api/decisions", () => {
  it("returns proposals a human has added or dismissed, never pending ones", async () => {
    evalCase("p-1", "pending");
    evalCase("a-1", "added");
    evalCase("d-1", "dismissed");

    const { status, body } = await request(app).get("/api/decisions");

    expect(status).toBe(200);
    expect(body.map((d: { id: string; status: string }) => [d.id, d.status]).sort()).toEqual([
      ["a-1", "added"],
      ["d-1", "dismissed"],
    ]);
  });

  it("leaves out hand-written seed cases, even though they are in the suite", async () => {
    // A seed is `added` too, but nobody decided anything — it was written by
    // hand before there were any calls. Only cases the loop proposed from
    // evidence are decisions.
    seedCase("seed-001");
    evalCase("a-1", "added");

    const { body } = await request(app).get("/api/decisions");

    expect(body.map((d: { id: string }) => d.id)).toEqual(["a-1"]);
  });

  it("carries the question, the assertion, and the evidence", async () => {
    evalCase("a-1", "added", "I want to return my order");

    const { body } = await request(app).get("/api/decisions");

    expect(body[0]).toMatchObject({
      input: "I want to return my order",
      notes: "notes for a-1",
      expected_outcome: "handoff",
      expected_handoff_reason: "returns",
      source_call_ids: ["call-a", "call-b"],
    });
  });

  it("picks up a proposal the moment it is added", async () => {
    evalCase("p-1", "pending");
    expect((await request(app).get("/api/decisions")).body).toEqual([]);

    await request(app).post("/api/proposals/p-1/add");

    const { body } = await request(app).get("/api/decisions");
    expect(body.map((d: { id: string; status: string }) => [d.id, d.status])).toEqual([
      ["p-1", "added"],
    ]);
  });

  it("returns an empty array when nothing has been decided", async () => {
    expect((await request(app).get("/api/decisions")).body).toEqual([]);
  });
});
