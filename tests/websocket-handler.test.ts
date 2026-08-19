import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../src/storage/db.js";
import { readCallRecord } from "../src/storage/call-records.js";
import {
  createCallSession,
  WS_OPEN,
  type WsLike,
} from "../src/voice/websocket-handler.js";
import { GREETING } from "../src/agent/fallback-responses.js";

type Listener = (...args: unknown[]) => void;

/** A fake WebSocket that records sent frames and lets tests emit events. */
class FakeWs implements WsLike {
  readyState = WS_OPEN;
  sent: Array<string | Buffer> = [];
  private listeners = new Map<string, Listener[]>();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  close(): void {
    if (this.readyState === WS_OPEN) {
      this.readyState = 3; // CLOSED
      this.emit("close");
    }
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  /** All JSON (text) frames sent, parsed. */
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as Record<string, unknown>);
  }
  jsonOfType(type: string): Array<Record<string, unknown>> {
    return this.json().filter((m) => m.type === type);
  }
}

/** Emit a JSON control frame from Deepgram (as a Buffer, isBinary=false). */
function dgSend(dg: FakeWs, message: unknown): void {
  dg.emit("message", Buffer.from(JSON.stringify(message)), false);
}

function conversationText(role: "user" | "assistant", content: string) {
  return { type: "ConversationText", role, content };
}
function functionCall(orderId: string, id = "fc-1") {
  return {
    type: "FunctionCallRequest",
    functions: [
      { id, name: "getOrderStatus", arguments: JSON.stringify({ orderId }), client_side: true },
    ],
  };
}

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

describe("createCallSession — audio + control bridging", () => {
  it("sends the Settings message to Deepgram on open", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });

    dg.emit("open");
    const settings = dg.jsonOfType("Settings");
    expect(settings).toHaveLength(1);
    expect((settings[0] as { agent: { think: { functions: unknown[] } } }).agent.think.functions).toHaveLength(1);
  });

  it("forwards caller audio (Vonage binary) to Deepgram once open", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    const audio = Buffer.from([1, 2, 3, 4]);
    vonage.emit("message", audio, true);
    expect(dg.sent).toContain(audio);
  });

  it("forwards Vonage binary even when isBinary is absent (ws@7 semantics)", () => {
    // express-ws uses ws@7, whose message event passes NO isBinary arg and
    // delivers binary as a Buffer. This is the exact case that caused
    // CLIENT_MESSAGE_TIMEOUT before the isBinaryFrame fix.
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    const audio = Buffer.from([5, 6, 7]);
    vonage.emit("message", audio); // no second arg — ws@7 style
    expect(dg.sent).toContain(audio);
  });

  it("does NOT forward a Vonage text frame (string, no isBinary) as audio", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    const before = dg.sent.length; // Settings was already sent on open
    vonage.emit("message", JSON.stringify({ event: "websocket:connected" })); // ws@7 text = string
    expect(dg.sent.length).toBe(before); // control frame not forwarded as audio
  });

  it("forwards agent audio (Deepgram binary) to Vonage", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    const audio = Buffer.from([9, 8, 7]);
    dg.emit("message", audio, true);
    expect(vonage.sent).toContain(audio);
  });

  it("greets the caller (InjectAgentMessage) when Deepgram signals SettingsApplied", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0); // nothing yet
    dgSend(dg, { type: "SettingsApplied" });

    const injected = dg.jsonOfType("InjectAgentMessage");
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message).toBe(GREETING);
  });

  it("drops History/LatencyReport silently but logs genuinely-unknown types", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      dgSend(dg, { type: "History", messages: [] });
      dgSend(dg, { type: "LatencyReport", total: 42 });
      dgSend(dg, { type: "SomethingBrandNew" });

      const unhandled = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("(unhandled)"));
      expect(unhandled).toEqual(["[dg] (unhandled) SomethingBrandNew"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('sends {"action":"clear"} to Vonage on UserStartedSpeaking (barge-in)', () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c1", connectDeepgram: () => dg });
    dg.emit("open");

    dgSend(dg, { type: "UserStartedSpeaking" });
    expect(vonage.json()).toContainEqual({ action: "clear" });
  });
});

