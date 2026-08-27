# AGENTS.md

## What this project is

A tutorial repo demonstrating a **bounded order-status voice agent** built on Vonage Voice API and Deepgram Voice Agent: a live call path with one approved tool, strict timeouts, tested fallbacks, and structured evidence capture — plus the offline agent loops that turn that stored evidence into a regression suite.

This is a two-part Vonage Developer Relations series, and both parts live in this repo:

* **Part 1 — `src/`:** Build the bounded live workflow. One call, one tool, one deterministic fallback, and a SQLite call record written before every hang-up.
* **Part 2 — `loops/`:** Build offline agent loops that read that call evidence. A regression evaluation runner and a transcript review loop, both CLI-triggered, neither touching the live voice path.

Part 1 builds directly on top of the existing Vonage guide for connecting Vonage Voice API to Deepgram. That guide is a prerequisite, not a starting point. The unique value here is architecture: constraints, tool policy, fallbacks, latency instrumentation, and a stored call record — and then, in Part 2, the loop that uses it to catch regressions.

```
.
├── AGENTS.md             # this file — governs both parts
├── CLAUDE.md             # one-line @AGENTS.md import — edit AGENTS.md, not CLAUDE.md
├── src/                  # Part 1: the live voice path
│   ├── server.ts
│   ├── voice/
│   │   ├── answer-webhook.ts
│   │   ├── event-webhook.ts
│   │   ├── websocket-handler.ts
│   │   ├── transfer-to-human.ts
│   │   └── audio-pipeline.ts
│   ├── agent/
│   │   ├── agent-config.ts
│   │   ├── agent-version.ts
│   │   ├── tool-policy.ts
│   │   └── fallback-responses.ts
│   ├── tools/
│   │   └── order-status.ts
│   └── storage/
│       ├── db.ts
│       └── call-records.ts
├── loops/                # Part 2: the offline loops — its own npm package
│   ├── eval-cases/
│   │   └── seed-cases.json
│   ├── src/
│   │   ├── db/
│   │   │   ├── eval-schema.ts
│   │   │   └── seed-loader.ts
│   │   ├── runner/       # replay.ts, report.ts
│   │   ├── review/       # pattern-finder.ts, transcript-review.ts
│   │   ├── run-eval.ts   # `npm run eval`
│   │   └── run-review.ts # `npm run review`
│   ├── reports/          # generated eval reports (gitignored)
│   ├── tasks/
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── data/
│   └── calls.db          # shared SQLite: call_records (Part 1) + eval_cases (Part 2)
├── tasks/
│   ├── todo.md
│   └── archive/
├── tests/
├── vitest.config.ts      # excludes loops/** — each part runs its own tests
├── .env.example
└── README.md
```

This is a **public** tutorial repo for Vonage Developer Relations. Code clarity and comments matter as much as correctness — write it the way you would want a developer reading it for the first time to understand not just what the code does, but *why the boundary exists*.

> **Note on this file:** Claude Code reads `CLAUDE.md` natively. `CLAUDE.md` in this repo is a one-line `@AGENTS.md` import so both stay in sync — always edit `AGENTS.md`. There is deliberately **no second AGENTS.md inside `loops/`**: shared rules (workflow, testing, archive naming) would drift between two copies. This file governs both parts.

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

Every call must write this to SQLite before the connection closes. Do not drop or rename fields — `loops/` reads them directly.

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

## Part 2 — `loops/`: the offline agent loops

Two loops that read the call evidence Part 1 stores:

1. **Regression evaluation runner** (`npm run eval`) — replays evaluation cases against the agent's logic and produces a pass/fail report.
2. **Transcript review loop** (`npm run review`) — scans stored call records, finds patterns, and writes proposed evaluation cases that a human must approve before they enter the eval suite.

### The boundary between `loops/` and `src/`

This is the rule that makes Part 2 safe to run at any time, including while a call is in progress:

* `loops/` **imports from** `src/` — the tool policy and tool types it replays live there. Import them; never copy or reimplement them. A duplicated `classifyHandoffReason` would drift from the live one and the eval suite would start passing against a fiction.
* `src/` **never imports from** `loops/`. The live path has no idea the loops exist.
* Neither loop opens a WebSocket, calls Deepgram, calls Vonage, plays audio, or invokes the real `lookupOrderStatus`. They read stored rows and replay logic against injected mock results.
* The only thing the two parts share at runtime is the SQLite file.

