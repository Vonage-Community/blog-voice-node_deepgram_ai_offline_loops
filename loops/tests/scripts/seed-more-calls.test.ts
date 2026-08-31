import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../../../src/storage/db.js";
import { readCallRecord } from "../../../src/storage/call-records.js";
import { classifyHandoffReason } from "../../../src/agent/tool-policy.js";
import { readSeedCalls, seedCalls } from "../../scripts/seed-more-calls.js";
import { reviewTranscripts } from "../../src/review/transcript-review.js";
import { ensureEvalSchema, listEvalCases } from "../../src/db/eval-schema.js";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function count(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM call_records").get() as { n: number }).n;
}

describe("seedCalls", () => {
  it("inserts all ten records on the first run", () => {
    const result = seedCalls(db, readSeedCalls());

    expect(result.inserted).toHaveLength(10);
    expect(result.skipped).toEqual([]);
    expect(count()).toBe(10);
  });

  it("inserts nothing on the second run", () => {
    const records = readSeedCalls();
    seedCalls(db, records);
    const second = seedCalls(db, records);

    expect(second.inserted).toEqual([]);
    expect(second.skipped).toHaveLength(10);
    expect(count()).toBe(10);
  });

  it("never overwrites a record that is already there", () => {
    const records = readSeedCalls();
    seedCalls(db, records);

    // Stand in for a real call that happens to share an id.
    db.prepare("UPDATE call_records SET outcome = 'completed' WHERE call_id = ?").run(
      "seed-call-001",
    );
    seedCalls(db, records);

    expect(readCallRecord(db, "seed-call-001")?.outcome).toBe("completed");
  });

  it("rejects a seed file that is not an array of records", () => {
    expect(() => readSeedCalls(new URL("./bad-seed.json", import.meta.url).pathname)).toThrow();
  });
});

describe("the committed seed file", () => {
  const records = readSeedCalls();

  it("uses the ids and dates the README promises", () => {
    expect(records.map((r) => r.callId)).toEqual([
      "seed-call-001",
      "seed-call-002",
      "seed-call-003",
      "seed-call-004",
      "seed-call-005",
      "seed-call-006",
      "seed-call-007",
      "seed-call-008",
      "seed-call-009",
      "seed-call-010",
    ]);
    expect(records.map((r) => r.startedAt.slice(0, 10))).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(records.every((r) => r.agentVersion === "order-status-v1")).toBe(true);
  });

  it("has the promised mix of outcomes", () => {
    const byReason = (reason: string) =>
      records.filter((r) => r.outcome === "handoff" && r.handoffReason === reason);

    expect(byReason("returns")).toHaveLength(3);
    expect(byReason("billing")).toHaveLength(2);
    expect(records.filter((r) => r.outcome === "fallback")).toHaveLength(5);
  });

  it("stores a timed-out lookup as the bare string Part 1 actually writes", () => {
    // The whole point of seeding from the real shape. `{"kind":"timeout"}` is
    // the in-memory OrderLookupOutcome and is never persisted; matching on it
    // would make the review loop's timeout detector find nothing, silently.
    const timeouts = records.filter((r) =>
      r.toolCalls.some((tc) => tc.result === "timeout"),
    );

    expect(timeouts).toHaveLength(3);
    for (const record of timeouts) {
      expect(record.fallbackUsed).toBe(true);
      expect(record.outcome).toBe("fallback");
      const timedOut = record.toolCalls.find((tc) => tc.result === "timeout");
      expect(timedOut?.success).toBe(false);
      expect(timedOut?.durationMs).toBeGreaterThan(1500);
    }
  });

  it("stores a policy-blocked lookup the way the live path does", () => {
    // Not `"result":"blocked"` — Part 1 records the refusal as an error result
    // with the policy's own reason string, and `success: false`.
    const blocked = records.filter(
      (r) => r.fallbackUsed && !r.toolCalls.some((tc) => tc.result === "timeout"),
    );

    expect(blocked).toHaveLength(2);
    for (const record of blocked) {
      const refused = record.toolCalls.at(-1);
      expect(refused?.success).toBe(false);
      expect(refused?.result).toEqual({
        status: "error",
        reason: "The single allowed tool call has already been made (limit 1).",
      });
      // A blocked second lookup implies a successful first one.
      expect(record.toolCalls[0]?.success).toBe(true);
      expect(record.toolCalls).toHaveLength(2);
    }
  });

  it("gives every record a caller turn and an agent turn", () => {
    for (const record of records) {
      expect(record.transcript.some((t) => t.speaker === "caller")).toBe(true);
      expect(record.transcript.some((t) => t.speaker === "agent")).toBe(true);
    }
  });

  it("populates latency with real-looking numbers, not zeros", () => {
    for (const record of records) {
      expect(record.latency.totalTurnMs).toBeGreaterThan(0);
      expect(record.latency.speechToTextMs).toBeGreaterThan(0);
      expect(record.latency.modelMs).toBeGreaterThan(0);
    }
  });

  it("only ever hands off with a handoffRequested flag set", () => {
    for (const record of records) {
      expect(record.handoffRequested).toBe(record.outcome === "handoff");
      expect(record.handoffReason !== null).toBe(record.outcome === "handoff");
    }
  });

  it("gives every handoff an utterance the live classifier maps to its reason", () => {
    // The failure this guards against is subtle: a record whose handoff_reason
    // no caller turn could have produced is a call the live path could never
    // write, and the review loop — which recovers the utterance by re-running
    // classifyHandoffReason — would skip it and propose nothing.
    for (const record of records.filter((r) => r.outcome === "handoff")) {
      const recovered = record.transcript
        .filter((t) => t.speaker === "caller")
        .map((t) => classifyHandoffReason(t.text))
        .find((reason) => reason === record.handoffReason);

      expect(recovered, `${record.callId}: no caller turn classifies as ${record.handoffReason}`)
        .toBe(record.handoffReason);
    }
  });

  it("keeps non-handoff calls free of anything the classifier would flag", () => {
    // A timeout call whose caller said something out of scope would be recorded
    // as a handoff by the live path, not a fallback.
    for (const record of records.filter((r) => r.outcome !== "handoff")) {
      for (const turn of record.transcript.filter((t) => t.speaker === "caller")) {
        expect(classifyHandoffReason(turn.text), `${record.callId}: "${turn.text}"`).toBeNull();
      }
    }
  });
});

describe("the seed data drives the review loop end to end", () => {
  it("produces the patterns the README's Run 2 promises", () => {
    ensureEvalSchema(db);
    seedCalls(db, readSeedCalls());

    const summary = reviewTranscripts(db);
    const proposals = listEvalCases(db, "pending");

    // returns (3 calls), billing (2 calls), timeouts (3 calls), blocked (2 calls).
    expect(summary.callsReviewed).toBe(10);
    const reasons = proposals.map((p) => p.expectedHandoffReason);
    expect(reasons).toHaveLength(4);
    expect(reasons).toContain("billing");
    expect(reasons).toContain("returns");

    // The other two are the timeout pattern and the blocked-fallback pattern,
    // neither of which is a handoff.
    expect(proposals.filter((p) => p.mockToolResult === "__timeout__")).toHaveLength(1);
    expect(
      proposals.filter((p) => p.expectedOutcome === "completed" && p.expectedToolCalled),
    ).toHaveLength(1);
  });
});
