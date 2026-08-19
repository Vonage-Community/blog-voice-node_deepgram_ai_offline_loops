# AGENTS.md

## What this project is

A tutorial repo demonstrating a **bounded order-status voice agent** built on Vonage Voice API and Deepgram Voice Agent: a live call path with one approved tool, strict timeouts, tested fallbacks, and structured evidence capture — designed to be extended by Part 2, which adds offline agent loops.

This is Part 1 of a two-part Vonage Developer Relations series:

* **Part 1 (this repo):** Build the bounded live workflow
* **Part 2:** Build offline agent loops that read the call evidence stored here

This tutorial builds directly on top of the existing Vonage guide for connecting Vonage Voice API to Deepgram. That guide is a prerequisite, not a starting point. The unique value here is architecture: constraints, tool policy, fallbacks, latency instrumentation, and a stored call record that feeds Part 2.

```
.
├── AGENTS.md
├── CLAUDE.md             # one-line @AGENTS.md import — edit AGENTS.md, not CLAUDE.md
├── src/
│   ├── server.ts
│   ├── voice/
│   │   ├── answer-webhook.ts
│   │   ├── event-webhook.ts
│   │   ├── websocket-handler.ts
│   │   └── audio-pipeline.ts
│   ├── agent/
│   │   ├── agent-config.ts
│   │   ├── tool-policy.ts
│   │   └── fallback-responses.ts
│   ├── tools/
│   │   └── order-status.ts
│   └── storage/
│       ├── db.ts
│       └── call-records.ts
├── tasks/
│   ├── todo.md
│   └── archive/
├── tests/
│   └── order-status.test.ts
├── .env.example
└── README.md
```

This is a **public** tutorial repo for Vonage Developer Relations. Code clarity and comments matter as much as correctness — write it the way you would want a developer reading it for the first time to understand not just what the code does, but *why the boundary exists*.

> **Note on this file:** Claude Code reads `CLAUDE.md` natively. `CLAUDE.md` in this repo is a one-line `@AGENTS.md` import so both stay in sync — always edit `AGENTS.md`.

---

## The Live-Path Contract — do not change without discussion

This is the architectural core of the tutorial. Every implementation decision flows from it. If something here looks wrong mid-task, raise it explicitly before changing it — the constraints are intentional teaching points.

| Constraint         | Value                                     |
| ------------------ | ----------------------------------------- |
| Use case           | Order status only                         |
| Allowed tool calls | 1 (`getOrderStatus`)                      |
| Retry limit        | 1, temporary transport failures only      |
| No retries for     | `not_found`, invalid order ID             |
| Total tool timeout | 1500ms                                    |
| Fallback           | Predefined string, always available       |
| Out-of-scope       | Handoff response immediately, no attempt  |
| Write operations   | None                                      |
| Stored evidence    | Transcript, tool result, timing, outcome  |

---

## Vonage + Deepgram facts — don't relitigate these

Settled against current docs. If something looks wrong mid-task, check developer.vonage.com or the Vonage Docs MCP before changing approach — do not silently "fix" from memory.

* **Vonage application setup:** needs Voice capability enabled in the dashboard with answer and event webhook URLs pointing at the ngrok tunnel (or deployed URL). The answer webhook returns an NCCO with a `connect` action to the WebSocket endpoint.
* **WebSocket audio format:** Vonage sends and expects linear16 PCM audio at 8000 Hz. The `content-type` header on the WebSocket endpoint must be `audio/l16;rate=8000`. Deepgram Voice Agent must be configured to match: `input.encoding: "linear16"`, `input.sample_rate: 8000`, `output.encoding: "linear16"`, `output.sample_rate: 8000`, `output.container: "none"`.
* **Barge-in (clear buffer):** when Deepgram emits a `UserStartedSpeaking` event, send `{"action": "clear"}` to the Vonage WebSocket. Vonage confirms with a `websocket:cleared` event. Do not attempt manual audio buffer management — Vonage handles internal buffering automatically.
* **Deepgram Voice Agent settings object:** must be sent as the first message after the Deepgram WebSocket opens. Shape: `{ type: "Settings", audio: {...}, agent: { listen, think, speak } }`. The `think.prompt` field is where the system prompt lives.
* **Function calling via Deepgram Voice Agent:** tool calls from the LLM arrive as JSON messages with `type: "FunctionCallRequest"`. The app must handle these, execute the tool against the policy, and return a `FunctionCallResponse` message. Do not let the LLM call tools that are not registered in the Deepgram settings.
* **Secrets:** `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_APP_ID`, `DEEPGRAM_API_KEY`, and the private key file path live in `.env` (see `.env.example`), never committed. `.gitignore` must exclude `.env`, `*.key`, and `*.pem` before those files are ever created — set this up in the very first task.
* **ngrok note:** `req.hostname` in Express may return `localhost` behind an ngrok tunnel. Build the WebSocket URI and event URL from a `BASE_URL` environment variable, not from `req.hostname`, to avoid webhook failures during local development.
* **Deepgram Voice Agent endpoint:** `wss://agent.deepgram.com/v1/agent/converse` — auth via `Authorization: token <DEEPGRAM_API_KEY>` header on the WebSocket upgrade.

---

## System prompt — use this exactly, do not generalize it

```
You are an order-status voice agent for a live phone call.

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
"That's something our support team handles directly. Let me connect you now."
```

