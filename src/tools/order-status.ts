// -----------------------------------------------------------------------------
// getOrderStatus — the single approved backend tool for the live path.
//
// This is a mock. There is no real order database in Part 1 (see AGENTS.md
// "Out of scope"). It exists to exercise every branch the tool policy cares
// about: a clean result, a "not found", a slow lookup that blows the timeout,
// and a temporary transport failure that is the *only* thing we ever retry.
//
// The public entry point the agent should call is `lookupOrderStatus`, which
// wraps the mock in a hard 1500ms deadline and returns a discriminated
// `OrderLookupOutcome`. The raw `getOrderStatus` mock is exported for tests.
// -----------------------------------------------------------------------------

import { TOOL_TIMEOUT_MS } from "../agent/tool-policy.js";

/**
 * The shape the tool returns for a *completed* lookup. `not_found` and `error`
 * are legitimate results, not exceptions — the caller decides how to react.
 */
export type OrderResult =
  | { status: "in_transit"; estimatedDelivery: string }
  | { status: "delivered"; deliveredAt: string }
  | { status: "not_found" }
  | { status: "error"; reason: string };

/**
 * Raised by the mock to simulate a temporary transport-layer failure (dropped
 * connection, 503, timeout at the socket, etc.). This is the ONLY failure the
 * tool policy is allowed to retry — an application-level `{ status: "error" }`
 * result is not retried.
 */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * The outcome of a policy-wrapped lookup. This is what the live path reasons
 * about: either the tool returned a result, or the deadline fired, or the
 * transport failed. Only `transport_error` is retryable.
 */
export type OrderLookupOutcome =
  | { kind: "result"; result: OrderResult; durationMs: number }
  | { kind: "timeout"; durationMs: number }
  | { kind: "transport_error"; error: TransportError; durationMs: number };

// --- Mock data -------------------------------------------------------------

const KNOWN_ORDERS: Record<string, OrderResult> = {
  A1001: { status: "in_transit", estimatedDelivery: "2026-07-29" },
  A1002: { status: "delivered", deliveredAt: "2026-07-24T16:42:00Z" },
  A1003: { status: "in_transit", estimatedDelivery: "2026-07-30" },
  A1004: { status: "delivered", deliveredAt: "2026-07-25T09:15:00Z" },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The mock backend. Deterministic so the tutorial and tests can rely on it:
 *
 *  - IDs beginning "SLOW" take 2000ms — longer than the 1500ms deadline, so
 *    `lookupOrderStatus` reports a `timeout`.
 *  - IDs beginning "FAIL" throw a `TransportError` — the retryable failure.
 *  - Known IDs (see KNOWN_ORDERS) return in_transit / delivered.
 *  - Anything else is `not_found` (an invalid/unknown order id — never retried).
 *
 * Note: the artificial delay runs to completion even when the caller has
 * already given up at 1500ms. That is intentional and realistic — a slow
 * upstream does not stop working just because we stopped waiting. The timeout
 * lives in the caller (`lookupOrderStatus`), not here.
 */
export async function getOrderStatus(orderId: string): Promise<OrderResult> {
  const id = orderId.trim().toUpperCase();

  if (id.startsWith("SLOW")) {
    await sleep(2000);
    return { status: "in_transit", estimatedDelivery: "2026-07-31" };
  }

  if (id.startsWith("FAIL")) {
    // Simulate a small amount of network latency before the connection drops.
    await sleep(50);
    throw new TransportError("upstream order service is temporarily unavailable");
  }

  // Simulate normal round-trip latency for a healthy lookup.
  await sleep(120);

  const known = KNOWN_ORDERS[id];
  if (known) return known;

  return { status: "not_found" };
}

/**
 * Call the tool under a hard deadline and classify the outcome.
 *
 * Key design decisions (explained in the tutorial):
 *  - A timeout is a *fallback* trigger, never a retry trigger. We do not know
 *    whether the upstream will eventually answer, and the caller is a live
 *    phone call — we cannot wait.
 *  - A `TransportError` is the only retryable outcome. The retry decision
 *    itself lives in the tool policy, not here; this function only reports
 *    *what happened*.
 *  - The timer is always cleared so a slow lookup cannot leak a pending timer.
 */
export async function lookupOrderStatus(
  orderId: string,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<OrderLookupOutcome> {
  const startedAt = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
  });

  try {
    const raced = await Promise.race([getOrderStatus(orderId), timeout]);

    if (raced === "__timeout__") {
      return { kind: "timeout", durationMs: Date.now() - startedAt };
    }

    return { kind: "result", result: raced, durationMs: Date.now() - startedAt };
  } catch (err) {
    if (err instanceof TransportError) {
      return { kind: "transport_error", error: err, durationMs: Date.now() - startedAt };
    }
    // Unexpected errors are surfaced as a transport error so the live path
    // degrades to the fallback instead of crashing the call.
    const wrapped = new TransportError(
      err instanceof Error ? err.message : "unknown tool failure",
    );
    return { kind: "transport_error", error: wrapped, durationMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
