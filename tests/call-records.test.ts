import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, type CallRecord } from "../src/storage/db.js";
import { readCallRecord, writeCallRecord } from "../src/storage/call-records.js";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function baseRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
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
    ...overrides,
  };
}

describe("writeCallRecord / readCallRecord", () => {
  it("round-trips every field of a completed call", () => {
    const record = baseRecord();
    writeCallRecord(db, record);
    const loaded = readCallRecord(db, record.callId);
    expect(loaded).toEqual(record);
  });

  it("returns null for an unknown callId", () => {
    expect(readCallRecord(db, "does-not-exist")).toBeNull();
  });

  it("preserves boolean flags as real booleans, not 0/1", () => {
    const record = baseRecord({
      callId: "call-fallback",
      fallbackUsed: true,
      handoffRequested: false,
      outcome: "fallback",
    });
    writeCallRecord(db, record);
    const loaded = readCallRecord(db, record.callId)!;
    expect(loaded.fallbackUsed).toBe(true);
    expect(loaded.handoffRequested).toBe(false);
    expect(typeof loaded.fallbackUsed).toBe("boolean");
  });

  it.each(["completed", "fallback", "handoff", "error"] as const)(
    "stores and reads back the %s outcome",
    (outcome) => {
      const record = baseRecord({ callId: `call-${outcome}`, outcome });
      writeCallRecord(db, record);
      expect(readCallRecord(db, record.callId)?.outcome).toBe(outcome);
    },
  );

  it("round-trips agentVersion and a non-null handoffReason", () => {
    const record = baseRecord({
      callId: "call-handoff-billing",
      agentVersion: "order-status-v2",
      handoffRequested: true,
      handoffReason: "billing",
      outcome: "handoff",
    });
    writeCallRecord(db, record);
    const loaded = readCallRecord(db, record.callId)!;
    expect(loaded.agentVersion).toBe("order-status-v2");
    expect(loaded.handoffReason).toBe("billing");
  });

  it("handles a timeout tool result and an empty transcript", () => {
    const record = baseRecord({
      callId: "call-timeout",
      transcript: [],
      toolCalls: [
        {
          tool: "getOrderStatus",
          args: { orderId: "SLOW-1" },
          durationMs: 1500,
          result: "timeout",
          success: false,
        },
      ],
      fallbackUsed: true,
      outcome: "fallback",
    });
    writeCallRecord(db, record);
    const loaded = readCallRecord(db, record.callId)!;
    expect(loaded.transcript).toEqual([]);
    expect(loaded.toolCalls[0]?.result).toBe("timeout");
    expect(loaded.toolCalls[0]?.success).toBe(false);
  });

  it("overwrites an existing record for the same callId (idempotent write)", () => {
    writeCallRecord(db, baseRecord({ outcome: "completed" }));
    writeCallRecord(db, baseRecord({ outcome: "handoff", handoffRequested: true }));
    const loaded = readCallRecord(db, "call-1")!;
    expect(loaded.outcome).toBe("handoff");
    expect(loaded.handoffRequested).toBe(true);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM call_records")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
