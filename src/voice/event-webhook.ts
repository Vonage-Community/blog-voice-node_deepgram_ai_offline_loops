// -----------------------------------------------------------------------------
// Event webhook — Vonage POSTs call lifecycle events here (started, ringing,
// answered, completed, …). We must always answer 200 quickly, or Vonage retries.
//
// For Part 1 this handler does two things: log the event so the reader can watch
// the call progress in the console, and fire an `onCallEnded(uuid)` hook when
// the call reaches a terminal state. That hook is where the WebSocket handler
// (a later task) will finalize and persist the call record. Right now it is a
// logging stub, wired through a factory so server.ts can inject the real one.
// -----------------------------------------------------------------------------

import type { Request, Response } from "express";

/** The subset of the Vonage event payload we care about. */
interface VonageCallEvent {
  uuid?: string;
  conversation_uuid?: string;
  status?: string;
  direction?: string;
  timestamp?: string;
}

/** Called once per call when it reaches a terminal state. */
export type CallEndedHook = (uuid: string) => void;

/**
 * Terminal call statuses — any of these means the call is over and its record
 * should be finalized. Non-terminal statuses (ringing, answered, …) are logged
 * but do not fire the hook.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "rejected",
  "unanswered",
  "busy",
  "cancelled",
  "timeout",
]);

/**
 * Default hook. Stub for Part 1: the WebSocket handler will replace this with
 * real call-record finalization once it exists.
 */
export const onCallEnded: CallEndedHook = (uuid: string): void => {
  // TODO(part-1 wiring): finalize + persist the call record for this uuid.
  console.log(`[event] call ended, finalizing record: ${uuid}`);
};

/**
 * Build the `POST /event` handler. Injecting the hook keeps the handler pure
 * enough to unit-test with a spy and lets server.ts wire the real finalizer.
 */
export function createEventWebhook(hook: CallEndedHook = onCallEnded) {
  return function eventWebhook(req: Request, res: Response): void {
    const event = (req.body ?? {}) as VonageCallEvent;
    const status = event.status ?? "unknown";
    const uuid = event.uuid ?? "unknown";

    console.log(`[event] status=${status} uuid=${uuid}`);

    if (event.uuid && TERMINAL_STATUSES.has(status)) {
      hook(event.uuid);
    }

    // Vonage only needs a 200; the body is ignored.
    res.status(200).end();
  };
}