describe("createCallSession — tool policy enforcement", () => {
  it("successful lookup → FunctionCallResponse sent, record outcome completed", async () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-success", connectDeepgram: () => dg });
    dg.emit("open");

    dgSend(dg, conversationText("user", "where is my order A1001"));
    dgSend(dg, functionCall("A1001", "fc-success"));

    await vi.waitFor(() => expect(dg.jsonOfType("FunctionCallResponse")).toHaveLength(1));

    const response = dg.jsonOfType("FunctionCallResponse")[0]!;
    expect(response.id).toBe("fc-success");
    expect(response.name).toBe("getOrderStatus");
    expect(JSON.parse(response.content as string)).toEqual({
      status: "in_transit",
      estimatedDelivery: "2026-07-29",
    });
    // No fallback line was injected.
    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0);

    vonage.close(); // hang up
    const record = readCallRecord(db, "c-success")!;
    expect(record.outcome).toBe("completed");
    expect(record.fallbackUsed).toBe(false);
    expect(record.handoffRequested).toBe(false);
    expect(record.toolCalls[0]).toMatchObject({ success: true, args: { orderId: "A1001" } });
    expect(record.toolCalls[0]?.durationMs).toBeGreaterThan(0);
    expect(record.latency.toolMs).toBeGreaterThan(0);
    expect(record.transcript[0]).toMatchObject({ speaker: "caller", text: "where is my order A1001" });
  });

  it("timeout → fallback injected, not retried, record fallbackUsed:true", async () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-timeout", connectDeepgram: () => dg });
    dg.emit("open");

    dgSend(dg, conversationText("user", "status of order SLOW-1 please"));
    dgSend(dg, functionCall("SLOW-1", "fc-timeout"));

    // SLOW* takes 2000ms; the 1500ms deadline fires first.
    await vi.waitFor(
      () => expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(1),
      { timeout: 3000 },
    );

    const injected = dg.jsonOfType("InjectAgentMessage")[0]!;
    expect(injected.message).toContain("having trouble retrieving that order");
    // Only one attempt — a timeout is never retried.
    expect(dg.jsonOfType("FunctionCallResponse")).toHaveLength(1);

    vonage.close();
    const record = readCallRecord(db, "c-timeout")!;
    expect(record.fallbackUsed).toBe(true);
    expect(record.outcome).toBe("fallback");
    expect(record.toolCalls[0]?.result).toBe("timeout");
    expect(record.toolCalls[0]?.success).toBe(false);
  });

  it("out-of-scope caller utterance → records handoff+reason, transfers, no tool call", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    const transfer = vi.fn().mockResolvedValue(undefined);
    createCallSession(vonage, { db, callUuid: "c-selfhandoff", connectDeepgram: () => dg, transfer });
    dg.emit("open");

    // Caller is out of scope; the model would speak the handoff line itself, but
    // we detect + classify from the caller transcript and transfer to a human.
    dgSend(dg, conversationText("user", "I want to dispute a charge"));

    // We don't inject a Deepgram promise — the transfer NCCO speaks the line.
    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0);
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledWith("c-selfhandoff", "billing");

    vonage.close();
    const record = readCallRecord(db, "c-selfhandoff")!;
    expect(record.outcome).toBe("handoff");
    expect(record.handoffRequested).toBe(true);
    expect(record.handoffReason).toBe("billing");
    expect(record.toolCalls).toEqual([]);
    expect(record.fallbackUsed).toBe(false);
  });

  it("backstop: model calls the tool during an out-of-scope request → transfer, tool never runs", async () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    const transfer = vi.fn().mockResolvedValue(undefined);
    createCallSession(vonage, { db, callUuid: "c-handoff", connectDeepgram: () => dg, transfer });
    dg.emit("open");

    // Caller asks to cancel; the model still (wrongly) tries the tool.
    dgSend(dg, conversationText("user", "please cancel my order"));
    dgSend(dg, functionCall("A1001", "fc-handoff"));

    await vi.waitFor(() => expect(dg.jsonOfType("FunctionCallResponse")).toHaveLength(1));
    // We answer the pending function call, but don't inject a promise.
    expect(JSON.parse(dg.jsonOfType("FunctionCallResponse")[0]!.content as string)).toEqual({
      status: "handoff",
    });
    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0);
    expect(transfer).toHaveBeenCalledWith("c-handoff", "cancellation");

    vonage.close();
    const record = readCallRecord(db, "c-handoff")!;
    expect(record.handoffRequested).toBe(true);
    expect(record.handoffReason).toBe("cancellation");
    expect(record.outcome).toBe("handoff");
    // Tool was never actually executed: no measured duration.
    expect(record.toolCalls[0]?.durationMs).toBe(0);
    expect(record.toolCalls[0]?.result).toEqual({ status: "error", reason: "out_of_scope" });
  });

  it("explicit 'transfer me to support' → transfers even without a named topic", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    const transfer = vi.fn().mockResolvedValue(undefined);
    createCallSession(vonage, { db, callUuid: "c-askhuman", connectDeepgram: () => dg, transfer });
    dg.emit("open");

    dgSend(dg, conversationText("user", "Okay. Transfer me to support."));

    expect(transfer).toHaveBeenCalledWith("c-askhuman", "unsupported");
    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0);

    vonage.close();
    const record = readCallRecord(db, "c-askhuman")!;
    expect(record.outcome).toBe("handoff");
    expect(record.handoffReason).toBe("unsupported");
  });

  it("transfer failure is handled: no crash, handoff still recorded", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    const transfer = vi.fn().mockRejectedValue(new Error("Vonage API 404"));
    createCallSession(vonage, { db, callUuid: "c-xferfail", connectDeepgram: () => dg, transfer });
    dg.emit("open");

    expect(() => dgSend(dg, conversationText("user", "I can't access my account"))).not.toThrow();
    expect(transfer).toHaveBeenCalledWith("c-xferfail", "account");

    vonage.close();
    const record = readCallRecord(db, "c-xferfail")!;
    expect(record.outcome).toBe("handoff");
    expect(record.handoffRequested).toBe(true);
    expect(record.handoffReason).toBe("account");
  });

  it("stamps the configured agentVersion onto the record", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, {
      db,
      callUuid: "c-version",
      connectDeepgram: () => dg,
      agentVersion: "order-status-v9",
    });
    dg.emit("open");
    vonage.close();
    expect(readCallRecord(db, "c-version")?.agentVersion).toBe("order-status-v9");
  });

  it("not_found → result returned via FunctionCallResponse, no fallback, no retry", async () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-nf", connectDeepgram: () => dg });
    dg.emit("open");

    dgSend(dg, conversationText("user", "order ZZZ-000"));
    dgSend(dg, functionCall("ZZZ-000", "fc-nf"));

    await vi.waitFor(() => expect(dg.jsonOfType("FunctionCallResponse")).toHaveLength(1));
    // The response to the model carries a narration hint, but stays not_found —
    // it is a valid result, never a fallback.
    const payload = JSON.parse(dg.jsonOfType("FunctionCallResponse")[0]!.content as string);
    expect(payload.status).toBe("not_found");
    expect(payload.message).toMatch(/double-check the number/i);
    // And it must instruct the model NOT to promise another lookup (one per call).
    expect(payload.message).toMatch(/only one lookup|do not.*again/i);
    expect(dg.jsonOfType("InjectAgentMessage")).toHaveLength(0);

    vonage.close();
    const record = readCallRecord(db, "c-nf")!;
    expect(record.fallbackUsed).toBe(false);
    expect(record.outcome).toBe("completed");
    // The stored evidence keeps the clean result — the hint is narration-only.
    expect(record.toolCalls[0]?.result).toEqual({ status: "not_found" });
  });
});

