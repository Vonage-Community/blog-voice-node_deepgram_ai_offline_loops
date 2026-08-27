// -----------------------------------------------------------------------------
// The eval_cases table — where both offline loops meet.
//
// The regression runner reads rows from here. The transcript review loop writes
// rows to here. They never call each other; the table is the whole interface
// between them, which is why it gets its own module and its own tests before
// either loop exists.
//
// This file owns the table: its shape, and reading and writing rows. Loading the
// committed starter cases from eval-cases/seed-cases.json is a separate concern
// and lives next door in seed-loader.ts.
//
// It lives in the same calls.db as Part 1's call_records (see AGENTS.md,
// "Where eval cases live"). That buys three things a JSON file would not: a
// proposal can reference the call_id that generated it, approval is a one-line
// UPDATE the blog post can show, and "what's waiting for me?" is a SELECT.
// The trade-off — a SQLite file is not version-controlled, so eval cases get no
// git history and no PR review — is real. A production team would want both.
//
// Like Part 1's storage layer, every function here takes the Database handle
// explicitly instead of opening its own connection. Tests pass ":memory:";
// the CLI opens the file once and hands it down. No module-level global.
// -----------------------------------------------------------------------------

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The four terminal states a call can reach — identical to Part 1's CallOutcome. */
export type ExpectedOutcome = "completed" | "fallback" | "handoff" | "error";

/**
 * Where a case sits in the approval workflow.
 *  - `approved`        — the regression runner will replay it
 *  - `awaiting_review` — the review loop proposed it; a human must approve it first
 *  - `rejected`        — a human looked at it and said no
 */
export type EvalCaseStatus = "approved" | "awaiting_review" | "rejected";

/**
 * Stored in `mock_tool_result` to mean "the 1500ms deadline fired on this one".
 * A timeout is not a value the tool can return — it is the absence of a return —
 * so it cannot be expressed as an OrderResult and needs a sentinel of its own.
 * The replay layer turns this into `{ kind: "timeout", durationMs: 1600 }`.
 */
export const TIMEOUT_SENTINEL = "__timeout__";

/**
 * What to inject instead of calling the real tool: an OrderResult, the timeout
 * sentinel, or null for cases where the tool never runs (a handoff).
 *
 * Typed structurally rather than as Part 1's `OrderResult` on purpose — Part 1's
 * own db.ts does the same thing, keeping the storage layer free of a dependency
 * on the tool module. The runner imports the real type at the point where it
 * actually replays a lookup.
 */
export type MockToolResult = Record<string, unknown> | typeof TIMEOUT_SENTINEL | null;

/** A fully-loaded eval case, JSON parsed and 0/1 integers turned back into booleans. */
export interface EvalCase {
  id: string;
  /** The call this case was proposed from, or null for a hand-authored seed. */
  sourceCallId: string | null;
  createdAt: string; // ISO8601
  /** The caller utterance the runner replays. */
  input: string;
  expectedOutcome: ExpectedOutcome;
  /**
   * One of Part 1's HandoffReason values, or null when no handoff is expected.
   * Left as `string | null` here because the column has no CHECK constraint and
   * storage should not depend on the agent module; the runner narrows it to
   * Part 1's `HandoffReason` when it compares.
   */
  expectedHandoffReason: string | null;
  expectedFallback: boolean;
  expectedToolCalled: boolean;
  mockToolResult: MockToolResult;
  status: EvalCaseStatus;
  notes: string | null;
  /**
   * Every call that contributed to this case, or null for a hand-authored one.
   * A proposal is evidence-backed by definition — "five calls did this" — and
   * `source_call_id` is singular. Rather than overload that column with a JSON
   * array under a singular name, the review loop points `source_call_id` at the
   * one representative call and lists the whole group here.
   */
  sourceCallIds: string[] | null;
}

/**
 * The shape callers actually build. Everything the DDL gives a default to is
 * optional here, so the seed loader and the proposal writer only spell out what
 * they mean.
 */
