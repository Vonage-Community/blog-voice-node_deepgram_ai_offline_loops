import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, type CallRecord } from "../src/storage/db.js";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const sampleRecord: CallRecord = {
  callId: "call-uuid-1",
  agentVersion: "order-status-v1",
  handoffReason: null,
  startedAt: "2026-07-27T10:00:00.000Z",
  endedAt: "2026-07-27T10:00:12.000Z",
  transcript: [
    { speaker: "agent", text: "What's your order number?", timestampMs: 500 },
    { speaker: "caller", text: "A1001", timestampMs: 2300 },
  ],
  toolCalls: [
    {
      tool: "getOrderStatus",
      args: { orderId: "A1001" },
      durationMs: 130,
      result: { status: "in_transit", estimatedDelivery: "2026-07-29" },
      success: true,
    },
  ],
  latency: {
    speechToTextMs: 240,
    modelMs: 410,
    toolMs: 130,
    textToSpeechMs: 300,
    totalTurnMs: 1080,
  },
  fallbackUsed: false,
  handoffRequested: false,
  outcome: "completed",
};

function insert(record: CallRecord): void {
  db.prepare(
    `INSERT INTO call_records
      (call_id, agent_version, started_at, ended_at, transcript, tool_calls, latency,
       fallback_used, handoff_requested, handoff_reason, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.callId,
    record.agentVersion,
    record.startedAt,
    record.endedAt,
    JSON.stringify(record.transcript),
    JSON.stringify(record.toolCalls),
    JSON.stringify(record.latency),
    record.fallbackUsed ? 1 : 0,
    record.handoffRequested ? 1 : 0,
    record.handoffReason,
    record.outcome,
  );
}

describe("openDatabase", () => {
  it("creates the call_records table", () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_records'",
      )
      .get();
    expect(row).toEqual({ name: "call_records" });
  });

  it("round-trips a full call record through every column", () => {
    insert(sampleRecord);
    const row = db
      .prepare("SELECT * FROM call_records WHERE call_id = ?")
      .get(sampleRecord.callId) as Record<string, unknown>;

    expect(row.started_at).toBe(sampleRecord.startedAt);
    expect(row.ended_at).toBe(sampleRecord.endedAt);
    expect(row.agent_version).toBe("order-status-v1");
    expect(row.fallback_used).toBe(0);
    expect(row.handoff_requested).toBe(0);
    expect(row.handoff_reason).toBeNull();
    expect(row.outcome).toBe("completed");
    expect(JSON.parse(row.transcript as string)).toEqual(sampleRecord.transcript);
    expect(JSON.parse(row.tool_calls as string)).toEqual(sampleRecord.toolCalls);
    expect(JSON.parse(row.latency as string)).toEqual(sampleRecord.latency);
  });

  it("enforces the outcome CHECK constraint", () => {
    expect(() => insert({ ...sampleRecord, outcome: "banana" as never })).toThrow();
  });

  it("enforces the handoff_reason CHECK constraint", () => {
    expect(() =>
      insert({ ...sampleRecord, callId: "bad-reason", handoffReason: "weather" as never }),
    ).toThrow();
    // A valid reason and null are both accepted.
    expect(() =>
      insert({ ...sampleRecord, callId: "ok-billing", handoffReason: "billing" }),
    ).not.toThrow();
  });

  it("enforces the primary key (one row per callId)", () => {
    insert(sampleRecord);
    expect(() => insert(sampleRecord)).toThrow();
  });
});
