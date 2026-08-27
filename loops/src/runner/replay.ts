// -----------------------------------------------------------------------------
// Replay one eval case against the live agent's logic.
//
// You cannot re-dial a phone call. What you *can* do is take the one thing a
// call actually turns on — the caller's utterance — and push it through the
// same decision code the live path uses, with the tool's answer injected
// instead of fetched. That is what this file does, and it is the whole of the
// regression runner's cleverness.
//
// The logic being mirrored lives in `src/voice/websocket-handler.ts`:
// `handleFunctionCall()` (the gates) and `deriveOutcome()` (the precedence).
// The parts that are *not* mirrored are the parts that need a socket: audio,
// barge-in, Deepgram framing, the real `lookupOrderStatus`. See the comments on
// `deriveActualOutcome` and `injectMockOutcome` for what that costs us.
//
// Everything here is pure. No database, no filesystem, no clock, no network —
// give it an eval case, get a result. The CLI does the I/O.
// -----------------------------------------------------------------------------

import {
  classifyHandoffReason,
  createToolPolicy,
  type HandoffReason,
} from "../../../src/agent/tool-policy.js";
import type { OrderLookupOutcome, OrderResult } from "../../../src/tools/order-status.js";
import { TIMEOUT_SENTINEL, type EvalCase, type MockToolResult } from "../db/eval-schema.js";

/** The tool the agent is allowed to call. Part 1's allowlist has exactly one entry. */
const TOOL_NAME = "getOrderStatus";

/**
 * Duration reported for an injected timeout. The live deadline is 1500ms, so any
 * value above it stands for "the deadline fired and we stopped waiting". Nothing
 * branches on this number — it exists so the replayed outcome has the same shape
 * as a real one.
 */
const SIMULATED_TIMEOUT_MS = 1600;

/** Duration reported for an injected successful lookup — a plausible round trip. */
const SIMULATED_LOOKUP_MS = 120;

/** The four observable facts about a call, from the eval suite's point of view. */
export interface ReplayObservation {
  outcome: string;
  handoffReason?: string;
  fallbackUsed: boolean;
  toolCalled: boolean;
}

/** One case replayed: what was expected, what happened, and whether they agree. */
export interface EvalResult {
  caseId: string;
  input: string;
  passed: boolean;
  expected: ReplayObservation;
  actual: ReplayObservation;
  failureReason?: string;
}

/**
 * Replay one eval case and judge it.
 *
 * The order of operations is the live path's order, and that ordering is itself
 * under test: a handoff is detected from the caller's words *before* any tool
 * call is considered, which is why an out-of-scope request can never reach the
 * backend.
 */
export function replayCase(evalCase: EvalCase): EvalResult {
  const actual = replayToObservation(evalCase);
  const expected = expectedObservation(evalCase);
  const failureReason = compare(expected, actual);

  const result: EvalResult = {
    caseId: evalCase.id,
    input: evalCase.input,
    passed: failureReason === null,
    expected,
    actual,
  };
  if (failureReason !== null) result.failureReason = failureReason;
  return result;
}

/** Replay every case in order. Deterministic: same input, same report, every run. */
export function replayAll(cases: EvalCase[]): EvalResult[] {
  return cases.map(replayCase);
}

// --- The replay itself -----------------------------------------------------

/**
 * Run the case through the agent's decision logic and report what happened.
 *
 * This is the offline twin of a call session: the same accumulators the live
 * handler keeps (`fallbackUsed`, `handoffRequested`, `handoffReason`) and the
 * same order of gates, minus everything that needs a socket.
 */
function replayToObservation(evalCase: EvalCase): ReplayObservation {
  let fallbackUsed = false;
  let handoffRequested = false;
  let handoffReason: HandoffReason | null = null;
  let toolCalled = false;

  // Gate 1 — out of scope. In the live handler this runs twice: once on the
  // caller's transcript (`handleConversationText`) and again as a backstop when
  // a FunctionCallRequest arrives. Both call the same classifier on the same
  // utterance, so replaying it once is equivalent — and it is the reason an
  // out-of-scope request never reaches the tool.
  const reason = classifyHandoffReason(evalCase.input);
  if (reason) {
    handoffRequested = true;
    handoffReason = reason;
    return observation("handoff", handoffReason, fallbackUsed, toolCalled);
  }

  // No tool result to inject means this case does not exercise a tool call at
  // all. Note what drives that decision: `mock_tool_result`, which is *data*.
  // Keying it off `expected_tool_called` would let the expectation drive the
  // replay and then compare itself — a test that cannot fail.
  if (evalCase.mockToolResult === null) {
    return observation("completed", handoffReason, fallbackUsed, toolCalled);
  }

  // Gate 2 — the tool policy. A fresh policy per case, exactly as the live path
  // creates one per phone call, so budgets never leak between cases. With
  // MAX_TOOL_CALLS at 1 and one simulated request per case this always allows;
  // it is here so that tightening the policy shows up as eval failures rather
  // than as silence.
  const policy = createToolPolicy();
  const auth = policy.authorizeCall(TOOL_NAME);
  if (!auth.allowed) {
    // Live behaviour: blocked call → deterministic fallback, tool never runs.
    fallbackUsed = true;
    return observation("fallback", handoffReason, fallbackUsed, toolCalled);
  }
  policy.recordCall();
  toolCalled = true;

  // Gate 3 — the injected result stands in for `await lookupOrderStatus(...)`.
  const outcome = injectMockOutcome(evalCase.mockToolResult);

  // Gate 4 — react exactly as the live handler does.
  if (outcome.kind === "result") {
    // in_transit, delivered, AND not_found are all legitimate results: the tool
    // ran and answered, the model narrates it, nothing falls back. Getting this
    // wrong is the specific regression this suite exists to catch — a
    // not_found recorded as a fallback would show up in the transcript review
    // loop as a broken backend that was never broken.
    return observation("completed", handoffReason, fallbackUsed, toolCalled);
  }

  // A timeout is the tool failing to answer at all — deterministic fallback,
  // and never a retry.
  fallbackUsed = true;
  return observation("fallback", handoffReason, fallbackUsed, toolCalled);
}

