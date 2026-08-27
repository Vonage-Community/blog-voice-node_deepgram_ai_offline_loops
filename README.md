# Voice Agent Tools, Fallbacks, and Offline Loops — Vonage + Deepgram

The companion repo for a two-part Vonage developer-blog series: **Part 1** builds a bounded live voice agent on the Vonage Voice API and Deepgram Voice Agent, and **Part 2** builds the offline evaluation loops that read what it recorded and catch it when it drifts.

---

## What's in this repo

- **`src/`** — the bounded live voice agent from Part 1. One tool, strict timeouts, deterministic fallbacks, human handoff, call records written to SQLite after every call.
- **`loops/`** — the offline evaluation loops from Part 2. A regression runner and a transcript review loop that read those call records, find patterns, and propose new test cases for human approval.

The two parts share one SQLite database. Part 1 writes to it during calls. Part 2 reads from it without needing Part 1 to be running.

---

## Part 1: The Live Agent

- **Blog post:** [Add Tools and Human Transfer to a Vonage + Deepgram Voice Agent](https://developer.vonage.com/en/blog/) *(link to be added when published)*
- **Part 1 repo:** [Vonage-Community/blog-voice-node_deepgram_ai_tools](https://github.com/Vonage-Community/blog-voice-node_deepgram_ai_tools) — the live agent on its own, with its full setup guide
- **Prerequisite guide:** [How to Build an AI Voice Agent with Vonage Voice API and Deepgram](https://developer.vonage.com/en/voice/voice-api/guides/voice-ai-agent-deepgram) — Part 1 builds directly on top of it

### The Live-Path Contract

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

For full setup instructions — Vonage application, ngrok, environment variables, and the three test calls — see the [Part 1 tutorial](https://developer.vonage.com/en/blog/), the [Part 1 repo](https://github.com/Vonage-Community/blog-voice-node_deepgram_ai_tools), or [`docs/live-call-checklist.md`](docs/live-call-checklist.md).

---

## Part 2: The Offline Loops

Part 1 leaves behind a row per call: the transcript, the tool call and its result, per-stage latency, and the outcome. Part 2 is two CLI scripts that turn that pile of evidence into a test suite that grows.

**The regression runner (`npm run eval`)** replays stored evaluation cases against the agent's real decision logic — the same `classifyHandoffReason` and tool policy the live path uses — with the tool's answer injected instead of fetched. No phone call, no WebSocket, no Deepgram. It compares what the agent *would* do against what the case says it *should* do, prints a pass/fail line per case, writes a JSON report, and exits non-zero on any failure, so a regression fails a build.

**The transcript review loop (`npm run review`)** reads the recent call window and looks for four things: a handoff reason that keeps recurring, tool timeouts, callers asking for a human, and fallbacks that weren't timeouts. Where it finds evidence, it writes a proposed evaluation case with `status = 'awaiting_review'` and the contributing call IDs attached. It never approves its own proposals, never edits an existing case, and never touches a prompt or a tool. Pattern detection is deterministic — structured columns only, no model call anywhere in the loop.

Together they close a cycle: real calls become evidence, evidence becomes a proposal, a human approves it, and the suite is one case larger the next time it runs.

```bash
cd loops
cp .env.example .env   # no API keys needed
npm install
npm run seed-calls     # load demo call records
npm run eval           # 4 cases pass
npm run review         # finds patterns, writes proposals
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'approved' WHERE id = 'proposal-xxx';"
npm run eval           # 5 cases pass — suite grew
```

See [`loops/README.md`](loops/README.md) for the full three-run demo, all commands, and troubleshooting.

---

## Quick start for the full project

```bash
# Part 1 — live agent
cp .env.example .env        # fill in DEEPGRAM_API_KEY and BASE_URL
npm install
ngrok http 3000             # copy the URL into BASE_URL and Vonage dashboard
npm run dev

# Part 2 — offline loops (Part 1 does not need to be running)
cd loops
cp .env.example .env        # defaults are correct — no API keys needed
npm install
npm run seed-calls
npm run eval
npm run review
```

---

## Testing

- **Root:** `npm test` (92 tests — tool policy, WebSocket bridge, storage)
- **Loops:** `cd loops && npm test` (110 tests — eval schema, runner, review loop, seed script)

---

## License

MIT

---

## Related

- [How to Build an AI Voice Agent with Vonage Voice API and Deepgram](https://developer.vonage.com/en/voice/voice-api/guides/voice-ai-agent-deepgram) — the prerequisite guide
- [Vonage-Community/blog-voice-node_deepgram_ai_tools](https://github.com/Vonage-Community/blog-voice-node_deepgram_ai_tools) — the Part 1 repo
- [Vonage Voice API / NCCO reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference)
- [Deepgram Voice Agent API](https://developers.deepgram.com/docs/voice-agent)
- [Blog Post](https://developer.vonage.com/en/blog/) *(link to be added when published)*