Import paths. Count the segments — `loops/src/` is a `src` too, so a file one level deeper than you think resolves into Part 2's own source and fails with a confusing "cannot find module". From `loops/src/<area>/`:

```typescript
import { classifyHandoffReason, createToolPolicy, type HandoffReason }
  from "../../../src/agent/tool-policy.js";
import { type OrderLookupOutcome, type OrderResult }
  from "../../../src/tools/order-status.js";
import { openDatabase, type CallRecord, type CallOutcome }
  from "../../../src/storage/db.js";
import { readCallRecord } from "../../../src/storage/call-records.js";
```

From `loops/src/` itself — where the CLI entry points live — it is one fewer: `../../src/agent/agent-version.js`.

Two names to get right, because they are easy to guess wrong: the database helper is **`openDatabase(dbPath)`**, not `getDb()`, and **`CallRecord` is exported from `src/storage/db.ts`**, not from `call-records.ts`.

### `loops/` is its own npm package

It has its own `package.json`, `tsconfig.json`, `node_modules`, and `.env`. Run every loops command from inside `loops/`. It never builds a `dist` — every entry point runs through `tsx` — so its tsconfig is `noEmit` and typechecks `src` and `tests` both.

In a CLI entry point, `import "dotenv/config"` must come **before** any import that reads `process.env` at module scope — `src/agent/agent-version.js` is one. ESM evaluates imports top-to-bottom before the module body runs, so the wrong order silently stamps every report with the default `AGENT_VERSION`.

Its dependencies are `better-sqlite3` and `dotenv`. Nothing else. No Vonage SDK, no Deepgram, no `ws`, no Express. If a loops task seems to need one of those, the design is wrong — stop and raise it.

### The shared database

`data/calls.db` holds both tables: `call_records` (written by Part 1) and `eval_cases` (written by Part 2). From `loops/`, that file is `../data/calls.db` — which is what `loops/.env.example` sets `DB_PATH` to, and it is the same file the repo-root `.env` points at with `DB_PATH=./data/calls.db`.

`loops/src/db/eval-schema.ts` creates `eval_cases` and nothing else. It deliberately does **not** create `call_records`: if that table is missing, the database you pointed at is not the one the agent has been writing to, and failing loudly beats silently reviewing zero calls.

WAL mode is on, so the loops can read while a live call is writing.

### Architecture decisions — don't relitigate these

**Eval cases live in SQLite, not in JSON files.** The review loop writes proposals directly in one step; a proposal can reference its source `call_id`; approval is a single `UPDATE` the blog post can show in one line; and "what is waiting for me?" is a `SELECT`. The trade-off is real and worth stating in the post: a SQLite file is not version-controlled, so proposals get no git history and no PR review. A production team would export them back to JSON. Do not implement that here.

**The regression runner replays logic, not voice.** You cannot re-dial a phone call. Given a caller input string, the runner runs `classifyHandoffReason(input)`, and if there is no handoff, simulates a `FunctionCallRequest` through a minimal replay of `handleFunctionCall()` with a mock tool result injected. Then it compares the actual outcome to the expected one. No WebSocket, no audio, no real tool call — fast and deterministic.

**Two behaviours the eval suite cannot cover, by construction.** `outcome: "error"` is set only by a Deepgram `Error` frame, and `transport_error` has no `mock_tool_result` value that can express it — so the live handler's one-retry-on-transport-failure branch is covered by Part 1's unit tests, not by `npm run eval`. Know this before trusting a green run; do not invent a fourth sentinel to paper over it.

**The review loop proposes; humans decide.** Its only side effect is writing rows to `eval_cases` with `status = 'awaiting_review'`. It never changes prompts, tool policies, existing eval cases, or any live configuration, and it never approves its own proposals.

**Pattern detection is deterministic — no LLM.** Grouping uses only the structured columns (`outcome`, `handoff_reason`, `fallback_used`). Do not add a model call to classify patterns, and do not read transcript text to infer intent. A classifier inside the loop is one more thing that needs evaluating, which defeats the purpose.

