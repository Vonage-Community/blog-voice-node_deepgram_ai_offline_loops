// -----------------------------------------------------------------------------
// The four pattern detectors.
//
// Everything here is deterministic and reads only structured columns plus the
// stored transcript text. There is no model call, no embedding, no similarity
// score — on purpose. A classifier inside the review loop would be one more
// component whose accuracy you cannot measure, sitting inside the tool whose
// entire job is measuring accuracy. When it drifts, it silently proposes the
// wrong eval cases and the suite you trust starts testing a fiction.
//
// The cost of that choice is real and belongs in the blog post: exact-match
// grouping treats "I need to speak to someone" and "Can I speak to someone?" as
// two different patterns. That is a false negative a human reviewer will spot in
// two seconds, and a human reviewer is already in the loop. A wrong grouping
// nobody reviews is the failure mode worth avoiding.
//
// Input is `CallRecord[]` — already deserialized by Part 1's own reader — and
// output is a list of `Pattern` objects. Writing them to the database is
// somebody else's job (transcript-review.ts).
// -----------------------------------------------------------------------------

import { classifyHandoffReason, TOOL_TIMEOUT_MS } from "../../../src/agent/tool-policy.js";
import type { CallRecord, ToolCallRecord } from "../../../src/storage/db.js";
import {
  TIMEOUT_SENTINEL,
  type ExpectedOutcome,
  type MockToolResult,
} from "../db/eval-schema.js";

export type PatternType =
  | "handoff-reason"
  | "timeout"
  | "unanswered"
  | "blocked-fallback";

/** What the agent should have done — the assertion the proposed eval case makes. */
export interface PatternExpectation {
  outcome: ExpectedOutcome;
  handoffReason: string | null;
  fallback: boolean;
  toolCalled: boolean;
  mockToolResult: MockToolResult;
}

export interface Pattern {
  type: PatternType;
  /** Short headline for the console, e.g. "billing handoff". */
  label: string;
  /** Sentence stored in the proposal's `notes` — why this was proposed. */
  description: string;
  /** The caller utterance the proposed eval case replays. */
  input: string;
  /** Every call that contributed, oldest first. */
  callIds: string[];
  expected: PatternExpectation;
}

/** How many calls a pattern needs before it is worth a human's attention. */
export const THRESHOLDS = {
  handoffReason: 2,
  timeout: 3,
  blockedFallback: 2,
} as const;

/**
 * Run all four detectors over one window of calls.
 *
 * Order matters only for presentation, but note one real interaction: a repeated
 * `unsupported` handoff is picked up by detector 1 *and* detector 3. That is not
 * a bug and it is not deduplicated here — detector 3 splits by distinct
 * utterance and so may find questions detector 1's single representative misses.
 * The write step drops the overlap, because a duplicate is defined by what the
 * proposal asserts, not by which detector produced it.
 */
export function findPatterns(records: CallRecord[]): Pattern[] {
  return [
    ...findRepeatedHandoffReasons(records),
    ...findTimeoutPattern(records),
    ...findUnansweredQuestions(records),
    ...findBlockedFallbacks(records),
  ];
}

// --- 1. Repeated handoff reasons -------------------------------------------

/**
 * Any handoff reason recorded twice or more in the window. Once is an incident;
 * twice is a category the eval suite should pin down.
 */
function findRepeatedHandoffReasons(records: CallRecord[]): Pattern[] {
  const byReason = new Map<string, CallRecord[]>();
  for (const record of records) {
    if (!record.handoffReason) continue;
    const group = byReason.get(record.handoffReason) ?? [];
    group.push(record);
    byReason.set(record.handoffReason, group);
  }

  const patterns: Pattern[] = [];
  for (const [reason, group] of byReason) {
    if (group.length < THRESHOLDS.handoffReason) continue;

    // A proposal without a replayable utterance is not an eval case. If we
    // cannot recover what the caller actually said, we have counted something
    // real but cannot assert anything about it — so say nothing.
    const input = firstTriggeringUtterance(group, reason);
    if (!input) continue;

    patterns.push({
      type: "handoff-reason",
      label: `${reason} handoff`,
      description: describeHandoff(reason, group.length),
      input,
      callIds: group.map((r) => r.callId),
      expected: {
        outcome: "handoff",
        handoffReason: reason,
        fallback: false,
        toolCalled: false,
        mockToolResult: null,
      },
    });
  }
  return patterns;
}