describe("createCallSession — lifecycle", () => {
  it("Deepgram connect failure (error → close) → record outcome:error, Vonage closed", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-dgerror", connectDeepgram: () => dg });

    // Simulate an upgrade rejection: the socket never opens, it errors then closes.
    dg.emit("error", new Error("Unexpected server response: 401"));
    dg.emit("close", 1006, Buffer.from(""));

    expect(vonage.readyState).toBe(3); // CLOSED
    const record = readCallRecord(db, "c-dgerror")!;
    expect(record.outcome).toBe("error");
    expect(record.toolCalls).toEqual([]);
  });

  it("a Vonage socket error does not throw and is recorded", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-vgerror", connectDeepgram: () => dg });
    dg.emit("open");

    expect(() => vonage.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    vonage.close();
    expect(readCallRecord(db, "c-vgerror")?.outcome).toBe("error");
  });

  it("Deepgram Error message (e.g. rejected Settings) → record outcome:error", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-dgsettings", connectDeepgram: () => dg });
    dg.emit("open");

    // Deepgram accepts the socket, then rejects the Settings payload and closes.
    dgSend(dg, { type: "Error", description: "unsupported think model" });
    dg.emit("close", 1005);

    const record = readCallRecord(db, "c-dgsettings")!;
    expect(record.outcome).toBe("error");
    expect(record.toolCalls).toEqual([]);
  });

  it("Deepgram close → Vonage closes cleanly and the record is written", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    createCallSession(vonage, { db, callUuid: "c-close", connectDeepgram: () => dg });
    dg.emit("open");

    dg.emit("close");

    expect(vonage.readyState).toBe(3); // CLOSED
    expect(readCallRecord(db, "c-close")).not.toBeNull();
  });

  it("finalize() is idempotent across the event-webhook hook and socket close", () => {
    const vonage = new FakeWs();
    const dg = new FakeWs();
    const session = createCallSession(vonage, { db, callUuid: "c-idem", connectDeepgram: () => dg });
    dg.emit("open");

    session.finalize(); // e.g. from onCallEnded via the event webhook
    vonage.close(); // then the socket also closes

    const count = db.prepare("SELECT COUNT(*) AS n FROM call_records").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