Reading transcript text to recover a *verbatim* string is a different thing and is allowed — every proposal needs a replayable `input`, and there is nowhere else to get one. The review loop finds it by running Part 1's own `classifyHandoffReason` over the caller's turns and taking the first one whose reason matches what was recorded. That is how the live path decided, so it is how the decision is recovered: no guessing at "probably the last thing they said", and no second classifier to keep in sync.

**CLI triggers, not a scheduled job.** Both loops run as `npm run eval` / `npm run review`. The blog post's conclusion suggests growing `run-review.ts` into a cron job or GitHub Action; do not implement that here.

### The `eval_cases` table

```sql
CREATE TABLE IF NOT EXISTS eval_cases (
  id                      TEXT PRIMARY KEY,
  source_call_id          TEXT,            -- null for hand-authored cases
  created_at              TEXT NOT NULL,
  input                   TEXT NOT NULL,   -- the caller utterance to replay
  expected_outcome        TEXT NOT NULL
    CHECK (expected_outcome IN ('completed', 'fallback', 'handoff', 'error')),
  expected_handoff_reason TEXT,            -- billing | returns | cancellation | account | unsupported | null
  expected_fallback       INTEGER NOT NULL DEFAULT 0
    CHECK (expected_fallback IN (0, 1)),
  expected_tool_called    INTEGER NOT NULL DEFAULT 1
    CHECK (expected_tool_called IN (0, 1)),
  mock_tool_result        TEXT,            -- JSON OrderResult, "__timeout__", or null
  status                  TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'awaiting_review', 'rejected')),
  notes                   TEXT,            -- human-readable explanation
  source_call_ids         TEXT             -- JSON array of contributing call ids
);
```

`source_call_id` is the one representative call; `source_call_ids` is the whole evidence group a proposal was built from. Both exist because a proposal is evidence-backed by definition ("five calls did this") and the singular column predates the review loop. New columns are added the way Part 1 does it in `src/storage/db.ts` — an `ALTER TABLE` guarded by `PRAGMA table_info`, since `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database.

`status = 'approved'` means the regression runner includes it. `status = 'awaiting_review'` means the review loop proposed it and a human must approve it first. `status = 'rejected'` means a human looked and declined.

Two storage rules that are easy to get wrong:

* **`mock_tool_result` holds three different things:** a JSON `OrderResult`, the bare string `__timeout__`, or NULL. The sentinel exists because a timeout is the *absence* of a return value — there is no `OrderResult` shape that means "the 1500ms deadline fired". Replay turns it into `{ kind: "timeout", durationMs: 1600 }`. It is stored bare, not JSON-encoded, so a `sqlite3` query reads `__timeout__` and not `"__timeout__"`.
* **Inserts use `ON CONFLICT(id) DO NOTHING`, never `INSERT OR IGNORE` and never `OR REPLACE`.** `OR IGNORE` silently skips rows that violate *any* constraint, so a typo'd `expected_outcome` would vanish without an error. `OR REPLACE` would revert a human's approval on the next run. An existing row always wins, and every CHECK stays loud.

### The review loop's four detectors

Implemented in `loops/src/review/pattern-finder.ts`. Do not add a fifth without discussion — every detector is a claim about what is worth a human's attention, and a noisy queue is an ignored queue.

| # | Pattern | Threshold | Proposes |
| - | ------- | --------- | -------- |
| 1 | A repeated `handoff_reason` | 2 calls | `handoff` with that reason, tool not called |
| 2 | Tool timeouts | 3 calls | `fallback`, `mock_tool_result = __timeout__` |
| 3 | `unsupported` handoffs, per distinct utterance | 1 call | `handoff` (`unsupported`), tool not called |
| 4 | `fallback_used` with no timeout in `tool_calls` | 2 calls | `completed` — see below |

Four things about these that are easy to get wrong:

* **A timeout is stored as the bare string `"timeout"`.** `{"kind":"timeout"}` is the in-memory `OrderLookupOutcome` shape and is never persisted; the call record stores `result: OrderResult | "timeout"`. Matching on `kind` finds zero calls forever, and the loop looks like it is working.
* **Detector 4 proposes `completed`, not `fallback`.** Those fallbacks come from the one-call-per-conversation budget being spent, and replay gives every eval case a fresh policy — so a single-utterance case can never reproduce it. The case asserts what that utterance should do on its own; the pattern that prompted it goes in `notes` for the human.
* **Detector 3 can only ever surface explicit escalation requests.** `unsupported` is set by keyword match (`human`, `representative`, `operator`, `complaint`, `warranty`, …), so a genuinely novel question — "do you sell gift cards?" — classifies as *nothing*, never hands off, and never reaches this detector. "Unanswered questions" means "callers who asked for a person", not "questions the agent could not answer". Widening that is a Part 1 change to the classifier, not a loops change.
* **Detectors 1 and 3 overlap on repeated `unsupported` handoffs, and that is fine.** The write step drops the duplicate, because a duplicate is defined by what the proposal *asserts*, not by which detector produced it.

### Grouping is exact-match, and stays that way

Detector 3 groups utterances by exact string equality. No stemming, no edit distance, no embeddings. Anything smarter is a similarity threshold somebody has to tune, and a mistuned threshold either merges two real problems into one proposal or splits one into six — silently, inside the tool whose whole job is telling you what is true. Exact match can only fail by proposing too much, and too much lands in a queue a human is already reading.

### Proposal identity and idempotency

* A proposal is a duplicate when an existing case shares its **`input` and `expected_outcome`** and is `awaiting_review` or `approved`. Skip it: do not stack duplicates in a queue nobody has worked through, and do not re-propose what is already in the suite.
* `rejected` does **not** block a new proposal. A human said "not this"; if the behaviour keeps happening they should get to say it again with fresh evidence rather than have the loop quietly agree with them forever.
* Proposal ids are `proposal-<epoch-ms>-<pattern-type>` and are **not unique on their own**. Two patterns of the same type share a millisecond, and a re-proposal after a rejection regenerates the id of the rejected row still in the table. Both are reachable; both would be swallowed by `ON CONFLICT DO NOTHING`. Check this run's issued ids *and* the stored ones before writing.

### Approval commands (show these in the blog post)

```bash
# See what's waiting
sqlite3 ../data/calls.db \
  "SELECT id, input, expected_outcome, notes \
   FROM eval_cases WHERE status = 'awaiting_review';"