// --- 2. Timeouts ------------------------------------------------------------

/**
 * Three or more calls where the tool ran out of time. One proposal for the
 * window, not one per call — the pattern is "the backend got slow", and the eval
 * case that guards it is the same case every time.
 */
function findTimeoutPattern(records: CallRecord[]): Pattern[] {
  const timedOut = records.filter((r) => r.fallbackUsed && hasTimeout(r.toolCalls));
  if (timedOut.length < THRESHOLDS.timeout) return [];

  const orderId = firstOrderId(timedOut, (tc) => isTimeout(tc));

  return [
    {
      type: "timeout",
      label: "timeout pattern",
      description:
        `${timedOut.length} calls waited too long for the order lookup and got the ` +
        `fallback. Is ${TOOL_TIMEOUT_MS}ms the right timeout, or is the upstream slow?`,
      input: orderQuestion(orderId),
      callIds: timedOut.map((r) => r.callId),
      expected: {
        outcome: "fallback",
        handoffReason: null,
        fallback: true,
        toolCalled: true,
        mockToolResult: TIMEOUT_SENTINEL,
      },
    },
  ];
}

// --- 3. Unanswered questions ------------------------------------------------

/**
 * Callers whose request was classified `unsupported` — the catch-all bucket. One
 * candidate per distinct utterance, matched exactly.
 *
 * Exact match is the whole grouping strategy, and it is a deliberate floor
 * rather than a first draft. Anything smarter — stemming, edit distance,
 * embeddings — is a similarity threshold somebody has to tune, and a wrong
 * threshold quietly merges two real problems into one proposal or splits one
 * into six. Exact match can only ever fail by proposing too much, and too much
 * lands in a review queue a human is already reading.
 *
 * No minimum count here: `unsupported` means the agent had nothing to offer, and
 * one caller asking something the agent cannot do is already worth seeing.
 */
function findUnansweredQuestions(records: CallRecord[]): Pattern[] {
  const byUtterance = new Map<string, CallRecord[]>();

  for (const record of records) {
    if (record.outcome !== "handoff" || record.handoffReason !== "unsupported") continue;
    const utterance = triggeringUtterance(record, "unsupported");
    if (!utterance) continue;
    const group = byUtterance.get(utterance) ?? [];
    group.push(record);
    byUtterance.set(utterance, group);
  }

  return [...byUtterance].map(([utterance, group]) => ({
    type: "unanswered" as const,
    label: `unanswered question (${truncate(utterance)})`,
    description:
      `${callers(group.length)} asked for something outside this agent's scope ` +
      `and got transferred: ${quoteUtterance(utterance)} Keep transferring, or ` +
      "build support for it?",
    input: utterance,
    callIds: group.map((r) => r.callId),
    expected: {
      outcome: "handoff" as ExpectedOutcome,
      handoffReason: "unsupported",
      fallback: false,
      toolCalled: false,
      mockToolResult: null,
    },
  }));
}

// --- 4. Fallbacks that were not timeouts ------------------------------------

/**
 * Calls that fell back without the tool ever being slow — in practice, the tool
 * policy blocking a second lookup in one call.
 *
 * The expectation is `completed`, which looks wrong until you remember how
 * replay works: every eval case gets a fresh tool policy, exactly as every phone
 * call does, so a single utterance can never reproduce "the budget was already
 * spent". The honest assertion is what that utterance should do on its own — a
 * normal lookup — and the pattern that prompted it goes in the notes for the
 * human. A case asserting `fallback` here would pass only if replay were broken.
 */
function findBlockedFallbacks(records: CallRecord[]): Pattern[] {
  const blocked = records.filter((r) => r.fallbackUsed && !hasTimeout(r.toolCalls));
  if (blocked.length < THRESHOLDS.blockedFallback) return [];

  const orderId = firstOrderId(blocked, (tc) => !tc.success && !isTimeout(tc));

  return [
    {
      type: "blocked-fallback",
      label: "fallback without timeout",
      description:
        `${callers(blocked.length)} asked about a second order in the same call and ` +
        "hit the one-lookup limit. Should this agent support multiple lookups per call?",
      input: orderQuestion(orderId),
      callIds: blocked.map((r) => r.callId),
      expected: {
        outcome: "completed",
        handoffReason: null,
        fallback: false,
        toolCalled: true,
        // A neutral result: the case is about the outcome shape, not about
        // inventing a delivery date for an order nobody looked up.
        mockToolResult: { status: "not_found" },
      },
    },
  ];
}

