import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOrderStatus,
  lookupOrderStatus,
  TransportError,
} from "../src/tools/order-status.js";

describe("getOrderStatus (mock backend)", () => {
  it("returns in_transit with an estimated delivery for a known in-transit order", async () => {
    const result = await getOrderStatus("A1001");
    expect(result).toEqual({ status: "in_transit", estimatedDelivery: "2026-07-29" });
  });

  it("returns delivered with a delivery timestamp for a known delivered order", async () => {
    const result = await getOrderStatus("A1002");
    expect(result).toEqual({
      status: "delivered",
      deliveredAt: "2026-07-24T16:42:00Z",
    });
  });

  it("returns not_found for an unknown order id", async () => {
    const result = await getOrderStatus("NOPE-999");
    expect(result).toEqual({ status: "not_found" });
  });

  it("is case- and whitespace-insensitive on the order id", async () => {
    const result = await getOrderStatus("  a1001  ");
    expect(result).toEqual({ status: "in_transit", estimatedDelivery: "2026-07-29" });
  });

  it("throws a TransportError for FAIL* ids", async () => {
    await expect(getOrderStatus("FAIL-1")).rejects.toBeInstanceOf(TransportError);
  });
});

describe("lookupOrderStatus (policy-wrapped, with deadline)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a successful lookup as a result outcome", async () => {
    const outcome = await lookupOrderStatus("A1001");
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.result).toEqual({
        status: "in_transit",
        estimatedDelivery: "2026-07-29",
      });
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("wraps a not_found lookup as a result outcome (not an error)", async () => {
    const outcome = await lookupOrderStatus("UNKNOWN");
    expect(outcome).toMatchObject({ kind: "result", result: { status: "not_found" } });
  });

  it("reports a timeout when the lookup exceeds the 1500ms deadline", async () => {
    vi.useFakeTimers();
    // SLOW* ids take 2000ms; the deadline is 1500ms.
    const pending = lookupOrderStatus("SLOW-1");
    await vi.advanceTimersByTimeAsync(1500);
    const outcome = await pending;
    expect(outcome.kind).toBe("timeout");
  });

  it("does NOT time out when the lookup finishes before the deadline", async () => {
    vi.useFakeTimers();
    const pending = lookupOrderStatus("A1001");
    await vi.advanceTimersByTimeAsync(200); // normal lookup latency is ~120ms
    const outcome = await pending;
    expect(outcome.kind).toBe("result");
  });

  it("reports a transport_error outcome for FAIL* ids (the retryable failure)", async () => {
    const outcome = await lookupOrderStatus("FAIL-1");
    expect(outcome.kind).toBe("transport_error");
    if (outcome.kind === "transport_error") {
      expect(outcome.error).toBeInstanceOf(TransportError);
    }
  });
});
