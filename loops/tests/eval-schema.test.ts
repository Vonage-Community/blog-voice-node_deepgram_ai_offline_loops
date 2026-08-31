import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import {
  ensureEvalSchema,
  getEvalCase,
  insertEvalCase,
  listEvalCases,
  openEvalDatabase,
  TIMEOUT_SENTINEL,
  type NewEvalCase,
} from "../src/db/eval-schema.js";

let db: DatabaseType;

beforeEach(() => {
  db = openEvalDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const sampleCase: NewEvalCase = {
  id: "case-1",
  createdAt: "2026-08-01T09:00:00.000Z",
  input: "Where is order A1001?",
  expectedOutcome: "completed",
  expectedFallback: false,
  expectedToolCalled: true,
  mockToolResult: { status: "in_transit", estimatedDelivery: "2026-07-29" },
  notes: "Happy path",
};

/** Raw column read, for the cases where we care about storage and not the mapped object. */
function row(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("ensureEvalSchema", () => {
  it("creates the eval_cases table", () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'eval_cases'")
      .get();
    expect(table).toEqual({ name: "eval_cases" });
  });

  it("is safe to run twice against the same database", () => {
    insertEvalCase(db, sampleCase);
    expect(() => ensureEvalSchema(db)).not.toThrow();
    expect(getEvalCase(db, "case-1")).not.toBeNull(); // and it did not drop the data
  });

  it("does not create call_records — that table is Part 1's", () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_records'")
      .get();
    expect(table).toBeUndefined();
  });
});

describe("insertEvalCase", () => {
  it("round-trips a case through every column", () => {
    insertEvalCase(db, {
      ...sampleCase,
      sourceCallId: "call-abc123",
      expectedHandoffReason: null,
      status: "pending",
    });

    expect(getEvalCase(db, "case-1")).toEqual({
      id: "case-1",
      sourceCallId: "call-abc123",
      createdAt: "2026-08-01T09:00:00.000Z",
      input: "Where is order A1001?",
      expectedOutcome: "completed",
      expectedHandoffReason: null,
      expectedFallback: false,
      expectedToolCalled: true,
      mockToolResult: { status: "in_transit", estimatedDelivery: "2026-07-29" },
      status: "pending",
      notes: "Happy path",
      sourceCallIds: null,
    });
  });

  it("defaults an omitted status to added and source_call_id to null", () => {
    insertEvalCase(db, sampleCase);
    const stored = getEvalCase(db, "case-1");
    expect(stored?.status).toBe("added");
    expect(stored?.sourceCallId).toBeNull();
    expect(stored?.expectedHandoffReason).toBeNull();
  });

  it("stores booleans as 0/1 integers", () => {
    insertEvalCase(db, { ...sampleCase, expectedFallback: true, expectedToolCalled: false });
    expect(row("case-1").expected_fallback).toBe(1);
    expect(row("case-1").expected_tool_called).toBe(0);
  });

  it("stores the timeout sentinel as a bare string, not JSON", () => {
    insertEvalCase(db, { ...sampleCase, mockToolResult: TIMEOUT_SENTINEL });
    // A JSON-encoded sentinel would come back as '"__timeout__"' with quotes.
    expect(row("case-1").mock_tool_result).toBe("__timeout__");
    expect(getEvalCase(db, "case-1")?.mockToolResult).toBe(TIMEOUT_SENTINEL);
  });

  it("stores a null mock result for cases where the tool never runs", () => {
    insertEvalCase(db, {
      ...sampleCase,
      expectedOutcome: "handoff",
      expectedToolCalled: false,
      expectedHandoffReason: "billing",
      mockToolResult: null,
    });
    expect(row("case-1").mock_tool_result).toBeNull();
    expect(getEvalCase(db, "case-1")?.mockToolResult).toBeNull();
  });

  it("returns false and leaves the existing row untouched on a duplicate id", () => {
    expect(insertEvalCase(db, sampleCase)).toBe(true);

    // Same id, different everything — this is the shape of the bug we are
    // guarding against: a re-run silently reverting a human's approval.
    const written = insertEvalCase(db, {
      ...sampleCase,
      input: "something else entirely",
      status: "dismissed",
    });

    expect(written).toBe(false);
    expect(getEvalCase(db, "case-1")?.input).toBe("Where is order A1001?");
    expect(getEvalCase(db, "case-1")?.status).toBe("added");
  });

  it("rejects an invalid expected_outcome", () => {
    expect(() =>
      insertEvalCase(db, { ...sampleCase, expectedOutcome: "complted" as never }),
    ).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() => insertEvalCase(db, { ...sampleCase, status: "maybe" as never })).toThrow();
  });

  it("rejects a non-boolean integer in expected_fallback", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO eval_cases (id, created_at, input, expected_outcome, expected_fallback)
           VALUES ('bad', '2026-08-01T09:00:00.000Z', 'hi', 'completed', 2)`,
        )
        .run(),
    ).toThrow();
  });
});

describe("getEvalCase", () => {
  it("returns null for an id that does not exist", () => {
    expect(getEvalCase(db, "nope")).toBeNull();
  });
});

describe("listEvalCases", () => {
  beforeEach(() => {
    insertEvalCase(db, { ...sampleCase, id: "a", createdAt: "2026-08-01T09:00:00.000Z" });
    insertEvalCase(db, {
      ...sampleCase,
      id: "b",
      createdAt: "2026-08-02T09:00:00.000Z",
      status: "pending",
    });
    insertEvalCase(db, {
      ...sampleCase,
      id: "c",
      createdAt: "2026-08-03T09:00:00.000Z",
      status: "dismissed",
    });
  });

  it("returns every case, oldest first, when no status is given", () => {
    expect(listEvalCases(db).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by status — the runner's entire input is the added set", () => {
    expect(listEvalCases(db, "added").map((c) => c.id)).toEqual(["a"]);
    expect(listEvalCases(db, "pending").map((c) => c.id)).toEqual(["b"]);
    expect(listEvalCases(db, "dismissed").map((c) => c.id)).toEqual(["c"]);
  });

  it("returns an empty array rather than throwing when nothing matches", () => {
    db.prepare("DELETE FROM eval_cases").run();
    expect(listEvalCases(db, "added")).toEqual([]);
  });
});

// The status rename: approved → added, awaiting_review → pending,
// rejected → dismissed.
//
// These build the *old* table by hand — the one and only place in the suite
// where that is the right thing to do. Every other fixture goes through
// `insertEvalCase` so it cannot drift from the live schema, but a migration is
// defined entirely by the shape it upgrades *from*, and that shape no longer
// exists in the code. Constructing it here is the only way to prove the upgrade
// path works for the databases people already have.
describe("ensureEvalSchema — migrating the old status names", () => {
  const OLD_SCHEMA = `
    CREATE TABLE eval_cases (
      id                      TEXT PRIMARY KEY,
      source_call_id          TEXT,
      created_at              TEXT NOT NULL,
      input                   TEXT NOT NULL,
      expected_outcome        TEXT NOT NULL
        CHECK (expected_outcome IN ('completed', 'fallback', 'handoff', 'error')),
      expected_handoff_reason TEXT,
      expected_fallback       INTEGER NOT NULL DEFAULT 0
        CHECK (expected_fallback IN (0, 1)),
      expected_tool_called    INTEGER NOT NULL DEFAULT 1
        CHECK (expected_tool_called IN (0, 1)),
      mock_tool_result        TEXT,
      status                  TEXT NOT NULL DEFAULT 'approved'
        CHECK (status IN ('approved', 'awaiting_review', 'rejected')),
      notes                   TEXT,
      source_call_ids         TEXT
    );
  `;

  /** A pre-rename database with one row per old status. */
  function legacyDatabase(): DatabaseType {
    const legacy = new Database(":memory:");
    legacy.exec(OLD_SCHEMA);
    const insert = legacy.prepare(
      `INSERT INTO eval_cases
        (id, created_at, input, expected_outcome, expected_fallback,
         expected_tool_called, status, notes, source_call_ids)
       VALUES (?, ?, ?, 'handoff', 0, 0, ?, ?, ?)`,
    );
    insert.run("old-1", "2026-08-01T00:00:00.000Z", "a", "approved", "kept", null);
    insert.run("old-2", "2026-08-02T00:00:00.000Z", "b", "awaiting_review", null, '["c1"]');
    insert.run("old-3", "2026-08-03T00:00:00.000Z", "c", "rejected", null, null);
    return legacy;
  }

  it("renames all three statuses in place", () => {
    const legacy = legacyDatabase();

    ensureEvalSchema(legacy);

    expect(listEvalCases(legacy).map((c) => [c.id, c.status])).toEqual([
      ["old-1", "added"],
      ["old-2", "pending"],
      ["old-3", "dismissed"],
    ]);
    legacy.close();
  });

  it("replaces the CHECK constraint, so the new names are actually writable", () => {
    // The reason a plain UPDATE could not have done this job: the old CHECK
    // rejects every new name, and SQLite cannot drop a constraint.
    const legacy = legacyDatabase();
    expect(() =>
      legacy.prepare("UPDATE eval_cases SET status = 'added' WHERE id = 'old-1'").run(),
    ).toThrow(/CHECK constraint failed/);

    ensureEvalSchema(legacy);

    expect(() =>
      legacy.prepare("UPDATE eval_cases SET status = 'pending' WHERE id = 'old-1'").run(),
    ).not.toThrow();
    expect(() =>
      legacy.prepare("UPDATE eval_cases SET status = 'approved' WHERE id = 'old-1'").run(),
    ).toThrow(/CHECK constraint failed/);
    legacy.close();
  });

  it("carries every column across, not just the status", () => {
    const legacy = legacyDatabase();

    ensureEvalSchema(legacy);

    expect(getEvalCase(legacy, "old-1")?.notes).toBe("kept");
    expect(getEvalCase(legacy, "old-2")?.sourceCallIds).toEqual(["c1"]);
    expect(getEvalCase(legacy, "old-2")?.createdAt).toBe("2026-08-02T00:00:00.000Z");
    legacy.close();
  });

  it("rebuilds the status index the dropped table took with it", () => {
    const legacy = legacyDatabase();
    legacy.exec("CREATE INDEX idx_eval_cases_status ON eval_cases (status)");

    ensureEvalSchema(legacy);

    const indexes = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'eval_cases'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_eval_cases_status");
    legacy.close();
  });

  it("leaves no scratch table behind", () => {
    const legacy = legacyDatabase();

    ensureEvalSchema(legacy);

    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'eval_cases_migrated'").all(),
    ).toEqual([]);
    legacy.close();
  });

  it("is a no-op the second time, and on a database that never had old names", () => {
    // It runs on every open, so "already migrated" has to cost nothing and
    // change nothing — including a human's edits made after the first upgrade.
    const legacy = legacyDatabase();
    ensureEvalSchema(legacy);
    legacy.prepare("UPDATE eval_cases SET status = 'dismissed' WHERE id = 'old-1'").run();

    ensureEvalSchema(legacy);

    expect(getEvalCase(legacy, "old-1")?.status).toBe("dismissed");
    legacy.close();

    // And a database created fresh from the current DDL is untouched.
    const fresh = openEvalDatabase(":memory:");
    insertEvalCase(fresh, { ...sampleCase, status: "pending" });
    ensureEvalSchema(fresh);
    expect(getEvalCase(fresh, "case-1")?.status).toBe("pending");
    fresh.close();
  });
});
