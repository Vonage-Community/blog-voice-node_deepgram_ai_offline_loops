// -----------------------------------------------------------------------------
// Agent version — a string stamped onto every call record.
//
// The point is not deployment management; it's evaluation. When Part 2 (or you)
// change the prompt, the tool policy, or a model, bump this. Then the offline
// loop can tell "calls handled by order-status-v1" apart from "…v2" and compare
// outcomes across versions. One string, saved next to each call. Nothing more.
// -----------------------------------------------------------------------------

/** Override via the AGENT_VERSION env var; defaults to the current baseline. */
export const AGENT_VERSION = process.env.AGENT_VERSION ?? "order-status-v1";
