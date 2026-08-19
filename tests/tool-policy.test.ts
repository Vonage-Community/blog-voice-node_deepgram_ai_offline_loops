import { describe, expect, it } from "vitest";
import {
  classifyHandoffReason,
  createToolPolicy,
  isOutOfScope,
  MAX_RETRIES,
  MAX_TOOL_CALLS,
  TOOL_TIMEOUT_MS,
} from "../src/agent/tool-policy.js";
import type { OrderLookupOutcome } from "../src/tools/order-status.js";
import { TransportError } from "../src/tools/order-status.js";

const transportError: OrderLookupOutcome = {
  kind: "transport_error",
  error: new TransportError("dropped"),
  durationMs: 60,
};
const timeout: OrderLookupOutcome = { kind: "timeout", durationMs: 1500 };
const notFound: OrderLookupOutcome = {
  kind: "result",
  result: { status: "not_found" },
  durationMs: 120,
};

describe("contract constants", () => {
  it("matches the Live-Path Contract", () => {
    expect(TOOL_TIMEOUT_MS).toBe(1500);
    expect(MAX_TOOL_CALLS).toBe(1);
    expect(MAX_RETRIES).toBe(1);
  });
});

describe("authorizeCall", () => {
  it("allows the first getOrderStatus call", () => {
    const policy = createToolPolicy();
    expect(policy.authorizeCall("getOrderStatus").allowed).toBe(true);
  });

  it("blocks a second call after the first is recorded", () => {
    const policy = createToolPolicy();
    expect(policy.authorizeCall("getOrderStatus").allowed).toBe(true);
    policy.recordCall();
    const second = policy.authorizeCall("getOrderStatus");
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/already been made/i);
    expect(policy.callsMade).toBe(1);
  });

  it("rejects tools that are not on the allowlist", () => {
    const policy = createToolPolicy();
    const decision = policy.authorizeCall("refundOrder");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowlist/i);
  });
});

describe("authorizeRetry", () => {
  it("allows exactly one retry on a transport failure", () => {
    const policy = createToolPolicy();
    const first = policy.authorizeRetry(transportError);
    expect(first.allowed).toBe(true);

    policy.recordRetry();
    const second = policy.authorizeRetry(transportError);
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/limit/i);
    expect(policy.retriesUsed).toBe(1);
  });

  it("does NOT retry a not_found result", () => {
    const policy = createToolPolicy();
    const decision = policy.authorizeRetry(notFound);
    expect(decision.allowed).toBe(false);
  });

  it("does NOT retry a timeout (timeouts trigger the fallback)", () => {
    const policy = createToolPolicy();
    const decision = policy.authorizeRetry(timeout);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/fallback/i);
  });
});

describe("isOutOfScope", () => {
  it("flags billing, returns, and disputes as out of scope", () => {
    expect(isOutOfScope("I have a question about my billing")).toBe(true);
    expect(isOutOfScope("I want to return this item")).toBe(true);
    expect(isOutOfScope("I'd like to dispute a charge")).toBe(true);
  });

  it("does not flag an in-scope order-status request", () => {
    expect(isOutOfScope("where is my order A1001")).toBe(false);
    expect(isOutOfScope("can you check the status of my package")).toBe(false);
  });
});

describe("classifyHandoffReason", () => {
  it("maps the canonical example phrases to categories", () => {
    expect(classifyHandoffReason("I want to dispute a charge")).toBe("billing");
    expect(classifyHandoffReason("I want to return my order")).toBe("returns");
    expect(classifyHandoffReason("Cancel my order")).toBe("cancellation");
    expect(classifyHandoffReason("I can't access my account")).toBe("account");
  });

  it("maps other out-of-scope topics to unsupported", () => {
    expect(classifyHandoffReason("I have a complaint")).toBe("unsupported");
    expect(classifyHandoffReason("this is a warranty question")).toBe("unsupported");
  });

  it("catches an explicit request for a human as unsupported", () => {
    expect(classifyHandoffReason("Okay. Transfer me to support.")).toBe("unsupported");
    expect(classifyHandoffReason("connect me to a human")).toBe("unsupported");
    expect(classifyHandoffReason("I want to talk to a representative")).toBe("unsupported");
    expect(classifyHandoffReason("get me a real person")).toBe("unsupported");
  });

  it("lets a named topic win over a generic transfer word", () => {
    // "transfer" alone is unsupported, but a billing topic is more specific.
    expect(classifyHandoffReason("transfer me, I want to dispute a charge")).toBe("billing");
  });

  it("returns null for in-scope order-status requests", () => {
    expect(classifyHandoffReason("where is my order A1001")).toBeNull();
    expect(classifyHandoffReason("has my package shipped yet")).toBeNull();
  });

  it("stays consistent with isOutOfScope", () => {
    expect(isOutOfScope("refund please")).toBe(classifyHandoffReason("refund please") !== null);
    expect(isOutOfScope("track my order")).toBe(classifyHandoffReason("track my order") !== null);
  });
});
