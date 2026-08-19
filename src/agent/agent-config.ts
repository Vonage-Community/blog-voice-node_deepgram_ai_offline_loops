// -----------------------------------------------------------------------------
// Deepgram Voice Agent configuration — the constrained version of the settings
// object from the prerequisite guide.
//
// This is the first message the app sends after the Deepgram WebSocket opens
// (AGENTS.md). Two things make it "bounded" rather than the generic assistant
// the prerequisite guide builds:
//
//   1. `think.prompt` is the narrow order-status system prompt, verbatim.
//   2. `think.functions` registers exactly one function — getOrderStatus. The
//      model literally cannot ask us to run anything else, because nothing else
//      is declared. (The tool policy in tool-policy.ts is the second line of
//      defense at execution time.)
//
// The function is declared *client-side*: we give it a name, description, and
// parameter schema, but no endpoint. Deepgram therefore emits a
// `FunctionCallRequest` to our app and waits for a `FunctionCallResponse`
// instead of calling an HTTP endpoint itself. That is what lets us enforce the
// timeout, retry, and fallback policy around the call.
//
// Audio format is pinned to linear16 / 8000 Hz on both sides to match the
// Vonage WebSocket stream (`audio/l16;rate=8000`). Do not change these without
// re-reading the Vonage + Deepgram facts in AGENTS.md.
// -----------------------------------------------------------------------------

import { ALLOWED_TOOLS } from "./tool-policy.js";

/** Sample rate Vonage sends/expects on the WebSocket. Must match the NCCO content-type. */
export const AUDIO_SAMPLE_RATE = 8000;

/**
 * The system prompt, exactly as fixed in AGENTS.md. Do not paraphrase or
 * "improve" it — the wording is a teaching artifact and the fallback/handoff
 * strings inside it must match fallback-responses.ts.
 */
export const SYSTEM_PROMPT = `You are an order-status voice agent for a live phone call.

You may ONLY help the caller check the status of an order.

Rules:
- Ask for the caller's order number if they have not provided it.
- Call getOrderStatus exactly once with the order number.
- You can look up only one order per call. If the lookup fails or the order is not found, do not offer to look it up again on this call.
- If the result is clear, read it back in one or two natural spoken sentences.
- If the lookup fails or times out, use the fallback response. Do not retry.
- If the caller asks about billing, returns, disputes, or anything else, use the handoff response immediately.
- Do not answer general questions. Do not make up information. Do not promise to send texts, emails, or callbacks — you cannot.

Fallback response:
"I'm having trouble retrieving that order right now. Please try again later, or contact our support team and they can help."

Handoff response:
"That's something our support team handles directly. Let me connect you now."`;

/** A Deepgram provider selection (ASR, LLM, or TTS). */
export interface DeepgramProvider {
  type: string;
  model: string;
}

/** A client-side function declaration (no endpoint ⇒ the app executes it). */
export interface DeepgramFunction {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The full Settings message sent to `wss://agent.deepgram.com/v1/agent/converse`. */
export interface DeepgramAgentSettings {
  type: "Settings";
  audio: {
    input: { encoding: "linear16"; sample_rate: number };
    output: { encoding: "linear16"; sample_rate: number; container: "none" };
  };
  agent: {
    language: string;
    listen: { provider: DeepgramProvider };
    think: {
      provider: DeepgramProvider;
      prompt: string;
      functions: DeepgramFunction[];
    };
    speak: { provider: DeepgramProvider };
  };
}

/**
 * The single approved function, wired to the tool allowlist so its name can
 * never drift from what the policy authorizes. If ALLOWED_TOOLS ever lists more
 * than one tool, this file will fail to compile the destructure below — a
 * deliberate tripwire, since the contract permits exactly one.
 */
const [ONLY_TOOL] = ALLOWED_TOOLS;

const GET_ORDER_STATUS_FUNCTION: DeepgramFunction = {
  name: ONLY_TOOL,
  description:
    "Look up the current shipping status of a single order by its order number. " +
    "Call this exactly once, and only after the caller has given you an order number.",
  parameters: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description: 'The caller\'s order number, for example "A1001".',
      },
    },
    required: ["orderId"],
  },
};

/** Overridable model choices. Defaults match the tutorial's stated stack. */
export interface AgentConfigOptions {
  /** ASR model. */
  listenModel: string;
  /** LLM provider type + model for the `think` stage. */
  thinkProvider: DeepgramProvider;
  /** Aura TTS model. */
  speakModel: string;
  /** BCP-47 language tag. */
  language: string;
}

export const DEFAULT_AGENT_CONFIG: AgentConfigOptions = {
  listenModel: "nova-3",
  // Anthropic Claude via Deepgram's managed `think` config (no separate API key
  // needed). Use a *current* model string — Deepgram rejects the whole Settings
  // payload and closes the socket if the model is deprecated/unknown. See
  // Deepgram's supported Voice Agent LLM models; override with DEEPGRAM_THINK_MODEL.
  thinkProvider: { type: "anthropic", model: "claude-sonnet-4-5" },
  speakModel: "aura-2-thalia-en",
  language: "en",
};

/**
 * Build the Deepgram Voice Agent Settings message. Pass overrides to swap
 * models (e.g. from environment variables) without touching the bounded parts —
 * the prompt, the audio format, and the single registered function are fixed.
 */
export function createAgentConfig(
  overrides: Partial<AgentConfigOptions> = {},
): DeepgramAgentSettings {
  const { listenModel, thinkProvider, speakModel, language } = {
    ...DEFAULT_AGENT_CONFIG,
    ...overrides,
  };

  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: AUDIO_SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: AUDIO_SAMPLE_RATE, container: "none" },
    },
    agent: {
      language,
      listen: { provider: { type: "deepgram", model: listenModel } },
      think: {
        provider: thinkProvider,
        prompt: SYSTEM_PROMPT,
        functions: [GET_ORDER_STATUS_FUNCTION],
      },
      speak: { provider: { type: "deepgram", model: speakModel } },
    },
  };
}
