import { describe, expect, it } from "vitest";
import {
  buildAnswerNcco,
  toWebSocketBase,
  type ConnectAction,
} from "../src/voice/answer-webhook.js";

describe("toWebSocketBase", () => {
  it("maps https to wss and http to ws", () => {
    expect(toWebSocketBase("https://x.ngrok-free.app")).toBe("wss://x.ngrok-free.app");
    expect(toWebSocketBase("http://localhost:3000")).toBe("ws://localhost:3000");
  });

  it("trims a trailing slash so the path is not doubled", () => {
    expect(toWebSocketBase("https://x.ngrok-free.app/")).toBe("wss://x.ngrok-free.app");
  });
});

describe("buildAnswerNcco", () => {
  const ncco = buildAnswerNcco({
    baseUrl: "https://x.ngrok-free.app",
    callUuid: "call-uuid-123",
    from: "15551234567",
  });

  it("returns a talk action followed by a connect action", () => {
    expect(ncco).toHaveLength(2);
    expect(ncco[0]?.action).toBe("talk");
    expect(ncco[1]?.action).toBe("connect");
  });

  it("connects to wss://<base>/socket with the linear16/8000 content-type", () => {
    const connect = ncco[1] as ConnectAction;
    const endpoint = connect.endpoint[0]!;
    expect(endpoint.type).toBe("websocket");
    expect(endpoint.uri).toBe("wss://x.ngrok-free.app/socket?callUuid=call-uuid-123");
    expect(endpoint["content-type"]).toBe("audio/l16;rate=8000");
  });

  it("uses a synchronous connect with the event URL built from BASE_URL", () => {
    const connect = ncco[1] as ConnectAction;
    expect(connect.eventType).toBe("synchronous");
    expect(connect.eventUrl).toEqual(["https://x.ngrok-free.app/event"]);
  });

  it("forwards the call UUID to the socket via headers", () => {
    const connect = ncco[1] as ConnectAction;
    expect(connect.endpoint[0]?.headers).toEqual({ callUuid: "call-uuid-123" });
  });

  it("includes the caller number when provided and omits it otherwise", () => {
    const connect = ncco[1] as ConnectAction;
    expect(connect.from).toBe("15551234567");

    const anon = buildAnswerNcco({ baseUrl: "https://x.ngrok-free.app", callUuid: "u" });
    expect((anon[1] as ConnectAction).from).toBeUndefined();
  });
});
