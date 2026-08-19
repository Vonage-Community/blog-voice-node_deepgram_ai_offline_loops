// -----------------------------------------------------------------------------
// The Vonage <-> Deepgram bridge, and the place where every rule in the
// Live-Path Contract is actually enforced at runtime.
//
// Audio path (pure forwarding, no re-encoding — both sides speak linear16/8000):
//   Vonage binary  --> Deepgram   (caller audio)
//   Deepgram binary --> Vonage    (agent audio)
//   Deepgram "UserStartedSpeaking" --> Vonage {"action":"clear"}  (barge-in)
//
// Control path (the enforcement):
//   Deepgram "ConversationText"    --> transcript entry
//   Deepgram "FunctionCallRequest" --> run getOrderStatus THROUGH the tool
//                                      policy, with timeout/retry/fallback, then
//                                      answer with a "FunctionCallResponse"
//
// The model can *ask* to call the tool; this handler decides whether it may,
// how long it gets, whether a failure is retried, and what the caller hears
// when it fails. A `CallRecord` is assembled as the call runs and written once
// at the end — the evidence Part 2 will read.
//
// Both WebSockets and the Deepgram connector are injected so the whole thing is
// unit-testable without a real network (see tests/websocket-handler.test.ts).
// -----------------------------------------------------------------------------

import type { Database as DatabaseType } from "better-sqlite3";
import { WebSocket } from "ws";
import { createAgentConfig, type DeepgramAgentSettings } from "../agent/agent-config.js";
import { FALLBACK_RESPONSE, GREETING } from "../agent/fallback-responses.js";
import { createToolPolicy } from "../agent/tool-policy.js";
import { classifyHandoffReason, type HandoffReason } from "../agent/tool-policy.js";
import { AGENT_VERSION } from "../agent/agent-version.js";
import { lookupOrderStatus } from "../tools/order-status.js";
import { writeCallRecord } from "../storage/call-records.js";
import type {
  CallOutcome,
  CallRecord,
  LatencyBreakdown,
  ToolCallRecord,
  TranscriptEntry,
} from "../storage/db.js";
import { createTurnTimer } from "./audio-pipeline.js";
import { transferToHuman } from "./transfer-to-human.js";

/** The Deepgram Voice Agent converse endpoint (see AGENTS.md). */
export const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

/** `readyState` value for an open WebSocket (matches the `ws` library). */
export const WS_OPEN = 1;

/**
 * High-frequency Deepgram messages we intentionally ignore *silently*. They fire
 * many times per turn and would drown the console; dropping them keeps the live
 * logs readable. Anything NOT in here still logs as `[dg] (unhandled) <type>` so
 * a genuinely new message type from Deepgram never slips past unnoticed.
 */
const SILENT_DG_MESSAGE_TYPES: ReadonlySet<string> = new Set(["History", "LatencyReport"]);

/** The minimal slice of a WebSocket this module depends on (Vonage or Deepgram). */
export interface WsLike {
  send(data: string | Buffer): void;
  on(event: string, listener: (...args: any[]) => void): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

/** Opens a connection to Deepgram. Injected so tests can supply a fake socket. */
export type DeepgramConnector = () => WsLike;

export interface CallSessionDeps {
  db: DatabaseType;
  /** Vonage call UUID; becomes the call record's primary key. */
  callUuid: string;
  /** How to open the Deepgram socket. Defaults to the real endpoint. */
  connectDeepgram?: DeepgramConnector;
  /** Settings sent to Deepgram on open. Defaults to the bounded config. */
  agentSettings?: DeepgramAgentSettings;
  /** Version string stamped on the call record. Defaults to AGENT_VERSION. */
  agentVersion?: string;
  /** How to transfer the live call to a human. Injected so tests can mock it. */
  transfer?: (callUuid: string, reason: HandoffReason) => Promise<void>;
  /** Monotonic clock for latency (ms). Defaults to performance.now. */
  now?: () => number;
}

export interface CallSession {
  /** Finalize and persist the record. Idempotent; safe to call from any path. */
  finalize(outcome?: CallOutcome): void;
}

/** Shape of the one function inside a Deepgram FunctionCallRequest. */
interface DeepgramFunctionCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded string, must be parsed
  client_side?: boolean;
}

const ZERO_LATENCY: LatencyBreakdown = {
  speechToTextMs: 0,
  modelMs: 0,
  toolMs: 0,
  textToSpeechMs: 0,
  totalTurnMs: 0,
};

/** JSON-send helper: control messages are always text frames. */
function sendJson(ws: WsLike, message: unknown): void {
  ws.send(JSON.stringify(message));
}

