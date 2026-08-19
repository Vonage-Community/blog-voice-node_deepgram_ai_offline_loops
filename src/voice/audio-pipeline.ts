// -----------------------------------------------------------------------------
// Latency instrumentation — nothing else. No sockets, no audio bytes.
//
// A "turn" is one caller-speaks → agent-responds cycle. The WebSocket handler
// drives this timer from the Deepgram events it already receives:
//
//   begin()                on UserStartedSpeaking / first caller audio of a turn
//   mark("speechToText")   when the caller's transcript arrives (ConversationText/user)
//   mark("model")          when the model commits to a tool call (FunctionCallRequest)
//   set("tool", ms)        from lookupOrderStatus's own measured durationMs
//   mark("textToSpeech")   when the agent's spoken reply arrives (ConversationText/assistant)
//   finish()               -> LatencyBreakdown for the call record
//
// `mark(stage)` measures wall-clock since the previous mark; `set(stage, ms)`
// records a duration measured elsewhere (the tool already times itself, so we
// use its exact number rather than re-deriving it). The clock is injectable so
// tests are deterministic.
// -----------------------------------------------------------------------------

import type { LatencyBreakdown } from "../storage/db.js";

export type LatencyStage = "speechToText" | "model" | "tool" | "textToSpeech";

export interface TurnTimer {
  /** Start (or restart) the turn clock. Resets all stage durations to 0. */
  begin(): void;
  /** Record the elapsed time since the previous mark as this stage's duration. Returns the ms. */
  mark(stage: LatencyStage): number;
  /** Set a stage duration from a measurement taken elsewhere (e.g. the tool). */
  set(stage: LatencyStage, ms: number): void;
  /** Produce the breakdown for this turn, including totalTurnMs since begin(). */
  finish(): LatencyBreakdown;
}

const defaultNow = (): number => performance.now();

function zeroed(): Record<LatencyStage, number> {
  return { speechToText: 0, model: 0, tool: 0, textToSpeech: 0 };
}

/**
 * Create a turn timer. Pass a custom `now()` (returning monotonically
 * increasing milliseconds) to make timing deterministic in tests.
 */
export function createTurnTimer(now: () => number = defaultNow): TurnTimer {
  let turnStart: number | null = null;
  let lastMark = 0;
  let durations = zeroed();

  // If a mark/finish happens before begin(), anchor the turn at that moment so
  // we never divide against a null start.
  function ensureStarted(): void {
    if (turnStart === null) {
      turnStart = now();
      lastMark = turnStart;
    }
  }

  return {
    begin(): void {
      turnStart = now();
      lastMark = turnStart;
      durations = zeroed();
    },

    mark(stage: LatencyStage): number {
      ensureStarted();
      const t = now();
      const elapsed = t - lastMark;
      durations[stage] = elapsed;
      lastMark = t;
      return elapsed;
    },

    set(stage: LatencyStage, ms: number): void {
      durations[stage] = ms;
    },

    finish(): LatencyBreakdown {
      ensureStarted();
      return {
        speechToTextMs: durations.speechToText,
        modelMs: durations.model,
        toolMs: durations.tool,
        textToSpeechMs: durations.textToSpeech,
        totalTurnMs: now() - (turnStart as number),
      };
    },
  };
}
