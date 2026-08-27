// The detectors as pure functions — no database, no writing. These cover the
// threshold boundaries and the utterance-recovery rule; the end-to-end behaviour
// (proposals, idempotency) lives in transcript-review.test.ts.

import { describe, expect, it } from "vitest";
import { findPatterns, THRESHOLDS } from "../../src/review/pattern-finder.js";
import { blockedFallbackCall, callRecord, handoffCall, timeoutCall } from "./fixtures.js";

describe("findPatterns — evidence thresholds", () => {
  it("needs two calls for a handoff reason", () => {
    const one = [handoffCall("c1", "billing", "I want to dispute a charge")];
    const two = [...one, handoffCall("c2", "billing", "Wrong charge")];

    expect(findPatterns(one)).toHaveLength(0);
    expect(findPatterns(two)).toHaveLength(1);
    expect(THRESHOLDS.handoffReason).toBe(2);
  });

  it("needs three calls for a timeout pattern", () => {
    const two = [timeoutCall("c1"), timeoutCall("c2")];
    const three = [...two, timeoutCall("c3")];

    expect(findPatterns(two)).toHaveLength(0);
    expect(findPatterns(three)).toHaveLength(1);
    expect(THRESHOLDS.timeout).toBe(3);
  });

  it("needs two calls for a blocked fallback", () => {
    const one = [blockedFallbackCall("c1")];
    const two = [...one, blockedFallbackCall("c2")];

    expect(findPatterns(one)).toHaveLength(0);
    expect(findPatterns(two)).toHaveLength(1);
    expect(THRESHOLDS.blockedFallback).toBe(2);
  });

  it("finds nothing in a window of clean calls", () => {
    expect(findPatterns([callRecord({ callId: "a" }), callRecord({ callId: "b" })])).toEqual(
      [],
    );
  });

  it("finds nothing in an empty window", () => {
    expect(findPatterns([])).toEqual([]);
  });
});

describe("findPatterns — recovering the utterance that caused a handoff", () => {
  it("picks the caller turn the classifier maps to the recorded reason", () => {
    const record = handoffCall("c1", "billing", "I want to dispute a charge");
    // Add earlier chatter that classifies as nothing, plus a later caller turn.
    record.transcript = [
      { speaker: "caller", text: "Hello?", timestampMs: 100 },
      { speaker: "agent", text: "How can I help?", timestampMs: 500 },
      { speaker: "caller", text: "I want to dispute a charge", timestampMs: 2000 },
      { speaker: "caller", text: "Thanks", timestampMs: 9000 },
    ];

    const [pattern] = findPatterns([record, handoffCall("c2", "billing", "Wrong charge")]);

    // Not "Hello?" (first caller turn) and not "Thanks" (last one).
    expect(pattern?.input).toBe("I want to dispute a charge");
  });

  it("skips a group whose utterance cannot be recovered rather than guessing", () => {
    // A record claiming a billing handoff with nothing in the transcript that
    // would produce one. Real calls cannot look like this — the live path sets
    // the reason *from* the utterance — but a hand-edited row can, and inventing
    // an input would put a fabricated eval case in front of a reviewer.
    const broken = handoffCall("c1", "billing", "Hello there");
    const alsoBroken = handoffCall("c2", "billing", "Good morning");

    expect(findPatterns([broken, alsoBroken])).toEqual([]);
  });
});

describe("findPatterns — what each detector asserts", () => {
  it("proposes a handoff with no tool call and no mock result", () => {
    const [pattern] = findPatterns([
      handoffCall("c1", "returns", "I need a refund"),
      handoffCall("c2", "returns", "I want to return this"),
    ]);

    expect(pattern?.type).toBe("handoff-reason");
    expect(pattern?.expected).toEqual({
      outcome: "handoff",
      handoffReason: "returns",
      fallback: false,
      toolCalled: false,
      mockToolResult: null,
    });
  });

  it("proposes the timeout sentinel, not a fabricated slow result", () => {
    const [pattern] = findPatterns([timeoutCall("c1"), timeoutCall("c2"), timeoutCall("c3")]);

    expect(pattern?.expected.mockToolResult).toBe("__timeout__");
    expect(pattern?.expected.outcome).toBe("fallback");
    expect(pattern?.input).toBe("Where is order SLOW999?");
  });

  it("synthesises a clean input from the order id, not the transcribed speech", () => {
    // What the caller actually said was "order slow nine nine nine" — not
    // something you want as the canonical input of a regression case.
    const spoken = timeoutCall("c1");
    spoken.transcript = [
      { speaker: "caller", text: "Where is order slow nine nine nine?", timestampMs: 2000 },
    ];

    const [pattern] = findPatterns([spoken, timeoutCall("c2"), timeoutCall("c3")]);

    expect(pattern?.input).toBe("Where is order SLOW999?");
  });

  it("counts a timed-out call as a timeout, never as a blocked fallback", () => {
    const patterns = findPatterns([
      timeoutCall("c1"),
      timeoutCall("c2"),
      timeoutCall("c3"),
      timeoutCall("c4"),
    ]);

    expect(patterns.map((p) => p.type)).toEqual(["timeout"]);
  });

  it("counts a policy-blocked fallback separately from a timeout", () => {
    const patterns = findPatterns([
      timeoutCall("t1"),
      timeoutCall("t2"),
      timeoutCall("t3"),
      blockedFallbackCall("b1"),
      blockedFallbackCall("b2"),
    ]);

    expect(patterns.map((p) => p.type).sort()).toEqual(["blocked-fallback", "timeout"]);
  });

  it("lists evidence oldest first, matching the order it was given", () => {
    const [pattern] = findPatterns([
      handoffCall("first", "billing", "I want to dispute a charge"),
      handoffCall("second", "billing", "Wrong charge"),
      handoffCall("third", "billing", "Another wrong charge"),
    ]);

    expect(pattern?.callIds).toEqual(["first", "second", "third"]);
  });
});