// --- Note templates ---------------------------------------------------------
//
// These strings end up in `notes`, which is the only thing a reviewer reads
// before deciding. They are written as two sentences: what the callers did, and
// the question the reviewer actually has to answer. Not "proposed so the eval
// suite pins down that this class of request transfers to a human" — that
// describes the machinery, and the person reading it already knows what the
// review loop is for. What they do not know is whether this behaviour is one
// they want to keep.

/** "1 caller" / "4 callers" — notes read as sentences, so the count agrees. */
function callers(count: number): string {
  return `${count} caller${count === 1 ? "" : "s"}`;
}

/**
 * Quote a caller utterance mid-sentence, ending the sentence exactly once.
 *
 * Transcribed speech usually arrives already punctuated ("Transfer to a
 * human."), so appending our own full stop after the closing quote produces
 * `"Transfer to a human.".` — small, but it is the first thing a reviewer reads.
 */
function quoteUtterance(utterance: string): string {
  const terminated = /[.!?]$/.test(utterance);
  return `"${utterance}${terminated ? "" : "."}"`;
}

/**
 * How the handoff reasons read in a sentence. `unsupported` is missing on
 * purpose: it is the catch-all bucket, so "asked about unsupported" is nonsense
 * and it gets its own phrasing below.
 */
const REASON_PHRASES: Record<string, string> = {
  billing: "billing",
  returns: "returns",
  cancellation: "cancellations",
  account: "their account",
};

/** The note for a repeated handoff reason — the reviewer's question, not ours. */
function describeHandoff(reason: string, count: number): string {
  if (reason === "unsupported") {
    return (
      `${callers(count)} asked for something outside this agent's scope and got ` +
      "transferred. Keep transferring, or build support for it?"
    );
  }

  const phrase = REASON_PHRASES[reason] ?? reason;
  return (
    `${callers(count)} asked about ${phrase} and got transferred. Is transferring ` +
    `the right behavior, or should this agent handle ${phrase}?`
  );
}

// --- Shared helpers ---------------------------------------------------------

/** Part 1 stores a timed-out lookup as the bare string "timeout" (see db.ts). */
function isTimeout(toolCall: ToolCallRecord): boolean {
  return toolCall.result === "timeout";
}

function hasTimeout(toolCalls: ToolCallRecord[]): boolean {
  return toolCalls.some(isTimeout);
}

/**
 * Recover the caller utterance that produced a given handoff reason by running
 * Part 1's classifier over the caller's turns and taking the first match.
 *
 * This is how the live path decided, so it is how we recover the decision —
 * importing the same function rather than guessing "probably the last thing they
 * said". If the keyword list changes, this moves with it.
 */
function triggeringUtterance(record: CallRecord, reason: string): string | null {
  for (const entry of record.transcript) {
    if (entry.speaker !== "caller") continue;
    if (classifyHandoffReason(entry.text) === reason) return entry.text;
  }
  return null;
}

/** The earliest recoverable utterance across a group of calls. */
function firstTriggeringUtterance(records: CallRecord[], reason: string): string | null {
  for (const record of records) {
    const utterance = triggeringUtterance(record, reason);
    if (utterance) return utterance;
  }
  return null;
}

/** The order id from the first tool call in the group that matches the predicate. */
function firstOrderId(
  records: CallRecord[],
  predicate: (toolCall: ToolCallRecord) => boolean,
): string | null {
  for (const record of records) {
    const match = record.toolCalls.find(predicate);
    if (match?.args.orderId) return match.args.orderId;
  }
  return null;
}

/**
 * Build a replayable utterance from an order id.
 *
 * Deliberately synthesised rather than lifted from the transcript: what the
 * caller actually said was transcribed speech — "order slow nine nine nine" —
 * which is not a string you want as the canonical input of a regression case.
 */
function orderQuestion(orderId: string | null): string {
  return orderId ? `Where is order ${orderId}?` : "Where is my order?";
}

function truncate(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
