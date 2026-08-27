import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { getEvalCase, insertEvalCase, listEvalCases } from "../../src/db/eval-schema.js";
import {
  formatReviewSummary,
  reviewTranscripts,
  type ReviewSummary,
} from "../../src/review/transcript-review.js";
import {
  blockedFallbackCall,
  callRecord,
  handoffCall,
  seedCalls,
  testDatabase,
  timeoutCall,
} from "./fixtures.js";

let db: DatabaseType;

beforeEach(() => {
  db = testDatabase();
});

afterEach(() => {
  db.close();
});

/** A fixed clock so proposal ids and timestamps are deterministic. */
const CLOCK = { now: () => new Date("2026-08-27T14:00:00.000Z") };

function review(options: { windowSize?: number } = {}): ReviewSummary {
  return reviewTranscripts(db, { ...CLOCK, ...options });
}

function proposals() {
  return listEvalCases(db, "awaiting_review");
}

describe("reviewTranscripts — nothing to review", () => {
  it("handles an empty call_records table without erroring", () => {
    const summary = review();

    expect(summary.callsReviewed).toBe(0);
    expect(summary.outcomes).toEqual([]);
    expect(summary.proposalsWritten).toBe(0);
    expect(proposals()).toEqual([]);
  });

  it("proposes nothing when every call completed normally", () => {
    seedCalls(db, [callRecord({ callId: "c1" }), callRecord({ callId: "c2" })]);

    expect(review().proposalsWritten).toBe(0);
  });
});

describe("reviewTranscripts — 1. repeated handoff reasons", () => {
  it("proposes a handoff case once a reason appears twice", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "There's a wrong charge on my card"),
    ]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(1);
    const [proposal] = proposals();
    expect(proposal).toMatchObject({
      input: "I want to dispute a charge",
      expectedOutcome: "handoff",
      expectedHandoffReason: "billing",
      expectedFallback: false,
      expectedToolCalled: false,
      status: "awaiting_review",
    });
    expect(proposal?.mockToolResult).toBeNull();
  });

  it("stays quiet on a single handoff — once is an incident, not a pattern", () => {
    seedCalls(db, [handoffCall("c1", "billing", "I want to dispute a charge")]);

    expect(review().proposalsWritten).toBe(0);
  });

  it("records every contributing call in source_call_ids", () => {
    seedCalls(db, [
      handoffCall("call-aaa", "returns", "I need a refund"),
      handoffCall("call-bbb", "returns", "I want to return this"),
      handoffCall("call-ccc", "returns", "Can I exchange it?"),
    ]);

    review();

    const [proposal] = proposals();
    expect(proposal?.sourceCallIds).toEqual(["call-aaa", "call-bbb", "call-ccc"]);
    // The singular column keeps its singular meaning: one representative call.
    expect(proposal?.sourceCallId).toBe("call-aaa");
  });

  it("proposes one case per distinct reason", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge on my card"),
      handoffCall("c3", "cancellation", "I want to cancel my order"),
      handoffCall("c4", "cancellation", "Please cancel this"),
    ]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(2);
    expect(proposals().map((p) => p.expectedHandoffReason).sort()).toEqual([
      "billing",
      "cancellation",
    ]);
  });
});

