// -----------------------------------------------------------------------------
// Tool policy — the enforced version of the Live-Path Contract (see AGENTS.md).
//
// The system prompt *asks* the model to behave. This module *enforces* it, so a
// misbehaving or jailbroken model still cannot exceed the boundary:
//
//   - Only `getOrderStatus` is callable.
//   - It may be called at most once per call (MAX_TOOL_CALLS).
//   - A failed attempt may be retried at most once (MAX_RETRIES), and ONLY when
//     the failure was a transport error. Timeouts and `not_found` are never
//     retried.
//   - The whole tool invocation is capped at TOOL_TIMEOUT_MS.
//
// The policy is a per-call session object (createToolPolicy) that tracks how
// many calls and retries have been spent. The websocket handler will create one
// per phone call and consult it before every tool invocation.
// -----------------------------------------------------------------------------

import type { OrderLookupOutcome } from "../tools/order-status.js";

/** Hard deadline for a single tool invocation, in milliseconds. */
export const TOOL_TIMEOUT_MS = 1500;

/** Number of distinct tool calls permitted per phone call. */
export const MAX_TOOL_CALLS = 1;

/** Number of retries permitted for the one allowed call (transport failures only). */
export const MAX_RETRIES = 1;

/** The tool allowlist. Anything not in here is rejected before execution. */
export const ALLOWED_TOOLS = ["getOrderStatus"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/**
 * Topics that are explicitly out of scope for this agent. This is a defensive
 * backstop for `isOutOfScope`; the primary out-of-scope handling is the system
 * prompt instructing the model to hand off. Keep these lowercase.
 */
export const OUT_OF_SCOPE_TOPICS = [
  "billing",
  "invoice",
  "charge",
  "payment",
  "refund",
  "return",
  "returns",
  "exchange",
  "dispute",
  "chargeback",
  "cancel",
  "cancellation",
  "complaint",
  "warranty",
  "account",
  "password",
] as const;

/** A yes/no decision plus a human-readable reason when the answer is no. */
export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolPolicy {
  /** May the model invoke this tool right now? Checks the allowlist and call budget. */
  authorizeCall(toolName: string): PolicyDecision;
  /** Record that a tool call was actually made (spends one of MAX_TOOL_CALLS). */
  recordCall(): void;
  /** After a failed attempt, may we retry? Only transport errors, and only within MAX_RETRIES. */
  authorizeRetry(outcome: OrderLookupOutcome): PolicyDecision;
  /** Record that a retry was actually made (spends one of MAX_RETRIES). */
  recordRetry(): void;
  /** How many tool calls have been spent. */
  readonly callsMade: number;
  /** How many retries have been spent. */
  readonly retriesUsed: number;
}

/**
 * Create a fresh policy session for a single phone call. State is local to the
 * returned object, so concurrent calls never share budgets.
 */
export function createToolPolicy(): ToolPolicy {
  let callsMade = 0;
  let retriesUsed = 0;

  return {
    authorizeCall(toolName: string): PolicyDecision {
      if (!(ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not on the allowlist. Only ${ALLOWED_TOOLS.join(
            ", ",
          )} may be called.`,
        };
      }
      if (callsMade >= MAX_TOOL_CALLS) {
        return {
          allowed: false,
          reason: `The single allowed tool call has already been made (limit ${MAX_TOOL_CALLS}).`,
        };
      }
      return { allowed: true };
    },

    recordCall(): void {
      callsMade += 1;
    },

    authorizeRetry(outcome: OrderLookupOutcome): PolicyDecision {
      if (outcome.kind !== "transport_error") {
        return {
          allowed: false,
          reason:
            outcome.kind === "timeout"
              ? "Timeouts are not retried — they trigger the fallback."
              : "Only transport failures are retryable; this outcome is not.",
        };
      }
      if (retriesUsed >= MAX_RETRIES) {
        return {
          allowed: false,
          reason: `Retry limit reached (limit ${MAX_RETRIES}).`,
        };
      }
      return { allowed: true };
    },

    recordRetry(): void {
      retriesUsed += 1;
    },

    get callsMade(): number {
      return callsMade;
    },

    get retriesUsed(): number {
      return retriesUsed;
    },
  };
}

/**
 * The category of an out-of-scope request. Recorded on the call so Part 2 can
 * group handoffs by reason (e.g. "how many billing handoffs this week").
 */
export type HandoffReason =
  | "billing"
  | "returns"
  | "cancellation"
  | "account"
  | "unsupported";

/**
 * Keyword groups mapped to reasons, checked in order. Deterministic on purpose —
 * no LLM classifier here (that would be another model call and another thing to
 * evaluate). The first group with a word-boundary match wins.
 */
const HANDOFF_KEYWORDS: ReadonlyArray<readonly [HandoffReason, readonly string[]]> = [
  ["cancellation", ["cancel", "cancellation"]],
  ["returns", ["return", "returns", "refund", "exchange"]],
  ["billing", ["billing", "invoice", "charge", "payment", "dispute", "chargeback"]],
  ["account", ["account", "password", "login", "log in", "access"]],
  // Checked last so a named topic above wins, but still caught: other
  // out-of-scope topics AND an explicit request for a human ("transfer me to
  // support", "let me talk to a person"). A caller asking for a human is the
  // clearest handoff signal there is — don't require them to name a topic first.
  [
    "unsupported",
    [
      "complaint",
      "warranty",
      "transfer",
      "human",
      "representative",
      "operator",
      "agent",
      "real person",
      "someone else",
    ],
  ],
];

/**
 * Classify the caller's utterance into a handoff reason, or `null` if it's in
 * scope (an order-status request). Word-boundary matching avoids false hits
 * inside other words. This replaces the old boolean-only check while keeping
 * `isOutOfScope` working as a thin wrapper.
 */
export function classifyHandoffReason(utterance: string): HandoffReason | null {
  const text = utterance.toLowerCase();
  for (const [reason, keywords] of HANDOFF_KEYWORDS) {
    if (keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(text))) {
      return reason;
    }
  }
  return null;
}

/**
 * Defensive keyword check for out-of-scope requests. True if the utterance
 * should be handed off rather than attempted. Now derived from
 * `classifyHandoffReason` so the two can never disagree.
 */
export function isOutOfScope(utterance: string): boolean {
  return classifyHandoffReason(utterance) !== null;
}
