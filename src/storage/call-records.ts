// -----------------------------------------------------------------------------
// Read/write the call record — the serialization layer over the schema in db.ts.
//
// db.ts owns the table shape; this file owns turning a `CallRecord` object into
// a row and back. The split matters because Part 2 will import `readCallRecord`
// to replay stored evidence, and it should get a fully-typed `CallRecord` back
// with the JSON columns already parsed and the 0/1 integers already turned into
// booleans — never a raw row.
//
// Both functions take the `Database` handle explicitly rather than opening their
// own connection. The live path opens one database for the process (server.ts,
// later) and hands it in; tests open an in-memory one. No module-level global.
// -----------------------------------------------------------------------------

import type { Database as DatabaseType } from "better-sqlite3";
import type { HandoffReason } from "../agent/tool-policy.js";
import type {
  CallRecord,
  CallOutcome,
  LatencyBreakdown,
  ToolCallRecord,
  TranscriptEntry,
} from "./db.js";

/** The raw column layout of a `call_records` row, as SQLite returns it. */
interface CallRecordRow {
  call_id: string;
  agent_version: string;
  started_at: string;
  ended_at: string;
  transcript: string;
  tool_calls: string;
  latency: string;
  fallback_used: number;
  handoff_requested: number;
  handoff_reason: string | null;
  outcome: string;
}

/**
 * Persist one call record. Uses INSERT OR REPLACE so a re-write for the same
 * callId overwrites cleanly (a call is written exactly once at hang-up, but
 * idempotency keeps error-recovery paths simple). Nested parts are JSON-encoded;
 * booleans become 0/1 to match the schema's CHECK constraints.
 */
export function writeCallRecord(db: DatabaseType, record: CallRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO call_records
      (call_id, agent_version, started_at, ended_at, transcript, tool_calls, latency,
       fallback_used, handoff_requested, handoff_reason, outcome)
     VALUES
      (@callId, @agentVersion, @startedAt, @endedAt, @transcript, @toolCalls, @latency,
       @fallbackUsed, @handoffRequested, @handoffReason, @outcome)`,
  ).run({
    callId: record.callId,
    agentVersion: record.agentVersion,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    transcript: JSON.stringify(record.transcript),
    toolCalls: JSON.stringify(record.toolCalls),
    latency: JSON.stringify(record.latency),
    fallbackUsed: record.fallbackUsed ? 1 : 0,
    handoffRequested: record.handoffRequested ? 1 : 0,
    handoffReason: record.handoffReason,
    outcome: record.outcome,
  });
}

/**
 * Load one call record by id, fully deserialized, or `null` if none exists.
 * JSON columns are parsed and 0/1 integers are turned back into booleans, so
 * callers (including Part 2) always receive a clean `CallRecord`.
 */
export function readCallRecord(db: DatabaseType, callId: string): CallRecord | null {
  const row = db
    .prepare("SELECT * FROM call_records WHERE call_id = ?")
    .get(callId) as CallRecordRow | undefined;

  if (!row) return null;

  return {
    callId: row.call_id,
    agentVersion: row.agent_version,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    transcript: JSON.parse(row.transcript) as TranscriptEntry[],
    toolCalls: JSON.parse(row.tool_calls) as ToolCallRecord[],
    latency: JSON.parse(row.latency) as LatencyBreakdown,
    fallbackUsed: row.fallback_used === 1,
    handoffRequested: row.handoff_requested === 1,
    handoffReason: row.handoff_reason as HandoffReason | null,
    outcome: row.outcome as CallOutcome,
  };
}