describe("reviewTranscripts — 2. timeout pattern", () => {
  it("proposes a timeout case at three timed-out calls", () => {
    seedCalls(db, [timeoutCall("c1"), timeoutCall("c2"), timeoutCall("c3")]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(1);
    expect(proposals()[0]).toMatchObject({
      input: "Where is order SLOW999?",
      expectedOutcome: "fallback",
      expectedFallback: true,
      expectedToolCalled: true,
      mockToolResult: "__timeout__",
      expectedHandoffReason: null,
    });
  });

  it("stays below the threshold at two", () => {
    seedCalls(db, [timeoutCall("c1"), timeoutCall("c2")]);

    expect(review().proposalsWritten).toBe(0);
  });

  it("emits one proposal for the window, not one per call", () => {
    seedCalls(db, [
      timeoutCall("c1"),
      timeoutCall("c2"),
      timeoutCall("c3"),
      timeoutCall("c4"),
      timeoutCall("c5"),
    ]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(1);
    expect(proposals()[0]?.sourceCallIds).toHaveLength(5);
  });
});

describe("reviewTranscripts — 3. unanswered questions", () => {
  it("proposes one case per distinct utterance, matched exactly", () => {
    seedCalls(db, [
      handoffCall("c1", "unsupported", "Can I speak to a representative?"),
      handoffCall("c2", "unsupported", "Can I speak to a representative?"),
      // One character apart — exact match keeps these separate on purpose.
      handoffCall("c3", "unsupported", "Can I speak to a representative"),
    ]);

    const summary = review();

    // Two distinct utterances. Detector 1 also fires on the repeated
    // `unsupported` reason, but its proposal asserts the same thing as one of
    // these, so it is written once and the overlap is skipped.
    expect(summary.proposalsWritten).toBe(2);
    expect(proposals().map((p) => p.input).sort()).toEqual([
      "Can I speak to a representative",
      "Can I speak to a representative?",
    ]);
    expect(proposals().every((p) => p.expectedHandoffReason === "unsupported")).toBe(true);
  });

  it("groups repeats of the same utterance into one proposal with both calls", () => {
    seedCalls(db, [
      handoffCall("call-1", "unsupported", "I want to talk to a human."),
      handoffCall("call-2", "unsupported", "I want to talk to a human."),
    ]);

    review();

    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]?.sourceCallIds).toEqual(["call-1", "call-2"]);
  });
});

describe("reviewTranscripts — 4. fallbacks that were not timeouts", () => {
  it("proposes a blocked-fallback case at two such calls", () => {
    seedCalls(db, [blockedFallbackCall("c1"), blockedFallbackCall("c2")]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(1);
    expect(proposals()[0]).toMatchObject({
      input: "Where is order B2002?",
      // Not `fallback`: replay gives every case a fresh tool policy, so a single
      // utterance can never reproduce "the one-call budget was already spent".
      expectedOutcome: "completed",
      expectedFallback: false,
      expectedToolCalled: true,
    });
    expect(proposals()[0]?.notes).toContain("refused by the tool policy");
  });

  it("does not count timed-out calls as blocked fallbacks", () => {
    seedCalls(db, [timeoutCall("c1"), timeoutCall("c2")]);

    // Two fallbacks, but both are timeouts — below the timeout threshold of 3
    // and not blocked fallbacks at all.
    expect(review().proposalsWritten).toBe(0);
  });
});

describe("reviewTranscripts — idempotency", () => {
  it("writes one proposal, not two, when run twice on the same data", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
    ]);

    const first = review();
    const second = review();

    expect(first.proposalsWritten).toBe(1);
    expect(second.proposalsWritten).toBe(0);
    expect(proposals()).toHaveLength(1);
  });

  it("reports the skip rather than hiding the pattern on the second run", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
    ]);

    review();
    const second = review();

    // The pattern is still found — it just is not written again.
    expect(second.outcomes).toHaveLength(1);
    expect(second.outcomes[0]?.proposalId).toBeNull();
    expect(second.outcomes[0]?.skippedReason).toMatch(/already proposed as proposal-/);
  });

  it("re-proposes a pattern a human rejected, with fresh evidence", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
    ]);

    review();
    const [original] = proposals();
    db.prepare("UPDATE eval_cases SET status = 'rejected' WHERE id = ?").run(original!.id);

    const second = review();

    expect(second.proposalsWritten).toBe(1);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]?.id).not.toBe(original!.id);
    // The rejection stands; the new proposal sits beside it.
    expect(getEvalCase(db, original!.id)?.status).toBe("rejected");
  });

  it("does not re-propose something a human already approved", () => {
    // The rule as specified only names awaiting_review. Approved is the same
    // argument one step later: the case is already in the suite, so proposing it
    // again is noise in a queue meant for new information.
    insertEvalCase(db, {
      id: "seed-004",
      createdAt: "2026-08-01T00:00:00.000Z",
      input: "I want to dispute a charge",
      expectedOutcome: "handoff",
      expectedHandoffReason: "billing",
      expectedFallback: false,
      expectedToolCalled: false,
      status: "approved",
    });
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
    ]);

    const summary = review();

    expect(summary.proposalsWritten).toBe(0);
    expect(summary.outcomes[0]?.skippedReason).toBe(
      "already covered by approved case seed-004",
    );
  });

  it("gives colliding proposals distinct ids within a single run", () => {
    // Two patterns of the same type in the same millisecond. Without
    // disambiguation the ids collide and ON CONFLICT DO NOTHING drops the second
    // without a word.
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
      handoffCall("c3", "cancellation", "I want to cancel my order"),
      handoffCall("c4", "cancellation", "Please cancel this"),
    ]);

    review();

    const ids = proposals().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });
});

