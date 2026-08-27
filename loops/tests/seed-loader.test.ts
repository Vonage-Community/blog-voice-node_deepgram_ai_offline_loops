import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { fileURLToPath } from "node:url";
import {
  getEvalCase,
  listEvalCases,
  openEvalDatabase,
  TIMEOUT_SENTINEL,
} from "../src/db/eval-schema.js";
import {
  loadSeedCases,
  readSeedCasesFile,
  SEED_CASES_PATH,
  type SeedCase,
} from "../src/db/seed-loader.js";

let db: DatabaseType;

beforeEach(() => {
  db = openEvalDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const NOW = "2026-08-01T09:00:00.000Z";

const fixtures: SeedCase[] = [
  {
    id: "fixture-1",
    input: "Where is order A1001?",
    expectedOutcome: "completed",
    expectedFallback: false,
    expectedToolCalled: true,
    mockToolResult: { status: "in_transit", estimatedDelivery: "2026-07-29" },
    notes: "Happy path",
  },
  {
    id: "fixture-2",
    input: "I want to dispute a charge",
    expectedOutcome: "handoff",
    expectedFallback: false,
    expectedToolCalled: false,
    expectedHandoffReason: "billing",
    notes: "Handoff before the tool runs",
  },
];

describe("readSeedCasesFile", () => {
  it("parses the committed seed file", () => {
    const cases = readSeedCasesFile();
    expect(cases.map((c) => c.id)).toEqual(["seed-001", "seed-002", "seed-003", "seed-004"]);
  });

  it("resolves the seed file relative to the module, not the working directory", () => {
    expect(SEED_CASES_PATH.endsWith("eval-cases/seed-cases.json")).toBe(true);
    expect(() => readSeedCasesFile()).not.toThrow();
  });

  // The committed cases mirror Part 1's "Try Four Calls" section. If someone
  // edits the JSON, these assertions say which behaviour they just changed.
  it("covers the timeout path with the sentinel, not a fabricated result", () => {
    const timeoutCase = readSeedCasesFile().find((c) => c.id === "seed-002");
    expect(timeoutCase?.mockToolResult).toBe(TIMEOUT_SENTINEL);
    expect(timeoutCase?.expectedOutcome).toBe("fallback");
    expect(timeoutCase?.expectedFallback).toBe(true);
  });

  it("treats not_found as a completed lookup, not a fallback", () => {
    const notFound = readSeedCasesFile().find((c) => c.id === "seed-003");
    expect(notFound?.expectedOutcome).toBe("completed");
    expect(notFound?.expectedFallback).toBe(false);
  });

  it("expects the out-of-scope case to hand off without calling the tool", () => {
    const handoff = readSeedCasesFile().find((c) => c.id === "seed-004");
    expect(handoff?.expectedOutcome).toBe("handoff");
    expect(handoff?.expectedHandoffReason).toBe("billing");
    expect(handoff?.expectedToolCalled).toBe(false);
  });

  it("rejects a malformed case, naming the offender", () => {
    expect(() => readSeedCasesFile(fixturePath("not-an-array.json"))).toThrow(
      /expected a JSON array/,
    );
    expect(() => readSeedCasesFile(fixturePath("bad-outcome.json"))).toThrow(
      /broken-1.*expectedOutcome/s,
    );
    expect(() => readSeedCasesFile(fixturePath("missing-input.json"))).toThrow(/"input"/);
  });
});

describe("loadSeedCases", () => {
  it("loads the committed seed cases as approved", () => {
    const result = loadSeedCases(db, { now: NOW });

    expect(result.inserted).toEqual(["seed-001", "seed-002", "seed-003", "seed-004"]);
    expect(result.skipped).toEqual([]);
    expect(listEvalCases(db, "approved")).toHaveLength(4);
  });

  it("stamps created_at and leaves source_call_id null — nobody called in for these", () => {
    loadSeedCases(db, { cases: fixtures, now: NOW });
    const stored = getEvalCase(db, "fixture-1");

    expect(stored?.createdAt).toBe(NOW);
    expect(stored?.sourceCallId).toBeNull();
    expect(stored?.status).toBe("approved");
  });

  it("preserves the mock tool result and handoff reason of each case", () => {
    loadSeedCases(db, { cases: fixtures, now: NOW });

    expect(getEvalCase(db, "fixture-1")?.mockToolResult).toEqual({
      status: "in_transit",
      estimatedDelivery: "2026-07-29",
    });
    expect(getEvalCase(db, "fixture-2")?.mockToolResult).toBeNull();
    expect(getEvalCase(db, "fixture-2")?.expectedHandoffReason).toBe("billing");
  });

  it("inserts nothing on a second run", () => {
    loadSeedCases(db, { cases: fixtures, now: NOW });
    const second = loadSeedCases(db, { cases: fixtures, now: "2026-09-01T09:00:00.000Z" });

    expect(second.inserted).toEqual([]);
    expect(second.skipped).toEqual(["fixture-1", "fixture-2"]);
    expect(listEvalCases(db)).toHaveLength(2);
  });

  it("does not overwrite a human's edit on a re-run", () => {
    loadSeedCases(db, { cases: fixtures, now: NOW });

    // A human decides fixture-1 is not worth regressing against.
    db.prepare("UPDATE eval_cases SET status = 'rejected' WHERE id = 'fixture-1'").run();
    loadSeedCases(db, { cases: fixtures, now: NOW });

    expect(getEvalCase(db, "fixture-1")?.status).toBe("rejected");
    expect(getEvalCase(db, "fixture-1")?.createdAt).toBe(NOW);
  });

  it("seeds all or nothing — a malformed case leaves no half-seeded suite", () => {
    const withBadCase = [
      fixtures[0]!,
      { ...fixtures[1]!, id: "fixture-bad", expectedOutcome: "complted" as never },
    ];

    expect(() => loadSeedCases(db, { cases: withBadCase, now: NOW })).toThrow();
    expect(listEvalCases(db)).toEqual([]);
  });
});

/** Malformed fixtures live next to this test file, not in eval-cases/. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
