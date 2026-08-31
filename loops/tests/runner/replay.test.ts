import { describe, expect, it } from "vitest";
import { replayAll, replayCase } from "../../src/runner/replay.js";
import { TIMEOUT_SENTINEL, type EvalCase } from "../../src/db/eval-schema.js";

/**
 * Build an eval case. Defaults describe the happy path, so each test states only
 * the field it is actually about.
 */
function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    sourceCallId: null,
    createdAt: "2026-08-27T09:00:00.000Z",
    input: "Where is order A1001?",
    expectedOutcome: "completed",
    expectedHandoffReason: null,
    expectedFallback: false,
    expectedToolCalled: true,
    mockToolResult: { status: "in_transit", estimatedDelivery: "2026-07-29" },
    status: "added",
    notes: null,
    sourceCallIds: null,
    ...overrides,
  };
}

describe("replayCase — the four seed scenarios", () => {
  it("passes the happy path: tool called, result narrated, no fallback", () => {
    const result = replayCase(evalCase());

    expect(result.passed).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(result.actual).toEqual({
      outcome: "completed",
      fallbackUsed: false,
      toolCalled: true,
    });
  });

  it("passes the timeout path: the sentinel fires the fallback", () => {
    const result = replayCase(
      evalCase({
        id: "case-timeout",
        input: "Where is order SLOW999?",
        mockToolResult: TIMEOUT_SENTINEL,
        expectedOutcome: "fallback",
        expectedFallback: true,
        expectedToolCalled: true,
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.actual.fallbackUsed).toBe(true);
    expect(result.actual.outcome).toBe("fallback");
    // The tool was invoked — it just never answered. That distinction is the
    // difference between "the backend is down" and "the agent didn't try".
    expect(result.actual.toolCalled).toBe(true);
  });

  it("passes the out-of-scope path: handoff classified, tool never reached", () => {
    const result = replayCase(
      evalCase({
        id: "case-handoff",
        input: "I want to dispute a charge",
        expectedOutcome: "handoff",
        expectedHandoffReason: "billing",
        expectedFallback: false,
        expectedToolCalled: false,
        mockToolResult: null,
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.actual).toEqual({
      outcome: "handoff",
      handoffReason: "billing",
      fallbackUsed: false,
      toolCalled: false,
    });
  });

  it("passes not_found as a completed lookup, not a fallback", () => {
    const result = replayCase(
      evalCase({
        id: "case-not-found",
        input: "Where is order XYZ123?",
        mockToolResult: { status: "not_found" },
        expectedOutcome: "completed",
        expectedFallback: false,
        expectedToolCalled: true,
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.actual.outcome).toBe("completed");
    expect(result.actual.fallbackUsed).toBe(false);
    expect(result.actual.toolCalled).toBe(true);
  });
});

describe("replayCase — failures", () => {
  it("fails a case whose expected_outcome is wrong, and says why", () => {
    const result = replayCase(
      evalCase({ expectedOutcome: "fallback", expectedFallback: true }),
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe('expected outcome "fallback", got "completed"');
    expect(result.expected.outcome).toBe("fallback");
    expect(result.actual.outcome).toBe("completed");
  });

  it("fails when the outcome is right but the handoff reason is wrong", () => {
    const result = replayCase(
      evalCase({
        input: "I want to dispute a charge",
        expectedOutcome: "handoff",
        expectedHandoffReason: "returns",
        expectedToolCalled: false,
        mockToolResult: null,
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe('expected handoff reason "returns", got "billing"');
  });

  it("fails when the tool was expected to run but a handoff got there first", () => {
    // The regression this catches: someone adds "order" to the handoff keywords
    // and every order-status call silently starts transferring to a human.
    const result = replayCase(
      evalCase({
        input: "I want to cancel order A1001",
        expectedOutcome: "handoff",
        expectedHandoffReason: "cancellation",
        expectedToolCalled: true,
        mockToolResult: null,
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe("expected toolCalled true, got false");
  });

  it("fails a case expecting `error` — that outcome needs a live transport", () => {
    // Documented limitation, asserted so it cannot regress into a false pass:
    // `errored` is only ever set by a Deepgram Error frame.
    const result = replayCase(evalCase({ expectedOutcome: "error" }));

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe('expected outcome "error", got "completed"');
  });
});

describe("replayCase — the live path's ordering", () => {
  it("classifies the handoff before the tool policy is even consulted", () => {
    // Same case as the happy path, but the utterance is out of scope. If the
    // gates ran in the other order, the tool would be called first.
    const result = replayCase(
      evalCase({ input: "I need a refund for order A1001", expectedOutcome: "handoff" }),
    );

    expect(result.actual.outcome).toBe("handoff");
    expect(result.actual.handoffReason).toBe("returns");
    expect(result.actual.toolCalled).toBe(false);
  });

  it("treats an application-level error result as a completed lookup", () => {
    // The live handler branches on `kind === "result"`, not on the status inside
    // it — an { status: "error" } payload is still an answer from a tool that ran.
    const result = replayCase(
      evalCase({ mockToolResult: { status: "error", reason: "upstream 500" } }),
    );

    expect(result.actual.outcome).toBe("completed");
    expect(result.actual.fallbackUsed).toBe(false);
    expect(result.actual.toolCalled).toBe(true);
  });

  it("gives each case a fresh tool policy, so budgets never leak between cases", () => {
    // Three cases that each spend the single allowed tool call. If they shared a
    // policy, the second and third would be blocked and fall back.
    const results = replayAll([
      evalCase({ id: "a" }),
      evalCase({ id: "b" }),
      evalCase({ id: "c" }),
    ]);

    expect(results.map((r) => r.actual.toolCalled)).toEqual([true, true, true]);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});

describe("replayAll", () => {
  it("returns one result per case, in order", () => {
    const results = replayAll([
      evalCase({ id: "first" }),
      evalCase({ id: "second", input: "I want to dispute a charge" }),
    ]);

    expect(results.map((r) => r.caseId)).toEqual(["first", "second"]);
    expect(results[0]?.passed).toBe(true);
    expect(results[1]?.passed).toBe(false); // expects completed, hands off
  });

  it("is deterministic — the same cases produce the same results every run", () => {
    const cases = [evalCase(), evalCase({ id: "b", mockToolResult: TIMEOUT_SENTINEL })];
    expect(replayAll(cases)).toEqual(replayAll(cases));
  });
});
