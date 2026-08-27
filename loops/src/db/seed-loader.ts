// -----------------------------------------------------------------------------
// Seed loader — the four hand-authored cases that bootstrap the eval suite.
//
// An eval suite has a chicken-and-egg problem: the transcript review loop
// proposes cases from real calls, but on day one you have no cases to regress
// against and no confidence the runner works. So the suite starts with four
// cases written by hand, mirroring the four calls from Part 1's "Try Four
// Calls" section — happy path, timeout, not-found, and out-of-scope handoff.
//
// They live in eval-cases/seed-cases.json rather than in this file for one
// reason: that file *is* version-controlled, while the SQLite database is not.
// A reader adding a fifth case edits JSON and gets a diff for it.
//
// Loading runs on every eval run, so it must be idempotent — see loadSeedCases.
// -----------------------------------------------------------------------------

import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  insertEvalCase,
  TIMEOUT_SENTINEL,
  type ExpectedOutcome,
  type MockToolResult,
} from "./eval-schema.js";

/** A seed case as authored in eval-cases/seed-cases.json (no created_at — we stamp it). */
export interface SeedCase {
  id: string;
  input: string;
  expectedOutcome: ExpectedOutcome;
  expectedFallback: boolean;
  expectedToolCalled: boolean;
  expectedHandoffReason?: string;
  mockToolResult?: MockToolResult;
  notes?: string;
}

/** Resolved from this module, not from process.cwd() — `npm run eval` works from anywhere. */
export const SEED_CASES_PATH = fileURLToPath(
  new URL("../../eval-cases/seed-cases.json", import.meta.url),
);

export interface LoadSeedResult {
  /** Cases written on this run. */
  inserted: string[];
  /** Cases already present, left untouched. */
  skipped: string[];
}

/**
 * Load the hand-authored seed cases into the database.
 *
 * Called at the top of every eval run, which is why it has to be idempotent:
 * the first run seeds four cases, every run after that inserts nothing and
 * changes nothing. Pass `cases` to seed from memory instead of the file (tests
 * do), and `now` to stamp a fixed created_at.
 */
export function loadSeedCases(
  db: DatabaseType,
  options: { cases?: SeedCase[]; now?: string } = {},
): LoadSeedResult {
  const cases = options.cases ?? readSeedCasesFile();
  const createdAt = options.now ?? new Date().toISOString();

  const inserted: string[] = [];
  const skipped: string[] = [];

  // One transaction: either the whole seed set lands or none of it does, so a
  // malformed case at index 3 cannot leave a half-seeded suite behind.
  db.transaction(() => {
    for (const seed of cases) {
      const written = insertEvalCase(db, {
        ...seed,
        createdAt,
        sourceCallId: null, // hand-authored: no call produced this
        status: "approved", // seeds are pre-approved by definition
        notes: seed.notes ?? null,
      });
      (written ? inserted : skipped).push(seed.id);
    }
  })();

  return { inserted, skipped };
}

/** Read and validate eval-cases/seed-cases.json. Throws on a malformed file. */
export function readSeedCasesFile(path: string = SEED_CASES_PATH): SeedCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of seed cases`);
  }
  return parsed.map((raw, index) => parseSeedCase(raw, index, path));
}

const OUTCOMES: readonly string[] = ["completed", "fallback", "handoff", "error"];

/**
 * Validate one seed case. These are hand-edited files — a reader adding a fifth
 * case will typo a field name eventually. Fail loudly at load, naming the case,
 * rather than inserting a half-built row and failing mysteriously in the runner.
 */
function parseSeedCase(raw: unknown, index: number, path: string): SeedCase {
  const where = `${path}[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: expected an object`);
  }

  const c = raw as Record<string, unknown>;
  const check = <T>(field: string, ok: boolean, value: unknown): T => {
    if (!ok) throw new Error(`${where} (${String(c.id ?? "no id")}): invalid "${field}"`);
    return value as T;
  };

  return {
    id: check<string>("id", typeof c.id === "string" && c.id.length > 0, c.id),
    input: check<string>("input", typeof c.input === "string" && c.input.length > 0, c.input),
    expectedOutcome: check<ExpectedOutcome>(
      "expectedOutcome",
      typeof c.expectedOutcome === "string" && OUTCOMES.includes(c.expectedOutcome),
      c.expectedOutcome,
    ),
    expectedFallback: check<boolean>(
      "expectedFallback",
      typeof c.expectedFallback === "boolean",
      c.expectedFallback,
    ),
    expectedToolCalled: check<boolean>(
      "expectedToolCalled",
      typeof c.expectedToolCalled === "boolean",
      c.expectedToolCalled,
    ),
    expectedHandoffReason: check<string | undefined>(
      "expectedHandoffReason",
      c.expectedHandoffReason === undefined || typeof c.expectedHandoffReason === "string",
      c.expectedHandoffReason,
    ),
    mockToolResult: check<MockToolResult | undefined>(
      "mockToolResult",
      c.mockToolResult === undefined ||
        c.mockToolResult === null ||
        c.mockToolResult === TIMEOUT_SENTINEL ||
        (typeof c.mockToolResult === "object" && !Array.isArray(c.mockToolResult)),
      c.mockToolResult,
    ),
    notes: check<string | undefined>(
      "notes",
      c.notes === undefined || typeof c.notes === "string",
      c.notes,
    ),
  };
}

