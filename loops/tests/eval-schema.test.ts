import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
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
      status: "awaiting_review",
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
      status: "awaiting_review",
      notes: "Happy path",
      sourceCallIds: null,
    });
  });

  it("defaults an omitted status to approved and source_call_id to null", () => {
    insertEvalCase(db, sampleCase);
    const stored = getEvalCase(db, "case-1");
    expect(stored?.status).toBe("approved");
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
      status: "rejected",
    });

    expect(written).toBe(false);
    expect(getEvalCase(db, "case-1")?.input).toBe("Where is order A1001?");
    expect(getEvalCase(db, "case-1")?.status).toBe("approved");
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
      status: "awaiting_review",
    });
    insertEvalCase(db, {
      ...sampleCase,
      id: "c",
      createdAt: "2026-08-03T09:00:00.000Z",
      status: "rejected",
    });
  });

  it("returns every case, oldest first, when no status is given", () => {
    expect(listEvalCases(db).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by status — the runner's entire input is the approved set", () => {
    expect(listEvalCases(db, "approved").map((c) => c.id)).toEqual(["a"]);
    expect(listEvalCases(db, "awaiting_review").map((c) => c.id)).toEqual(["b"]);
    expect(listEvalCases(db, "rejected").map((c) => c.id)).toEqual(["c"]);
  });

  it("returns an empty array rather than throwing when nothing matches", () => {
    db.prepare("DELETE FROM eval_cases").run();
    expect(listEvalCases(db, "approved")).toEqual([]);
  });
});
