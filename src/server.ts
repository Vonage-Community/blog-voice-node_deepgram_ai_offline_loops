// -----------------------------------------------------------------------------
// HTTP + WebSocket server. Wires the two Vonage webhooks and the audio socket.
//
//   GET  /answer  -> NCCO that connects the call to our WebSocket
//   POST /event   -> Vonage call lifecycle events (logged; fires onCallEnded)
//   WS   /socket  -> the bridged audio stream (placeholder for now)
//   GET  /health  -> liveness probe, handy for smoke tests and uptime checks
//
// `buildApp()` constructs the app without listening, so tests can drive it with
// supertest. `startServer()` binds the port and is called only when this file
// is run directly. The WebSocket handler is intentionally a stub — the real
// Vonage <-> Deepgram bridge (websocket-handler.ts) is a later task.
// -----------------------------------------------------------------------------

import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import expressWs from "express-ws";
import { answerWebhook } from "./voice/answer-webhook.js";
import { createEventWebhook } from "./voice/event-webhook.js";
import { createCallSession, type CallSession, type WsLike } from "./voice/websocket-handler.js";
import { createAgentConfig } from "./agent/agent-config.js";
import { openDatabase } from "./storage/db.js";

/** The express-ws-augmented app type (plain Express plus the `.ws()` method). */
export type VoiceApp = expressWs.Application;

/**
 * Build the Express application with all routes registered. Does not listen —
 * call `startServer()` (or hand the returned app to supertest) to run it.
 */
export function buildApp(): VoiceApp {
  // express-ws augments the app with `.ws()` and manages the HTTP upgrade.
  const { app } = expressWs(express());

  // Vonage posts events as JSON. Answer webhook params arrive on the query string.
  app.use(express.json());

  // One database for the process; every call writes its record here.
  const db = openDatabase(process.env.DB_PATH ?? "./data/calls.db");

  // Model overrides from the environment (blank ⇒ defaults in agent-config.ts).
  const agentSettings = createAgentConfig({
    ...(process.env.DEEPGRAM_LISTEN_MODEL ? { listenModel: process.env.DEEPGRAM_LISTEN_MODEL } : {}),
    ...(process.env.DEEPGRAM_SPEAK_MODEL ? { speakModel: process.env.DEEPGRAM_SPEAK_MODEL } : {}),
    ...(process.env.DEEPGRAM_THINK_MODEL
      ? { thinkProvider: { type: "anthropic", model: process.env.DEEPGRAM_THINK_MODEL } }
      : {}),
  });

  // Live sessions, keyed by call UUID, so a call that ends via the event webhook
  // (not a socket close) can still be finalized.
  const sessions = new Map<string, CallSession>();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/answer", answerWebhook);

  // When Vonage reports a call ended, finalize its session if the socket hasn't
  // already done so (finalize is idempotent).
  app.post(
    "/event",
    createEventWebhook((uuid) => {
      sessions.get(uuid)?.finalize();
    }),
  );

  // The real Vonage <-> Deepgram bridge. The call UUID rides on the query string
  // (see answer-webhook.ts); fall back to a random id so a stray connection
  // still produces a record.
  app.ws("/socket", (ws, req) => {
    const callUuid =
      typeof req.query.callUuid === "string" && req.query.callUuid.length > 0
        ? req.query.callUuid
        : randomUUID();

    console.log(`[socket] Vonage connected: ${callUuid}`);
    const session = createCallSession(ws as unknown as WsLike, { db, callUuid, agentSettings });
    sessions.set(callUuid, session);

    ws.on("close", () => {
      sessions.delete(callUuid);
      console.log(`[socket] Vonage disconnected: ${callUuid}`);
    });
  });

  return app;
}

/** Bind the app to PORT and start listening. */
export function startServer(): void {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`Order-status voice agent listening on :${port}`);
    if (!process.env.BASE_URL) {
      console.warn("Warning: BASE_URL is not set — /answer will return 500.");
    }
    if (!process.env.DEEPGRAM_API_KEY) {
      console.warn(
        "Warning: DEEPGRAM_API_KEY is not set — the Deepgram socket will be rejected " +
          "(HTTP 401) and every call ends with outcome=error.",
      );
    }
  });
}

// Run only when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  startServer();
}
