// -----------------------------------------------------------------------------
// SQLite setup + schema for the call record — the bridge to Part 2.
//
// Every call writes exactly one row here before the connection closes. Part 2's
// offline loops read these rows to build regression tests and transcript
// review, so the schema is a contract: do not drop or rename fields (AGENTS.md).
//
// Nested, variable-length parts of the record (transcript, tool calls, latency)
// are stored as JSON text in their own columns. The scalar, queryable fields
// (outcome, fallbackUsed, handoffRequested, timestamps) get real columns so
// Part 2 can filter — e.g. "every call that hit the fallback" — without parsing
// JSON. `call-records.ts` (a later task) owns serialization to/from these rows.
// -----------------------------------------------------------------------------

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HandoffReason } from "../agent/tool-policy.js";

/** One utterance in the transcript, from either party, timestamped from call start. */
export interface TranscriptEntry {
  speaker: "caller" | "agent";
  text: string;
  timestampMs: number;
}

/** Import kept local to storage to avoid a runtime dependency cycle with the tool. */
type OrderResultJson = Record<string, unknown>;

/** A record of the one tool invocation (with its retry folded into duration/outcome). */
export interface ToolCallRecord {
  tool: "getOrderStatus";
  args: { orderId: string };
  durationMs: number;
  result: OrderResultJson | "timeout";
  success: boolean;
}

/** Per-stage latency for the turn, in milliseconds. */
export interface LatencyBreakdown {
  speechToTextMs: number;
  modelMs: number;
  toolMs: number;
  textToSpeechMs: number;
  totalTurnMs: number;
}

export type CallOutcome = "completed" | "fallback" | "handoff" | "error";

/**
 * The full call record. This is the exact shape Part 2 will read. Every field
 * is required; there are no optional fields, so an incomplete record is a bug,
 * not a valid state.
 */
export interface CallRecord {
  callId: string;
  /** Which agent version handled this call — lets Part 2 compare v1 vs v2. */
  agentVersion: string;
  startedAt: string; // ISO8601
  endedAt: string; // ISO8601
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  latency: LatencyBreakdown;
  fallbackUsed: boolean;
  handoffRequested: boolean;
  /** The category of handoff, or null if no handoff occurred. */
  handoffReason: HandoffReason | null;
  outcome: CallOutcome;
}

/**
 * DDL for the call_records table. JSON blobs for the nested parts; real columns
 * for everything Part 2 will want to filter or sort on. Booleans are stored as
 * 0/1 INTEGERs (SQLite has no native boolean).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS call_records (
  call_id            TEXT PRIMARY KEY,
  agent_version      TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  transcript         TEXT NOT NULL,   -- JSON: TranscriptEntry[]
  tool_calls         TEXT NOT NULL,   -- JSON: ToolCallRecord[]
  latency            TEXT NOT NULL,   -- JSON: LatencyBreakdown
  fallback_used      INTEGER NOT NULL CHECK (fallback_used IN (0, 1)),
  handoff_requested  INTEGER NOT NULL CHECK (handoff_requested IN (0, 1)),
  handoff_reason     TEXT CHECK (handoff_reason IS NULL OR handoff_reason IN
                       ('billing', 'returns', 'cancellation', 'account', 'unsupported')),
  outcome            TEXT NOT NULL CHECK (outcome IN ('completed', 'fallback', 'handoff', 'error'))
);

-- Part 2 filters by outcome ("show me every fallback") and by time.
CREATE INDEX IF NOT EXISTS idx_call_records_outcome ON call_records (outcome);
CREATE INDEX IF NOT EXISTS idx_call_records_started_at ON call_records (started_at);
`;

/**
 * Columns added after the table's original shape. On a database created by an
 * older version, `CREATE TABLE IF NOT EXISTS` is a no-op and these columns would
 * be missing — so we add any that aren't present yet. This is the smallest
 * upgrade path that avoids a real migrations framework (the project has none),
 * and it's a no-op on a freshly-created table. `agent_version` takes a DEFAULT
 * so pre-existing rows satisfy NOT NULL.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["agent_version", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["handoff_reason", "TEXT"],
];

function ensureColumns(db: DatabaseType): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(call_records)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const [name, definition] of ADDED_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE call_records ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * Open (or create) the call-records database and ensure the schema exists.
 *
 * Pass ":memory:" for an ephemeral database — tests use this so they never
 * touch disk. For a file path, the parent directory is created if missing.
 * WAL mode is enabled for file databases so a reader (Part 2) and the live
 * writer don't block each other.
 */
export function openDatabase(dbPath: string): DatabaseType {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  ensureColumns(db); // upgrade a pre-existing table with any new columns

  return db;
}
