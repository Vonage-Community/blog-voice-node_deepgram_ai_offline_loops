# Bounded Order-Status Voice Agent

A companion repo for the Vonage developer-blog tutorial **"Build a Bounded Order-Status Voice Agent With Vonage and Deepgram."**

This application takes the basic, open-ended voice bot from the prerequisite guide and turns it into a **bounded business workflow**: one approved tool, a strict timeout-and-retry policy, deterministic fallbacks for every failure mode, an out-of-scope handoff, per-stage latency instrumentation, and a structured **call record** written to SQLite after every call. A future blog will build offline agent loops that read those call records.

> This tutorial builds directly on top of [How to Build an AI Voice Agent with Vonage Voice API and Deepgram](https://developer.vonage.com/en/voice/voice-api/guides/voice-ai-agent-deepgram). That guide covers creating the Vonage application, wiring answer/event webhooks, bridging the call to a WebSocket, and forwarding audio to Deepgram for ASR, LLM orchestration, and TTS. We don't reproduce it — we add the architecture layer on top.

The server runs on Node.js 20+ / TypeScript, backed by Deepgram's Voice Agent API (`nova-3` ASR, Anthropic Claude via Deepgram's managed `think`, Aura-2 TTS) and the Vonage Voice API for the live phone call. Call records are stored in SQLite via `better-sqlite3`.

---

## The Live-Path Contract

This table is the architectural core of the tutorial. Every implementation decision flows from it, and it is enforced in code (in `src/agent/tool-policy.ts` and `src/voice/websocket-handler.ts`), not just requested in the prompt.

| Constraint          | Value                                     |
| ------------------- | ----------------------------------------- |
| Use case            | Order status only                         |
| Allowed tool calls  | 1 (`getOrderStatus`) **per call**         |
| Retry limit         | 1, temporary transport failures only      |
| No retries for      | `not_found`, invalid order ID, timeout    |
| Total tool timeout  | 1500 ms                                    |
| Fallback            | Predefined string, always available       |
| Out-of-scope        | Handoff response immediately, no attempt  |
| Write operations    | None                                      |
| Stored evidence     | Transcript, tool result, timing, outcome  |

The narrow system prompt, the exact fallback/handoff strings, and the call-record schema are pinned in [`AGENTS.md`](AGENTS.md) — the spec for this repo.

---

## Repo Structure

```
.
├── AGENTS.md               # The spec: contract, system prompt, schema, workflow
├── CLAUDE.md               # One-line @AGENTS.md import (edit AGENTS.md, not this)
├── src/
│   ├── server.ts           # Express app: /answer, /event, ws /socket, /health
│   ├── voice/
│   │   ├── answer-webhook.ts    # Returns the NCCO (connect → WebSocket)
│   │   ├── event-webhook.ts     # Vonage call lifecycle events + onCallEnded hook
│   │   ├── websocket-handler.ts # Vonage ↔ Deepgram bridge + contract enforcement
│   │   └── audio-pipeline.ts    # Per-turn latency instrumentation
│   ├── agent/
│   │   ├── agent-config.ts      # Deepgram Voice Agent Settings + system prompt
│   │   ├── tool-policy.ts       # Allowlist, timeout, retry rules (enforced)
│   │   └── fallback-responses.ts# Greeting, fallback, handoff — fixed strings
│   ├── tools/
│   │   └── order-status.ts      # getOrderStatus mock + 1500ms timeout wrapper
│   └── storage/
│       ├── db.ts                # SQLite setup + call_records schema
│       └── call-records.ts      # writeCallRecord / readCallRecord
├── tests/                  # Vitest unit tests (policy, tool, storage, bridge)
├── docs/
│   └── live-call-checklist.md   # Pre-flight + the three test calls
├── tasks/                  # Planning notes (todo.md → archive/)
└── .env.example
```

---

## Prerequisites

