// -----------------------------------------------------------------------------
// Answer webhook — Vonage calls this when a call comes in, and expects an NCCO
// (Nexmo Call Control Object) back. Ours connects the call to our WebSocket so
// audio can be bridged to Deepgram (the bridging itself is a later task).
//
// Two details from AGENTS.md are load-bearing here:
//
//   - The WebSocket content-type MUST be `audio/l16;rate=8000` so Vonage sends
//     the linear16/8000 PCM that the Deepgram settings expect.
//   - The WebSocket URI is built from BASE_URL, never from req.hostname. Behind
//     an ngrok tunnel req.hostname can resolve to "localhost", which produces a
//     WebSocket URL Vonage cannot reach.
//
// `buildAnswerNcco` is a pure function (easy to test); `answerWebhook` is the
// thin Express handler that reads BASE_URL and the call's query params.
// -----------------------------------------------------------------------------

import type { Request, Response } from "express";
import { AUDIO_SAMPLE_RATE } from "../agent/agent-config.js";

/** The WebSocket endpoint inside a `connect` action. */
export interface WebSocketEndpoint {
  type: "websocket";
  uri: string;
  "content-type": string;
  headers: Record<string, string>;
}

/** The `connect` NCCO action that bridges the call to our WebSocket. */
export interface ConnectAction {
  action: "connect";
  eventType: "synchronous";
  eventUrl: string[];
  from?: string;
  endpoint: WebSocketEndpoint[];
}

/** A spoken message played before the connect completes. */
export interface TalkAction {
  action: "talk";
  text: string;
  language?: string;
}

export type NccoAction = TalkAction | ConnectAction;
export type Ncco = NccoAction[];

export interface AnswerNccoParams {
  /** Public HTTPS base URL of the tunnel/deployment, e.g. https://x.ngrok-free.app */
  baseUrl: string;
  /** Vonage call UUID, forwarded to the socket so the handler can correlate it. */
  callUuid: string;
  /** The caller's number, if Vonage provided it. */
  from?: string;
}

/**
 * Convert an HTTP(S) base URL into its WebSocket (WS/WSS) equivalent. A trailing
 * slash is trimmed so we don't produce `//socket`.
 */
export function toWebSocketBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.replace(/^http(s?):\/\//i, (_match, s) => `ws${s}://`);
}

/**
 * Build the NCCO returned to Vonage: a brief spoken greeting, then a synchronous
 * `connect` to our WebSocket. The call UUID rides along in the WebSocket
 * `headers` so the (later) socket handler can tie the stream to a call record.
 */
export function buildAnswerNcco(params: AnswerNccoParams): Ncco {
  const { baseUrl, callUuid, from } = params;
  const wsBase = toWebSocketBase(baseUrl);

  return [
    {
      action: "talk",
      text: "Please hold while I connect you to our order-status assistant.",
      language: "en-US",
    },
    {
      action: "connect",
      eventType: "synchronous",
      eventUrl: [`${baseUrl.replace(/\/+$/, "")}/event`],
      ...(from ? { from } : {}),
      endpoint: [
        {
          type: "websocket",
          // Pass the call UUID on the query string too: it's the most reliable
          // way for the /socket route to read it (headers arrive later, in the
          // first Vonage control frame).
          uri: `${wsBase}/socket?callUuid=${encodeURIComponent(callUuid)}`,
          "content-type": `audio/l16;rate=${AUDIO_SAMPLE_RATE}`,
          headers: { callUuid },
        },
      ],
    },
  ];
}

/**
 * Express handler for `GET /answer`. Reads BASE_URL from the environment and the
 * call's identifiers from the query string Vonage appends (`uuid`, `from`).
 */
export function answerWebhook(req: Request, res: Response): void {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    // Misconfiguration, not a caller error — fail loudly so it's caught in dev.
    res.status(500).json({ error: "BASE_URL is not set" });
    return;
  }

  const callUuid = typeof req.query.uuid === "string" ? req.query.uuid : "";
  const from = typeof req.query.from === "string" ? req.query.from : undefined;

  res.json(buildAnswerNcco({ baseUrl, callUuid, from }));
}
