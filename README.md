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

### What This Agent Does

This agent has one job: look up an order status. Everything else is out of scope.

| If the caller asks... | The agent... |
|---|---|
| "Where is order A1001?" | Looks it up and reads back the result |
| About an order that doesn't exist | Tells them it couldn't find it — no fallback, just an honest answer |
| And the lookup takes too long | Says it's having trouble and offers to connect them to support |
| About billing, returns, or anything else | Transfers them to a human immediately |

A few hard limits the code enforces:

- **One lookup per call** — not a prompt suggestion, a code rule in `src/agent/tool-policy.ts`
- **1500ms timeout** — if the backend doesn't answer in time, the caller gets the fallback
- **One retry on network failures** — timeouts are never retried
- **No write operations** — this agent reads, it never changes anything

Every call is saved to SQLite: transcript, tool result, timing, and outcome. Part 2 reads those records to find patterns and run regression tests.

For full setup instructions — Vonage application, ngrok, environment variables, and the three test calls — see the [Part 1 tutorial](https://developer.vonage.com/en/blog/), the [Part 1 repo](https://github.com/Vonage-Community/blog-voice-node_deepgram_ai_tools), or [`docs/live-call-checklist.md`](docs/live-call-checklist.md).

---

## Part 2: The Offline Loops

Part 1 leaves behind a row per call: the transcript, the tool call and its result, per-stage latency, and the outcome. Part 2 is two CLI scripts that turn that pile of evidence into a test suite that grows.

**The regression runner (`npm run eval`)** replays stored evaluation cases against the agent's real decision logic — the same `classifyHandoffReason` and tool policy the live path uses — with the tool's answer injected instead of fetched. No phone call, no WebSocket, no Deepgram. It compares what the agent *would* do against what the case says it *should* do, prints a pass/fail line per case, writes a JSON report, and exits non-zero on any failure, so a regression fails a build.

**The transcript review loop (`npm run review`)** reads the recent call window and looks for four things: a handoff reason that keeps recurring, tool timeouts, callers asking for a human, and fallbacks that weren't timeouts. Where it finds evidence, it writes a proposed evaluation case with `status = 'pending'` and the contributing call IDs attached. It never adds its own proposals to the suite, never edits an existing case, and never touches a prompt or a tool. Pattern detection is deterministic — structured columns only, no model call anywhere in the loop.

Together they close a cycle: real calls become evidence, evidence becomes a proposal, a human approves it, and the suite is one case larger the next time it runs.

```bash
cd loops
cp .env.example .env   # no API keys needed
npm install
npm run seed-calls     # load demo call records
npm run eval           # 4 cases pass
npm run review         # finds patterns, writes proposals
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'added' WHERE id = 'proposal-xxx';"
npm run eval           # 5 cases pass — suite grew
```

See [`loops/README.md`](loops/README.md) for the full three-run demo, all commands, and troubleshooting.

---

## Quick start for the full project

```bash
# Part 1 — live agent
cp .env.example .env        # fill in VONAGE_APP_ID, VONAGE_NUMBER, SUPPORT_PHONE_NUMBER, DEEPGRAM_API_KEY and BASE_URL
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
