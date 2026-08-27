// Shared fixtures for the review-loop tests.
//
// Records are written with Part 1's own `writeCallRecord` into Part 1's own
// schema, so a fixture cannot drift from what the live agent actually stores —
// which is the whole risk when a test hand-writes rows for the code under test
// to read back.

import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, type CallRecord } from "../../../src/storage/db.js";
import { writeCallRecord } from "../../../src/storage/call-records.js";
import { ensureEvalSchema } from "../../src/db/eval-schema.js";

/**
 * An in-memory database with both tables: `call_records` from Part 1's DDL and
 * `eval_cases` from Part 2's. Never the real data/calls.db.
 */
export function testDatabase(): DatabaseType {
  const db = openDatabase(":memory:");
  ensureEvalSchema(db);
  return db;
}

const ZERO_LATENCY = {
  speechToTextMs: 0,
  modelMs: 0,
  toolMs: 0,
  textToSpeechMs: 0,
  totalTurnMs: 0,
};

/** A completed order-status call. Every other fixture starts from this. */
export function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    agentVersion: "order-status-v1",
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:00:30.000Z",
    transcript: [
      { speaker: "agent", text: "What's your order number?", timestampMs: 500 },
      { speaker: "caller", text: "Where is order A1001?", timestampMs: 2000 },
    ],
    toolCalls: [
      {
        tool: "getOrderStatus",
        args: { orderId: "A1001" },
        durationMs: 120,
        result: { status: "in_transit", estimatedDelivery: "2026-08-25" },
        success: true,
      },
    ],
    latency: ZERO_LATENCY,
    fallbackUsed: false,
    handoffRequested: false,
    handoffReason: null,
    outcome: "completed",
    ...overrides,
  };
}

/** A call that handed off, carrying the utterance that triggered it. */
export function handoffCall(
  callId: string,
  reason: CallRecord["handoffReason"],
  utterance: string,
  startedAt = "2026-08-20T10:00:00.000Z",
): CallRecord {
  return callRecord({
    callId,
    startedAt,
    outcome: "handoff",
    handoffRequested: true,
    handoffReason: reason,
    toolCalls: [],
    transcript: [
      { speaker: "agent", text: "How can I help?", timestampMs: 500 },
      { speaker: "caller", text: utterance, timestampMs: 2000 },
    ],
  });
}

/** A call where the tool blew the deadline — stored as the bare string "timeout". */
export function timeoutCall(
  callId: string,
  orderId = "SLOW999",
  startedAt = "2026-08-20T10:00:00.000Z",
): CallRecord {
  return callRecord({
    callId,
    startedAt,
    outcome: "fallback",
    fallbackUsed: true,
    toolCalls: [
      {
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: 1502,
        result: "timeout",
        success: false,
      },
    ],
    transcript: [
      { speaker: "caller", text: `Where is order ${orderId}?`, timestampMs: 2000 },
    ],
  });
}

/** A call where the policy refused a second lookup — a fallback with no timeout. */
export function blockedFallbackCall(
  callId: string,
  orderId = "B2002",
  startedAt = "2026-08-20T10:00:00.000Z",
): CallRecord {
  return callRecord({
    callId,
    startedAt,
    outcome: "fallback",
    fallbackUsed: true,
    toolCalls: [
      {
        tool: "getOrderStatus",
        args: { orderId: "A1001" },
        durationMs: 120,
        result: { status: "in_transit", estimatedDelivery: "2026-08-25" },
        success: true,
      },
      {
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: 0,
        result: {
          status: "error",
          reason: "The single allowed tool call has already been made (limit 1).",
        },
        success: false,
      },
    ],
  });
}

export function seedCalls(db: DatabaseType, records: CallRecord[]): void {
  for (const record of records) writeCallRecord(db, record);
}