describe("reviewTranscripts — the window", () => {
  it("ignores calls outside the last N", () => {
    // Three billing handoffs, but the window only reaches the newest two — and
    // the oldest one is the only `returns` call, so that pattern is invisible.
    seedCalls(db, [
      handoffCall("old", "returns", "I need a refund", "2026-08-01T10:00:00.000Z"),
      handoffCall("mid", "billing", "I want to dispute a charge", "2026-08-20T10:00:00.000Z"),
      handoffCall("new", "billing", "Wrong charge", "2026-08-25T10:00:00.000Z"),
    ]);

    const summary = review({ windowSize: 2 });

    expect(summary.callsReviewed).toBe(2);
    expect(summary.proposalsWritten).toBe(1);
    expect(proposals()[0]?.sourceCallIds).toEqual(["mid", "new"]);
  });

  it("reads the newest calls, not the first ones written", () => {
    seedCalls(db, [
      handoffCall("old-1", "billing", "I want to dispute a charge", "2026-08-01T10:00:00.000Z"),
      handoffCall("old-2", "billing", "Wrong charge", "2026-08-02T10:00:00.000Z"),
      callRecord({ callId: "new-1", startedAt: "2026-08-26T10:00:00.000Z" }),
      callRecord({ callId: "new-2", startedAt: "2026-08-27T10:00:00.000Z" }),
    ]);

    const summary = review({ windowSize: 2 });

    expect(summary.callsReviewed).toBe(2);
    expect(summary.proposalsWritten).toBe(0); // the two newest are plain completions
  });
});

describe("formatReviewSummary", () => {
  it("renders patterns, proposal ids, and the approval commands", () => {
    seedCalls(db, [
      handoffCall("c1", "billing", "I want to dispute a charge"),
      handoffCall("c2", "billing", "Wrong charge"),
    ]);

    const text = formatReviewSummary(review(), { dbPath: "../data/calls.db" });

    expect(text).toContain("Transcript Review — 2026-08-27T14:00");
    expect(text).toContain("Reviewed 2 calls (last 50 window)");
    expect(text).toContain("Patterns found: 1");
    expect(text).toContain("→ billing handoff (2 calls)");
    expect(text).toContain('Input: "I want to dispute a charge"');
    expect(text).toContain("Expected: handoff (billing)");
    expect(text).toContain("1 proposal written — review with:");
    expect(text).toContain("WHERE status = 'awaiting_review';");
    expect(text).toContain("UPDATE eval_cases SET status = 'approved'");
  });

  it("says plainly when a run wrote nothing", () => {
    const text = formatReviewSummary(review());

    expect(text).toContain("Reviewed 0 calls");
    expect(text).toContain("Patterns found: 0");
    expect(text).toContain("No new proposals written.");
    expect(text).not.toContain("review with:");
  });
});