> **Note:** the handoff response is now truthful — an out-of-scope request triggers a **real** Vonage call transfer to `SUPPORT_PHONE_NUMBER` (`src/voice/transfer-to-human.ts`). The transfer NCCO speaks the transition line, so the promise and the action are the same event. The fallback (tool failure) does **not** transfer and must not promise actions the system can't perform (no SMS/email/callback).

---

## The call record schema — every field exists for Part 2

Every call must write this to SQLite before the connection closes. Do not drop or rename fields — Part 2 will read them directly.

```json
{
  "callId": "string (Vonage call UUID)",
  "agentVersion": "string (e.g. \"order-status-v1\")",
  "startedAt": "ISO8601",
  "endedAt": "ISO8601",
  "transcript": [
    { "speaker": "caller | agent", "text": "string", "timestampMs": "number" }
  ],
  "toolCalls": [
    {
      "tool": "getOrderStatus",
      "args": { "orderId": "string" },
      "durationMs": "number",
      "result": "OrderResult | \"timeout\"",
      "success": "boolean"
    }
  ],
  "latency": {
    "speechToTextMs": "number",
    "modelMs": "number",
    "toolMs": "number",
    "textToSpeechMs": "number",
    "totalTurnMs": "number"
  },
  "fallbackUsed": "boolean",
  "handoffRequested": "boolean",
  "handoffReason": "\"billing\" | \"returns\" | \"cancellation\" | \"account\" | \"unsupported\" | null",
  "outcome": "\"completed\" | \"fallback\" | \"handoff\" | \"error\""
}
```

---

## Workflow

* Plan first. Write a checklist to `tasks/todo.md` before coding.
* Start every `tasks/todo.md` with the exact prompt that produced it, verbatim — what was actually typed, not a summary — before the checklist itself (template below). That block travels with the file into `tasks/archive/` when the plan is done; never strip it during cleanup.
* **Before archiving a completed `tasks/todo.md`**, add a "Blog-worthy notes" section documenting any non-obvious technical decisions, trade-offs, or gotchas discovered during implementation. These notes feed the tutorial write-up. Include: why a choice was made over alternatives, surprising behavior encountered, and patterns that might help a reader doing similar work.
* One task per prompt. One concern per diff.
* Read relevant files before editing.
* Keep diffs small and reviewable.
* Prefer files under 300 lines. If a file grows past 300 lines, consider splitting by responsibility — but do not split cohesive code just to satisfy line count.

**`tasks/todo.md` template:**

```markdown
## Prompt

<verbatim prompt text — exactly what was typed, not a summary>

## Checklist

- [ ] ...
```

---

## Testing

* No behavior change without a test.
* Add or update tests for every feature, bug fix, tool policy change, and state transition.
* Run the relevant test first when fixing a bug, then make it pass.

Project-specific defaults:

* `src/tools/order-status.ts`: unit tests must cover `in_transit`, `delivered`, `not_found`, the 1500ms timeout (use fake timers), and the retry-on-transport-failure path. Never call an external API from tests.
* `src/agent/tool-policy.ts`: test that the policy correctly allows one call, blocks a second call, allows one retry on transport failure, and does not retry on `not_found`.
* `src/storage/call-records.ts`: test write and read against an in-memory SQLite database. Every field in the call record schema must be covered.
* Do not test the WebSocket plumbing directly — that is integration territory. Keep unit tests focused on policy, tool behavior, and storage.

---

## Done means

* Plan completed and checked off.
* Tests added or updated for all behavior changes.
* All failure modes manually verified, with the correct outcome recorded for each — Part 2's regression tests query `fallbackUsed` and `outcome` directly, so a `not_found` call showing up as `outcome: "fallback"` in the transcript-review loop would be a false signal:
  * `not_found` returns a speakable result via `FunctionCallResponse` (`outcome: "completed"`, `fallbackUsed: false`) — the tool ran and answered; the model narrates it. It is **not** a fallback.
  * `timeout` and `transport_error` trigger the deterministic fallback (`outcome: "fallback"`, `fallbackUsed: true`) — the tool failed to run. `transport_error` retries once first; `timeout` never retries.
  * Out-of-scope request triggers the handoff (`outcome: "handoff"`, `handoffRequested: true`), tool never called.
* Call record is written to SQLite for every call outcome, including error and handoff cases.
* Latency fields are populated with real measurements, not zeros or placeholders.
* Completed plan moved from `tasks/todo.md` to `tasks/archive/` and renamed with an **execution datetime stamp + feature name**: `YYYY-MM-DDThhmm-<feature>.md` (local time, 24-hour, e.g. `2026-07-27T2100-handoff-detection-and-logs.md`). The datetime prefix is required so archived plans sort chronologically and the execution order is unambiguous — a date alone is not enough when several plans land the same day.

---

## Commands

```bash
# Install dependencies
npm install

# Run in development (with hot reload)
npm run dev

# Run tests
npm test

# Expose local server for Vonage webhooks
ngrok http 3000
# Then update BASE_URL in .env with the ngrok HTTPS URL
```

---

## Out of scope — do not build

* No outbound calling (Part 1 is inbound only)
* No ElevenLabs, Pipecat, or additional providers — Deepgram handles ASR and TTS
* No real order database — the mock in `order-status.ts` is intentional
* No production rate limiting or abuse protection — leave a `// TODO` comment
* No offline loops, evaluation workers, or transcript review — that is Part 2
* No open-ended general assistant behavior — the constrained prompt is the point
* No Android or iOS client — this is a server-side tutorial