export interface NewEvalCase {
  id: string;
  createdAt: string;
  input: string;
  expectedOutcome: ExpectedOutcome;
  expectedFallback: boolean;
  expectedToolCalled: boolean;
  sourceCallId?: string | null;
  expectedHandoffReason?: string | null;
  mockToolResult?: MockToolResult;
  status?: EvalCaseStatus;
  notes?: string | null;
  sourceCallIds?: string[] | null;
}

/** The raw column layout of an `eval_cases` row, as SQLite returns it. */
interface EvalCaseRow {
  id: string;
  source_call_id: string | null;
  created_at: string;
  input: string;
  expected_outcome: string;
  expected_handoff_reason: string | null;
  expected_fallback: number;
  expected_tool_called: number;
  mock_tool_result: string | null;
  status: string;
  notes: string | null;
  source_call_ids: string | null;
}

/**
 * DDL. The CHECK constraints are the point: an eval suite that can hold
 * `expected_outcome = 'complted'` will silently never match, and you will spend
 * an afternoon debugging the runner instead of the typo. Let SQLite reject it.
 *
 * `mock_tool_result` is TEXT because it holds three different things — a JSON
 * OrderResult, the string "__timeout__", or NULL. Booleans are 0/1 INTEGERs,
 * matching Part 1's convention (SQLite has no boolean type).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_cases (
  id                      TEXT PRIMARY KEY,
  source_call_id          TEXT,            -- null for hand-authored cases
  created_at              TEXT NOT NULL,
  input                   TEXT NOT NULL,   -- the caller utterance to replay
  expected_outcome        TEXT NOT NULL
    CHECK (expected_outcome IN ('completed', 'fallback', 'handoff', 'error')),
  expected_handoff_reason TEXT,            -- billing | returns | cancellation | account | unsupported | null
  expected_fallback       INTEGER NOT NULL DEFAULT 0
    CHECK (expected_fallback IN (0, 1)),
  expected_tool_called    INTEGER NOT NULL DEFAULT 1
    CHECK (expected_tool_called IN (0, 1)),
  mock_tool_result        TEXT,            -- JSON OrderResult, "__timeout__", or null
  status                  TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'awaiting_review', 'rejected')),
  notes                   TEXT,            -- human-readable explanation
  source_call_ids         TEXT             -- JSON array of contributing call ids
);

-- Both loops filter on status: the runner wants 'approved', the review loop
-- checks what is already 'awaiting_review' before proposing a duplicate.
CREATE INDEX IF NOT EXISTS idx_eval_cases_status ON eval_cases (status);
`;

/**
 * Columns added after the table's original shape. `CREATE TABLE IF NOT EXISTS` is
 * a no-op against a database seeded by an earlier version, so any column added
 * later has to be applied separately. This mirrors `ensureColumns` in Part 1's
 * `src/storage/db.ts` — the smallest upgrade path that avoids pulling in a
 * migrations framework, and a no-op on a freshly created table.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["source_call_ids", "TEXT"],
];

/** Create the eval_cases table if it does not exist. Safe to call on every run. */
export function ensureEvalSchema(db: DatabaseType): void {
  db.exec(SCHEMA);

  const existing = new Set(
    (db.prepare("PRAGMA table_info(eval_cases)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const [name, definition] of ADDED_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE eval_cases ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * Open the shared database and make sure the eval schema is there.
 *
 * Note what this does *not* do: create `call_records`. That table is Part 1's,
 * and the loops only read it. If it is missing, the database you pointed at is
 * not the one your agent has been writing to — better to fail on a missing
 * table than to silently review zero calls.
 */
export function openEvalDatabase(dbPath: string): DatabaseType {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // the live agent may be writing while we read
  db.pragma("foreign_keys = ON");
  ensureEvalSchema(db);

  return db;
}

/**
 * Insert one eval case. Returns true if the row was written, false if a case
 * with that id already existed.
 *
 * Two decisions are packed into that one sentence.
 *
 * First: an existing row always wins — no `OR REPLACE`. Both the seed loader and
 * the proposal writer run repeatedly against a database a human has been
 * editing. If you approve proposal-001 today and the loop overwrites it back to
 * `awaiting_review` tomorrow, that is silent data loss on a schedule.
 *
 * Second: `ON CONFLICT(id) DO NOTHING`, *not* `INSERT OR IGNORE`, which is the
 * obvious way to write this and is wrong here. `OR IGNORE` skips a row that
 * violates *any* constraint — so a proposal with a typo'd outcome would be
 * dropped on the floor without a word, and this function would report it as an
 * ordinary duplicate. Naming the conflict target keeps the CHECK constraints
 * loud: only an id collision is tolerated, everything else still throws.
 */
export function insertEvalCase(db: DatabaseType, evalCase: NewEvalCase): boolean {
  const result = db
    .prepare(
      `INSERT INTO eval_cases
        (id, source_call_id, created_at, input, expected_outcome, expected_handoff_reason,
         expected_fallback, expected_tool_called, mock_tool_result, status, notes,
         source_call_ids)
       VALUES
        (@id, @sourceCallId, @createdAt, @input, @expectedOutcome, @expectedHandoffReason,
         @expectedFallback, @expectedToolCalled, @mockToolResult, @status, @notes,
         @sourceCallIds)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run({
      id: evalCase.id,
      sourceCallId: evalCase.sourceCallId ?? null,
      createdAt: evalCase.createdAt,
      input: evalCase.input,
      expectedOutcome: evalCase.expectedOutcome,
      expectedHandoffReason: evalCase.expectedHandoffReason ?? null,
      expectedFallback: evalCase.expectedFallback ? 1 : 0,
      expectedToolCalled: evalCase.expectedToolCalled ? 1 : 0,
      mockToolResult: serializeMockToolResult(evalCase.mockToolResult ?? null),
      status: evalCase.status ?? "approved",
      notes: evalCase.notes ?? null,
      sourceCallIds: evalCase.sourceCallIds ? JSON.stringify(evalCase.sourceCallIds) : null,
    });

  return result.changes === 1;
}

/** Load one eval case by id, fully deserialized, or null if it does not exist. */
export function getEvalCase(db: DatabaseType, id: string): EvalCase | null {
  const row = db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id) as
    | EvalCaseRow
    | undefined;

  return row ? fromRow(row) : null;
}

/**
 * List eval cases, optionally filtered by status, oldest first so a report reads
 * in the order the suite grew. `listEvalCases(db, "approved")` is the regression
 * runner's entire input.
 */
export function listEvalCases(db: DatabaseType, status?: EvalCaseStatus): EvalCase[] {
  const rows = (
    status
      ? db.prepare("SELECT * FROM eval_cases WHERE status = ? ORDER BY created_at, id").all(status)
      : db.prepare("SELECT * FROM eval_cases ORDER BY created_at, id").all()
  ) as EvalCaseRow[];

  return rows.map(fromRow);
}

// --- Row mapping -----------------------------------------------------------

/** The sentinel stays a bare string in the column; anything else is JSON-encoded. */
function serializeMockToolResult(value: MockToolResult): string | null {
  if (value === null) return null;
  if (value === TIMEOUT_SENTINEL) return TIMEOUT_SENTINEL;
  return JSON.stringify(value);
}

function deserializeMockToolResult(value: string | null): MockToolResult {
  if (value === null) return null;
  if (value === TIMEOUT_SENTINEL) return TIMEOUT_SENTINEL;
  return JSON.parse(value) as Record<string, unknown>;
}

function fromRow(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    sourceCallId: row.source_call_id,
    createdAt: row.created_at,
    input: row.input,
    expectedOutcome: row.expected_outcome as ExpectedOutcome,
    expectedHandoffReason: row.expected_handoff_reason,
    expectedFallback: row.expected_fallback === 1,
    expectedToolCalled: row.expected_tool_called === 1,
    mockToolResult: deserializeMockToolResult(row.mock_tool_result),
    status: row.status as EvalCaseStatus,
    notes: row.notes,
    sourceCallIds: row.source_call_ids
      ? (JSON.parse(row.source_call_ids) as string[])
      : null,
  };
}