- **Node.js 20+** (built and tested on Node 24)
- **A [Vonage account](https://ui.idp.vonage.com/ui/auth/registration)** with a Voice application and a linked phone number
- **A [Deepgram account](https://console.deepgram.com/) with billing enabled** — the Voice Agent API is a paid product. A brand-new account with no credit returns **HTTP 402** on connect (see Troubleshooting)
- **[ngrok](https://ngrok.com)** to expose your local server to Vonage webhooks

You should have completed the [prerequisite Vonage + Deepgram guide](https://developer.vonage.com/en/voice/voice-api/guides/voice-ai-agent-deepgram) first.

---

## Quick Start

### Step 1: Create a Vonage Voice application and link a number

1. Go to [dashboard.nexmo.com → Applications](https://dashboard.nexmo.com/applications) → **Create a new application**.
2. Enable the **Voice** capability. Set the webhooks (you'll paste the real ngrok URL in Step 4):
   - **Answer URL** → `https://<ngrok>/answer`, method **GET**
   - **Event URL** → `https://<ngrok>/event`, method **POST**
3. **Generate the public/private key**, download it, and save it as `vonage_private.key` in the project root (it's gitignored). The running server doesn't sign anything itself, but this is standard setup and Part 2 will use it.
4. **Buy a number** and **link it to this application**. This is the number you'll dial.

### Step 2: Configure `.env`

```bash
cp .env.example .env
```

The server process reads these:

```env
DEEPGRAM_API_KEY=dg_your_key_here     # required
PORT=3000
BASE_URL=                             # set in Step 4 (the ngrok HTTPS URL)
DB_PATH=./calls.db
# Optional model overrides (blank = defaults in agent-config.ts):
# DEEPGRAM_LISTEN_MODEL=
# DEEPGRAM_THINK_MODEL=
# DEEPGRAM_SPEAK_MODEL=
```

The `VONAGE_*` values in `.env.example` are there for completeness and the prerequisite guide — **the inbound call path is routed by the Vonage dashboard (application + linked number + webhooks), so the server itself only needs `DEEPGRAM_API_KEY` and `BASE_URL`.**

```bash
npm install
```

### Step 3: Start ngrok

ngrok's free URL rotates every restart, so start it **first**:

```bash
ngrok http 3000
```

Copy the `https://…ngrok-free.app` forwarding URL.

### Step 4: Point everything at the ngrok URL

- Put it in `.env`: `BASE_URL=https://<your-ngrok>.ngrok-free.app`
- Update the Vonage application's **Answer** (`…/answer`) and **Event** (`…/event`) URLs to the same host.

### Step 5: Run the server

```bash
npm run dev      # tsx watch, hot reload
```

You should see `Order-status voice agent listening on :3000`. Sanity-check the answer webhook before dialing (quote the URL — the `&` matters):

```bash
curl "https://<your-ngrok>.ngrok-free.app/answer?uuid=test123&from=15551234567"
```

Expect an NCCO whose `connect` endpoint is `wss://<your-ngrok>/socket?callUuid=…` with `"content-type":"audio/l16;rate=8000"`.

### Step 6: Call your Vonage number

You'll hear the Vonage "please hold" greeting, then the agent's own greeting, then it's listening. See [`docs/live-call-checklist.md`](docs/live-call-checklist.md) for the full pre-flight and the three test calls.

---

## Testing

### Unit tests

```bash
npm test          # vitest run (81 tests)
npm run typecheck # tsc --noEmit
```

Tests cover the tool behavior (`in_transit`, `delivered`, `not_found`, the 1500ms timeout via fake timers, the transport-retry path), the tool policy (one call, second call blocked, one retry on transport failure only, no retry on `not_found`/timeout), the storage round-trip against in-memory SQLite, and the WebSocket bridge with **both** sockets mocked (success, timeout→fallback, out-of-scope→handoff, `not_found`, barge-in, greeting, Deepgram connect/Settings errors). Tests never hit a real network.

### The three test calls (one per call — see below)

| Call | Say | Expected | Record (`snake_case` columns) |
| --- | --- | --- | --- |
| 1 | "Where is order A1001?" | Agent reads back the delivery status | `outcome=completed`, `fallback_used=0`, `tool_calls[0].success=true` |
| 2 | "Where is order S‑L‑O‑W nine nine nine?" | Fallback within ~1.5s of the lookup | `outcome=fallback`, `fallback_used=1`, `tool_calls[0].result="timeout"` |
| 3 | "I want to dispute a charge" | Handoff, immediately, tool never called | `outcome=handoff`, `handoff_requested=1`, `tool_calls=[]` |

> **Make each of these a separate call.** The contract allows **one** `getOrderStatus` per call, so a second lookup in the same call is deterministically **blocked → fallback** (working as designed, but it isn't the timeout you meant to test). Also enunciate `SLOW` — the ASR needs to actually produce the `SLOW` prefix that the mock keys off.

### Inspect a call record

The SQLite **columns are `snake_case`** (the camelCase names in the schema are the TypeScript/JSON field names):

```bash
sqlite3 calls.db \
  "SELECT call_id, outcome, fallback_used, handoff_requested
   FROM call_records ORDER BY started_at DESC LIMIT 3;"

# tool_calls is a JSON column — drill in with json_extract:
sqlite3 calls.db \
  "SELECT json_extract(tool_calls, '\$[0].result') FROM call_records WHERE call_id='<uuid>';"
```

---

## How It Works

### The call flow

1. **`GET /answer`** returns an NCCO: a short "please hold" `talk`, then a `connect` to `wss://<base>/socket` with `content-type: audio/l16;rate=8000`. The call UUID rides on the query string so the socket handler can key the call record.
2. **`ws /socket`** opens a second WebSocket to Deepgram (`wss://agent.deepgram.com/v1/agent/converse`), sends the `Settings` message, and bridges audio: caller audio (Vonage binary → Deepgram) and agent audio (Deepgram binary → Vonage), verbatim, both linear16/8000. On Deepgram's `UserStartedSpeaking`, it sends `{"action":"clear"}` to Vonage for barge-in.
3. **On `SettingsApplied`**, the agent speaks a fixed **greeting** so the caller knows it's listening.
4. **On `FunctionCallRequest`**, the tool policy runs the show (see below), then a `FunctionCallResponse` goes back to Deepgram.
5. **`POST /event`** logs Vonage lifecycle events; a terminal status finalizes the call record via `onCallEnded`. Whichever ends first — the socket closing or the event webhook — routes through one idempotent `finalize()`.

### The tool policy (the enforcement)

When a `FunctionCallRequest` arrives, `websocket-handler.ts` decides — the model only *asks*:

1. **Out-of-scope backstop** — if the caller's last utterance is out of scope, set `handoffRequested` and do **not** call the tool. (The model usually hands off on its own from the system prompt; this also catches a misbehaving model.)
2. **Authorize the call** — allowlist + the one-call budget. A blocked call → fallback.
3. **Run under a 1500ms deadline.** A `transport_error` is retried **once**; a `timeout` is **never** retried.
4. **React by outcome:**
   - `in_transit` / `delivered` → returned to the model to read back (`outcome=completed`).
   - `not_found` → returned to the model with a narration hint (`outcome=completed`, **not** a fallback — the tool ran and answered).
   - `timeout` / `transport_error` (after retry) → deterministic **fallback** injected (`outcome=fallback`).

### Deterministic strings

The greeting, fallback, and handoff live in `fallback-responses.ts` as fixed constants and are spoken via Deepgram's `InjectAgentMessage` — never model-generated. When something fails, the caller hears reviewed words every time.

### The call record (the bridge to Part 2)

Every call writes one row to `call_records` before the connection closes — transcript, the tool call, per-stage latency (real measurements), `fallback_used`, `handoff_requested`, and `outcome`. Scalar fields Part 2 will filter on are real columns (with `CHECK` constraints); nested parts are JSON. The full schema is in [`AGENTS.md`](AGENTS.md).

---

## A Known Limitation (On Purpose)

Run all three scenarios and you may hear something like:

> **Agent:** "Perfect, we'll send you a follow-up message about order SL0999."

**Part 1 never sends that message.** After the fallback offers to "connect you to support or send you a follow-up message," the model confidently *narrates* completing an action the read-only system doesn't implement — inventing specifics along the way. This is left in intentionally: it's the clearest possible demonstration of the exact risk a bounded architecture exists to contain. **The model will confidently describe actions the system never performed if you leave the door open.**

Fixing it by wiring real SMS/transfer would violate the read-only contract and bloat Part 1; fixing it with a prompt patch would hide the lesson. So the fallback string is illustrative — a production deployment wires "send a follow-up message" to the [Vonage Messages API](https://developer.vonage.com/en/messages/overview) and "connect to support" to a call transfer. The live path stays read-only until Part 2's regression loop can verify that write operations don't break existing behavior. This is the setup for the series' read-before-write section.

---

## Architecture

- **Express + express-ws** — `/answer` (NCCO), `/event` (lifecycle), `ws /socket` (audio bridge), `/health`.
- **Two WebSockets, one bridge** — the Vonage socket (via `express-ws`, `ws@7`) and the Deepgram socket (`ws@8`) have **different message semantics**; `isBinaryFrame()` normalizes them so audio forwards correctly on both (see Troubleshooting).
- **Deepgram Voice Agent** — a single `Settings` message configures linear16/8000 audio, `nova-3` listen, Anthropic `claude-sonnet-4-5` think (Deepgram-managed, no separate key), and `aura-2-thalia-en` speak, with exactly one registered function, `getOrderStatus`, declared **client-side** so the app executes it under policy.
- **Injectable everything** — the call session takes the Vonage socket, a Deepgram connector, the DB handle, and a clock, so the whole bridge is unit-testable without a network.
- **SQLite via better-sqlite3** — synchronous, file-backed (or `:memory:` in tests), WAL mode so Part 2 can read while a call writes.

---


## License

MIT

---

## Related

- [How to Build an AI Voice Agent with Vonage Voice API and Deepgram](https://developer.vonage.com/en/voice/voice-api/guides/voice-ai-agent-deepgram) — the prerequisite guide
- [Vonage Voice API / NCCO reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference)
- [Deepgram Voice Agent API](https://developers.deepgram.com/docs/voice-agent)
- [Blog Post](https://developer.vonage.com/en/blog/) *(link to be added when published)*