/**
 * Turn a stored `mock_tool_result` into the `OrderLookupOutcome` the live
 * handler would have received.
 *
 * Two of the three shapes `lookupOrderStatus` can return are reachable from
 * here. The third, `transport_error`, is not: the column holds a result, the
 * timeout sentinel, or NULL, and there is no value that means "the connection
 * dropped". So the live path's one-retry-on-transport-failure branch is *not*
 * covered by the eval suite — it is covered by Part 1's unit tests instead.
 * Worth knowing before you trust a green run.
 */
function injectMockOutcome(mock: Exclude<MockToolResult, null>): OrderLookupOutcome {
  if (mock === TIMEOUT_SENTINEL) {
    return { kind: "timeout", durationMs: SIMULATED_TIMEOUT_MS };
  }
  return {
    kind: "result",
    result: mock as unknown as OrderResult,
    durationMs: SIMULATED_LOOKUP_MS,
  };
}

/**
 * Assemble an observation.
 *
 * `deriveOutcome()` in the live handler picks the first of handoff → fallback →
 * error → completed. Replay reaches its outcome by returning at the matching
 * gate, which produces the same precedence by construction.
 *
 * The `error` outcome is the one that cannot be produced here at all. It is set
 * by `errored`, which is only ever true when Deepgram sends an `Error` frame —
 * a transport event with no offline equivalent. An eval case expecting `error`
 * will always fail, and it should: that is not a behaviour a logic replay can
 * make a claim about.
 */
function observation(
  outcome: string,
  handoffReason: HandoffReason | null,
  fallbackUsed: boolean,
  toolCalled: boolean,
): ReplayObservation {
  const result: ReplayObservation = { outcome, fallbackUsed, toolCalled };
  if (handoffReason !== null) result.handoffReason = handoffReason;
  return result;
}

// --- Judging ---------------------------------------------------------------

/** The case's expectations, in the same shape as the observation, for a clean diff. */
function expectedObservation(evalCase: EvalCase): ReplayObservation {
  const expected: ReplayObservation = {
    outcome: evalCase.expectedOutcome,
    fallbackUsed: evalCase.expectedFallback,
    toolCalled: evalCase.expectedToolCalled,
  };
  if (evalCase.expectedHandoffReason !== null) {
    expected.handoffReason = evalCase.expectedHandoffReason;
  }
  return expected;
}

/**
 * Compare all four fields and return a human-readable reason for the first
 * mismatch, or null if everything agrees.
 *
 * All four are checked, not just the outcome. A case that hands off for the
 * wrong reason, or reaches the right outcome without calling the tool, is a
 * regression even though `outcome` matches — and it is exactly the kind of
 * drift that a report showing only outcomes would hide.
 */
function compare(expected: ReplayObservation, actual: ReplayObservation): string | null {
  if (expected.outcome !== actual.outcome) {
    return `expected outcome "${expected.outcome}", got "${actual.outcome}"`;
  }
  if ((expected.handoffReason ?? null) !== (actual.handoffReason ?? null)) {
    return `expected handoff reason ${quote(expected.handoffReason)}, got ${quote(
      actual.handoffReason,
    )}`;
  }
  if (expected.fallbackUsed !== actual.fallbackUsed) {
    return `expected fallbackUsed ${expected.fallbackUsed}, got ${actual.fallbackUsed}`;
  }
  if (expected.toolCalled !== actual.toolCalled) {
    return `expected toolCalled ${expected.toolCalled}, got ${actual.toolCalled}`;
  }
  return null;
}

function quote(value: string | undefined): string {
  return value === undefined ? "none" : `"${value}"`;
}