/** Shorten text for a log line so a long transcript can't flood the console. */
function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Decide whether a WebSocket `message` frame is binary audio — correctly, across
 * two different `ws` versions:
 *
 *   - ws@8 (our Deepgram socket): passes an `isBinary` boolean, and delivers
 *     BOTH text and binary as Buffers — so we must trust `isBinary`.
 *   - ws@7 (the Vonage socket, via express-ws): passes NO second arg, and
 *     delivers binary as Buffer, text as string — so we fall back to the type.
 *
 * Getting this wrong is silent and fatal: on ws@7, relying on the (absent)
 * `isBinary` routes every audio frame into the text branch, Deepgram receives no
 * audio, and the call dies with CLIENT_MESSAGE_TIMEOUT.
 */
function isBinaryFrame(data: unknown, isBinary: unknown): boolean {
  if (typeof isBinary === "boolean") return isBinary;
  return typeof data !== "string";
}

/**
 * Wire up one phone call. Returns a `CallSession` whose `finalize()` the event
 * webhook can call if the call ends via Vonage's event webhook rather than the
 * WebSocket closing.
 */
export function createCallSession(vonageWs: WsLike, deps: CallSessionDeps): CallSession {
  const {
    db,
    callUuid,
    connectDeepgram = defaultDeepgramConnector,
    agentSettings = createAgentConfig(),
    agentVersion = AGENT_VERSION,
    transfer = transferToHuman,
    now,
  } = deps;

  const policy = createToolPolicy();
  const timer = createTurnTimer(now);
  const startedAt = new Date().toISOString();
  const callStartMs = Date.now();

  // Record accumulators.
  const transcript: TranscriptEntry[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let latency: LatencyBreakdown = ZERO_LATENCY;
  let fallbackUsed = false;
  let handoffRequested = false;
  let handoffReason: HandoffReason | null = null;
  let errored = false;

  // The caller's most recent utterance — used as the out-of-scope backstop when
  // a FunctionCallRequest arrives.
  let lastCallerUtterance = "";

  let dgOpen = false;
  let finalized = false;
  const dg = connectDeepgram();
  timer.begin();

  // --- outbound helpers ------------------------------------------------------

  function inject(message: string): void {
    // `interrupt` guarantees the deterministic line is spoken even mid-turn.
    sendJson(dg, { type: "InjectAgentMessage", message, behavior: "interrupt" });
  }

  function respondToFunction(fn: DeepgramFunctionCall, content: string): void {
    sendJson(dg, { type: "FunctionCallResponse", id: fn.id, name: fn.name, content });
    let status = "?";
    try {
      status = (JSON.parse(content) as { status?: string }).status ?? "?";
    } catch {
      /* content wasn't JSON — leave status as ? */
    }
    console.log(`[dg] FunctionCallResponse sent: status=${status}`);
  }

  /**
   * Record a handoff and transfer the live call to a human — once per call. The
   * transfer NCCO speaks the transition line and connects support, so we don't
   * inject a Deepgram promise here. Transfer runs fire-and-forget with a `.catch`
   * so a failed transfer is logged but never crashes the call; the record still
   * reflects that a handoff was requested.
   */
  function requestHandoff(reason: HandoffReason): void {
    if (handoffRequested) return; // already handed off; don't transfer twice
    handoffRequested = true;
    handoffReason = reason;
    console.log(`[call] handoff requested (reason=${reason}) — transferring to human`);
    void transfer(callUuid, reason).catch((err: unknown) => {
      console.error(`[transfer] failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // --- Deepgram -> app -------------------------------------------------------

  function handleConversationText(msg: { role?: string; content?: string }): void {
    const speaker = msg.role === "user" ? "caller" : "agent";
    const text = msg.content ?? "";
    transcript.push({ speaker, text, timestampMs: Date.now() - callStartMs });
    console.log(`[dg] ConversationText ${speaker}: "${truncate(text)}"`);

    if (speaker === "caller") {
      lastCallerUtterance = text;
      timer.mark("speechToText");
      // Detect an out-of-scope request straight from the caller's transcript,
      // classify the reason, and transfer to a human — even when the model would
      // otherwise just speak the handoff line itself. (The tool-call backstop in
      // handleFunctionCall covers a misbehaving model that calls the tool during
      // an out-of-scope request.)
      const reason = classifyHandoffReason(text);
      if (reason) requestHandoff(reason);
    } else {
      timer.mark("textToSpeech");
    }
  }

  async function handleFunctionCall(fn: DeepgramFunctionCall): Promise<void> {
    timer.mark("model"); // the model committed to a tool call

    let orderId = "";
    try {
      orderId = String((JSON.parse(fn.arguments || "{}") as { orderId?: unknown }).orderId ?? "");
    } catch {
      orderId = "";
    }
    console.log(`[dg] FunctionCallRequest: ${fn.name} { orderId: "${orderId}" }`);

    // 1) Out-of-scope backstop — never call the tool, hand off immediately. The
    //    transfer NCCO (not Deepgram) speaks the transition line, so we don't
    //    inject anything here; we just answer the pending function call.
    const backstopReason = classifyHandoffReason(lastCallerUtterance);
    if (backstopReason) {
      requestHandoff(backstopReason);
      respondToFunction(fn, JSON.stringify({ status: "handoff" }));
      toolCalls.push({
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: 0,
        result: { status: "error", reason: "out_of_scope" },
        success: false,
      });
      return;
    }

    // 2) Policy: is a call allowed at all (allowlist + one-call budget)?
    const auth = policy.authorizeCall(fn.name);
    if (!auth.allowed) {
      fallbackUsed = true;
      inject(FALLBACK_RESPONSE);
      respondToFunction(fn, JSON.stringify({ status: "blocked" }));
      toolCalls.push({
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: 0,
        result: { status: "error", reason: auth.reason ?? "blocked" },
        success: false,
      });
      return;
    }
    policy.recordCall();

    // 3) Run it under the deadline; retry ONCE on transport failure only.
    let outcome = await lookupOrderStatus(orderId);
    if (outcome.kind === "transport_error" && policy.authorizeRetry(outcome).allowed) {
      policy.recordRetry();
      outcome = await lookupOrderStatus(orderId);
    }
    timer.set("tool", outcome.durationMs);
    const resultLabel = outcome.kind === "result" ? outcome.result.status : outcome.kind;
    console.log(`[tool] lookupOrderStatus → ${resultLabel} in ${outcome.durationMs}ms`);

    // 4) React to the outcome.
    if (outcome.kind === "result") {
      // in_transit / delivered / not_found are ALL legitimate results — the tool
      // ran and answered. We hand the result to the model to narrate; none of
      // these is retried, and none triggers the fallback. The fallback text
      // ("having trouble retrieving that order") is semantically a *system
      // failure* message — wrong for not_found, where the system worked fine and
      // simply found nothing. For not_found we add a short human-readable hint so
      // the model narrates it helpfully and consistently ("couldn't find that
      // order, can you double-check the number?") without us hard-coding the
      // exact words — the right balance for a result with natural variation.
      const payload =
        outcome.result.status === "not_found"
          ? {
              status: "not_found",
              message:
                "No order was found with that ID. Tell the caller you couldn't find " +
                "it and ask them to double-check the number or contact support. Do " +
                "NOT offer to look it up again — only one lookup is allowed per call.",
            }
          : outcome.result;
      respondToFunction(fn, JSON.stringify(payload));
      toolCalls.push({
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: outcome.durationMs,
        result: outcome.result,
        success: true,
      });
      return;
    }

    // timeout, or transport_error after the one retry — deterministic fallback.
    fallbackUsed = true;
    inject(FALLBACK_RESPONSE);
    if (outcome.kind === "timeout") {
      respondToFunction(fn, JSON.stringify({ status: "timeout" }));
      toolCalls.push({
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: outcome.durationMs,
        result: "timeout",
        success: false,
      });
    } else {
      respondToFunction(fn, JSON.stringify({ status: "error" }));
      toolCalls.push({
        tool: "getOrderStatus",
        args: { orderId },
        durationMs: outcome.durationMs,
        result: { status: "error", reason: outcome.error.message },
        success: false,
      });
    }
  }

  async function handleDeepgramText(raw: string | Buffer): Promise<void> {
    let msg: { type?: string; role?: string; content?: string; functions?: DeepgramFunctionCall[] };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return; // ignore non-JSON control noise
    }

    switch (msg.type) {
      case "UserStartedSpeaking":
        // Barge-in: flush any buffered agent audio on the Vonage side.
        sendJson(vonageWs, { action: "clear" });
        timer.begin(); // a new caller turn starts
        break;
      case "ConversationText":
        handleConversationText(msg);
        break;
      case "FunctionCallRequest":
        for (const fn of msg.functions ?? []) {
          await handleFunctionCall(fn);
        }
        break;
      case "Error":
        // Deepgram rejected something (commonly a bad Settings field like an
        // unsupported model). It usually closes the socket right after. Log the
        // whole message so the field/reason is visible, and mark the call errored
        // so the record reflects that no real turn happened.
        errored = true;
        console.error(`[dg] Error: ${JSON.stringify(msg)}`);
        break;
      case "SettingsApplied":
        // The agent is now ready. Speak a deterministic opening line so the
        // caller has a clear cue to start talking (otherwise they hear the
        // Vonage "please hold" greeting, then silence, and don't know when to
        // speak). Fires once — SettingsApplied is sent once per session.
        console.log("[dg] SettingsApplied — sending greeting");
        inject(GREETING);
        break;
      case "Warning":
        console.warn(`[dg] Warning: ${JSON.stringify(msg)}`);
        break;
      default:
        // Surface anything we don't explicitly handle (Welcome, AgentAudioDone,
        // …) rather than dropping it silently — this is what let a
        // Settings-rejection reason vanish before. The high-frequency types in
        // SILENT_DG_MESSAGE_TYPES are the exception: dropped without logging.
        if (msg.type && !SILENT_DG_MESSAGE_TYPES.has(msg.type)) {
          console.log(`[dg] (unhandled) ${msg.type}`);
        }
        break;
    }
  }

  // --- lifecycle -------------------------------------------------------------

  function deriveOutcome(): CallOutcome {
    if (handoffRequested) return "handoff";
    if (fallbackUsed) return "fallback";
    if (errored) return "error";
    return "completed";
  }

  function finalize(outcomeOverride?: CallOutcome): void {
    if (finalized) return;
    finalized = true;

    latency = timer.finish();
    const outcome = outcomeOverride ?? deriveOutcome();
    const record: CallRecord = {
      callId: callUuid,
      agentVersion,
      startedAt,
      endedAt: new Date().toISOString(),
      transcript,
      toolCalls,
      latency,
      fallbackUsed,
      handoffRequested,
      handoffReason,
      outcome,
    };
    writeCallRecord(db, record);
    console.log(`[call] finalize: callId=${callUuid} outcome=${outcome}`);

    if (dg.readyState === WS_OPEN) {
      try {
        dg.close();
      } catch {
        /* already closing */
      }
    }
  }

  function closeVonage(): void {
    if (vonageWs.readyState === WS_OPEN) {
      try {
        vonageWs.close();
      } catch {
        /* already closing */
      }
    }
  }

  // --- Deepgram socket wiring ------------------------------------------------

  dg.on("open", () => {
    dgOpen = true;
    console.log(`[dg] connected — sending Settings (think=${agentSettings.agent.think.provider.model})`);
    sendJson(dg, agentSettings); // Settings MUST be the first message
  });

  dg.on("message", (data: string | Buffer, isBinary?: boolean) => {
    if (isBinaryFrame(data, isBinary)) {
      // Agent audio straight through to Vonage (guard against a racing close).
      if (vonageWs.readyState === WS_OPEN) vonageWs.send(data as Buffer);
      return;
    }
    void handleDeepgramText(data);
  });

  dg.on("error", (err: Error) => {
    errored = true;
    console.error(`[dg] error: ${err?.message ?? err}`);
  });

  // `ws` emits this when the HTTP upgrade returns a non-101 response. It carries
  // the status code, which is the single most useful signal for a failed
  // connect — 401/403 means the DEEPGRAM_API_KEY is missing, wrong, or lacks
  // Voice Agent access.
  dg.on("unexpected-response", (_req: unknown, res: { statusCode?: number; statusMessage?: string }) => {
    errored = true;
    console.error(
      `[dg] upgrade rejected: HTTP ${res?.statusCode ?? "?"} ${res?.statusMessage ?? ""} — ` +
        "check DEEPGRAM_API_KEY and that the key has Voice Agent access",
    );
  });

  dg.on("close", (code?: number, reason?: Buffer) => {
    dgOpen = false;
    const reasonStr = reason?.toString?.() ?? "";
    console.log(`[dg] closed (code=${code ?? "?"}${reasonStr ? ` reason=${reasonStr}` : ""})`);
    // If Deepgram drops, end the call cleanly on the Vonage side too.
    closeVonage();
  });

  // --- Vonage socket wiring --------------------------------------------------

  vonageWs.on("message", (data: string | Buffer, isBinary?: boolean) => {
    if (isBinaryFrame(data, isBinary)) {
      if (dgOpen) dg.send(data as Buffer); // caller audio to Deepgram
      return;
    }
    // Vonage control frames (websocket:connected / websocket:cleared) — nothing
    // to enforce here; they exist for logging/debugging.
  });

  // Without this, a Vonage socket error is an unhandled 'error' event, which
  // Node throws — crashing the process mid-call. Log it and let the call finalize.
  vonageWs.on("error", (err: Error) => {
    errored = true;
    console.error(`[vonage] socket error: ${err?.message ?? err}`);
  });

  vonageWs.on("close", () => {
    finalize();
  });

  return { finalize };
}

/** Real Deepgram connector used in production (tests inject a fake instead). */
function defaultDeepgramConnector(): WsLike {
  const key = process.env.DEEPGRAM_API_KEY ?? "";
  return new WebSocket(DEEPGRAM_AGENT_URL, {
    headers: { Authorization: `token ${key}` },
  }) as unknown as WsLike;
}
