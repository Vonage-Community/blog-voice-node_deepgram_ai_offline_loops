# Live Phone Call Test — Pre-Flight Checklist

The architecture is locked and internally consistent, with the full test suite green.
This is the moment where all of that meets a real caller.

## Pre-Flight Checklist

Run through these in order before you dial in.

### 1. Credentials in `.env`

```bash
VONAGE_API_KEY=
VONAGE_API_SECRET=
VONAGE_APP_ID=
VONAGE_PRIVATE_KEY_PATH=./vonage_private.key   # must match your actual key file
DEEPGRAM_API_KEY=
BASE_URL=https://your-ngrok-url.ngrok.io       # ← the one that bites everyone
PORT=3000
DB_PATH=./calls.db
```

`BASE_URL` is the one most likely to be wrong. It must be the full ngrok `https://`
URL, never `localhost`. `answer-webhook.ts` uses it to build **both** the `eventUrl`
and the `wss://` socket URI — if it's wrong the WebSocket never opens and you'll hear
silence after the greeting. (If `BASE_URL` is unset entirely, `GET /answer` returns a
**500 JSON error** rather than an NCCO — a fast way to catch it.)

### 2. Start in the right order

```bash
# Terminal 1 — ngrok first, then copy the URL into .env BEFORE starting the server
ngrok http 3000

# Terminal 2
npm run dev
```

### 3. Verify the answer webhook before calling

Quote the URL — an unquoted `&` backgrounds the command and splits the query string:

```bash
curl "https://your-ngrok-url.ngrok.io/answer?uuid=test123&from=15551234567"
```

You should get a valid NCCO whose `connect` action has a `wss://…/socket?callUuid=…`
endpoint with `"content-type": "audio/l16;rate=8000"`. If the URI says `localhost`,
`BASE_URL` is wrong. If you get a `500 {"error":"BASE_URL is not set"}`, it's unset.

## The Three Test Calls (in order)

| Call | What to say | What should happen | What to check in the record |
| --- | --- | --- | --- |
| 1 | "Where is order A1001?" | Agent reads back a delivery status naturally | `outcome: "completed"`, `fallback_used: 0`, `tool_calls[0].success: true` |
| 2 | "Where is order SLOW999?" | Fallback response ~1.5s after the lookup starts | `outcome: "fallback"`, `fallback_used: 1`, `tool_calls[0].result: "timeout"` |
| 3 | "I want to dispute a charge" | Handoff response immediately, tool never called | `outcome: "handoff"`, `handoff_requested: 1`, `tool_calls: []` |

Notes:
- **Call 2** uses `SLOW999` — the mock delays any id starting with `SLOW` by 2000ms,
  which exceeds the 1500ms deadline, so the lookup times out and the fallback fires.
  A timeout is never retried.
- **Call 3** now records the handoff even though the model speaks the handoff line on
  its own without calling the tool: the handler runs `isOutOfScope()` on the caller's
  transcript and sets `handoff_requested`. That's why `tool_calls` is empty **and**
  `outcome` is `"handoff"`.

### Inspect the records after each call

The SQLite **columns are snake_case** (the camelCase names are the TypeScript/JSON
field names, not the DB columns):

```bash
sqlite3 calls.db \
  "SELECT call_id, outcome, fallback_used, handoff_requested
   FROM call_records ORDER BY started_at DESC LIMIT 3;"
```

`tool_calls` is a JSON column, so drill into it with `json_extract`. For call 2:

```bash
sqlite3 calls.db \
  "SELECT json_extract(tool_calls, '\$[0].result') AS tool_result
   FROM call_records WHERE call_id = '<call-2-uuid>';"
# -> "timeout"
```

## What Good Looks Like in the Logs

These are the actual log lines the server prints (from `server.ts` and
`websocket-handler.ts`) — watch for this sequence on a successful call 1:

```
[socket] Vonage connected: <callUuid>
[dg] ConversationText caller: "Where is order A1001?"
[dg] FunctionCallRequest: getOrderStatus { orderId: "A1001" }
[tool] lookupOrderStatus → in_transit in 42ms
[dg] FunctionCallResponse sent: status=in_transit
[dg] ConversationText agent: "Your order is on its way…"
[call] finalize: callId=<callUuid> outcome=completed
[socket] Vonage disconnected: <callUuid>
```

For call 3 (handoff) you'll instead see the caller `ConversationText`, the agent's
handoff line as a `ConversationText`, then `[call] finalize: … outcome=handoff` — and
**no** `[dg] FunctionCallRequest` line, because the tool is never called.

Vonage lifecycle events log separately via `[event] status=… uuid=…` from the event
webhook.

## If Something Goes Wrong

- **Silence after the greeting** — the WebSocket never connected. Check `BASE_URL` and
  the ngrok URL in the Vonage application's answer-webhook setting. Confirm you see
  `[socket] Vonage connected: …`.
- **Agent talks but ignores tool calls** — Deepgram isn't emitting `FunctionCallRequest`
  (no `[dg] FunctionCallRequest` line). Check `agent-config.ts`: the function name in
  `functions` must exactly match what the system prompt tells the agent to call
  (`getOrderStatus`).
- **Call record not written** — `finalize()` didn't run (no `[call] finalize` line).
  Both the Vonage socket close and the event-webhook `onCallEnded` path route through
  the same idempotent `finalize()`; the `Map<callUuid, CallSession>` in `server.ts` is
  the bridge between them.