# Approve one
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'approved' WHERE id = 'proposal-001';"

# Reject one
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'rejected' WHERE id = 'proposal-002';"
```

### Seed eval cases

`loops/eval-cases/seed-cases.json` holds four hand-authored cases, committed to git, loaded into the database on first run. They mirror the four scenarios from Part 1's "Try Four Calls" section: happy path, timeout, `not_found`, and out-of-scope handoff. Seeding is idempotent — the first run inserts four cases, every run after that inserts nothing and changes nothing.

They live in JSON rather than in code for one reason worth explaining in the post: that file *is* version-controlled, while the database is not. A reader adding a fifth case edits JSON and gets a diff for it.

### Out of scope for `loops/` — do not build

* No automatic changes to prompts, tools, or live configuration. The loops propose; humans decide.
* No scheduled job implementation — mention it in the blog post conclusion only.
* No web UI for reviewing proposals — the `sqlite3` commands above are enough for a tutorial.
* No LLM call anywhere inside either loop.
* No connection to the live WebSocket or voice path, and no call to the real `lookupOrderStatus`.
* No Part 3 content — connecting to a real order database and expanding the tool set is the next article.

---

## Workflow

* Plan first. Write a checklist to `tasks/todo.md` before coding.
* **Which `tasks/` directory:** work on `loops/` plans in `loops/tasks/`; work on the live path plans in the root `tasks/`. Both follow the same template, the same archive naming, and the same blog-worthy-notes rule.
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

Part 1 defaults (`src/`, root `tests/`):

* `src/tools/order-status.ts`: unit tests must cover `in_transit`, `delivered`, `not_found`, the 1500ms timeout (use fake timers), and the retry-on-transport-failure path. Never call an external API from tests.
* `src/agent/tool-policy.ts`: test that the policy correctly allows one call, blocks a second call, allows one retry on transport failure, and does not retry on `not_found`.
* `src/storage/call-records.ts`: test write and read against an in-memory SQLite database. Every field in the call record schema must be covered.
* Do not test the WebSocket plumbing directly — that is integration territory. Keep unit tests focused on policy, tool behavior, and storage.

Each part runs its own tests from its own directory. The root `vitest.config.ts` excludes `loops/**`, so `npm test` at the root runs Part 1's suite only and `npm test` inside `loops/` runs Part 2's — two packages, two dependency trees, two reports.

Part 2 defaults (`loops/`, `loops/tests/`):

* **Never read the real `data/calls.db` from a test.** Open `:memory:` and insert fixture rows. A test that depends on whatever calls happened to be made last week is not a test.
* **Never call the real `lookupOrderStatus`** — it has real delays, including a deliberate 2000ms one. Inject a mock tool function instead.
* `loops/src/db/eval-schema.ts`: table exists, every column round-trips, the CHECK constraints actually reject bad values, and a duplicate id leaves the existing row untouched.
* `loops/src/db/seed-loader.ts`: the committed seed file parses, a malformed case is rejected by name, a second load inserts nothing, and a status a human edited between runs survives.
* `loops/src/runner/replay.ts`: pass (correct outcome), fail (wrong outcome), handoff detected, fallback triggered on the timeout sentinel, and `not_found` treated as completed.
* `loops/src/review/pattern-finder.ts`: groups repeated handoff reasons, groups repeated timeouts, and ignores patterns below the minimum evidence threshold (default: 3 calls).
* `loops/src/review/transcript-review.ts`: writes proposals with `status = 'awaiting_review'`, does not duplicate one already awaiting review or approved, re-proposes after a rejection, records the evidence in `source_call_ids`, and respects the window limit.
* Build call-record fixtures with Part 1's own `writeCallRecord` into Part 1's own `openDatabase(":memory:")` schema. A hand-written row can express a call the live path could never produce — a `handoff_reason` with no utterance that would cause it — and then you are testing against a call that cannot happen.
* `loops/src/runner/report.ts`: formats pass/fail counts correctly and lists each failure with input, expected, and actual.

---

## Done means

* Plan completed and checked off.
* Tests added or updated for all behavior changes.
* `npm test` passes and `npm run typecheck` is clean, in whichever package the change touched.
* Completed plan moved from `tasks/todo.md` to `tasks/archive/` and renamed with an **execution datetime stamp + feature name**: `YYYY-MM-DDThhmm-<feature>.md` (local time, 24-hour, e.g. `2026-07-27T2100-handoff-detection-and-logs.md`). The datetime prefix is required so archived plans sort chronologically and the execution order is unambiguous — a date alone is not enough when several plans land the same day.

For a change to the live path (`src/`):

* All failure modes manually verified, with the correct outcome recorded for each — Part 2's loops query `fallbackUsed` and `outcome` directly, so a `not_found` call showing up as `outcome: "fallback"` in the transcript-review loop would be a false signal:
  * `not_found` returns a speakable result via `FunctionCallResponse` (`outcome: "completed"`, `fallbackUsed: false`) — the tool ran and answered; the model narrates it. It is **not** a fallback.
  * `timeout` and `transport_error` trigger the deterministic fallback (`outcome: "fallback"`, `fallbackUsed: true`) — the tool failed to run. `transport_error` retries once first; `timeout` never retries.
  * Out-of-scope request triggers the handoff (`outcome: "handoff"`, `handoffRequested: true`), tool never called.
* Call record is written to SQLite for every call outcome, including error and handoff cases.
* Latency fields are populated with real measurements, not zeros or placeholders.

For a change to the loops (`loops/`):

* Both CLI scripts run end-to-end against a seeded database without errors.
* Nothing in `loops/` imports Vonage, Deepgram, `ws`, or Express, and nothing in `src/` imports from `loops/`.

---

## Commands

Part 1 — the live path, from the repo root:

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

Part 2 — the offline loops, from `loops/`:

```bash
cd loops
npm install

# Run the regression evaluation runner
npm run eval

# Run the transcript review loop
npm run review

# Tests and typecheck
npm test
npm run typecheck

# Approve a proposal
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'approved' WHERE id = 'proposal-001';"
```

---

## Out of scope — do not build

For the live path (`src/`):

* No outbound calling (Part 1 is inbound only)
* No ElevenLabs, Pipecat, or additional providers — Deepgram handles ASR and TTS
* No real order database — the mock in `order-status.ts` is intentional
* No production rate limiting or abuse protection — leave a `// TODO` comment
* No open-ended general assistant behavior — the constrained prompt is the point
* No Android or iOS client — this is a server-side tutorial
* No awareness of `loops/` — the live path does not import from it or know it exists

For the loops (`loops/`): see "Out of scope for `loops/`" above.
