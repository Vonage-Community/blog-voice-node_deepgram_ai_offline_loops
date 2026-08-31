# Offline Agent Loops

## What this is

Part 2 of a two-part series. Two CLI loops that read the call records Part 1 writes: a **regression runner** (`npm run eval`) that replays eval cases against the agent's logic and fails on drift, and a **transcript review loop** (`npm run review`) that scans stored calls, finds patterns, and proposes new eval cases for a human to approve. Neither loop opens a socket, calls Deepgram or Vonage, or touches the live voice path — they read and write one SQLite file. **Part 1 must be set up first**; without it there are no call records to read.

Part 1 does not need to be running for the loops to work. The eval runner and review loop read from `data/calls.db` — a file on disk. You only need Part 1 running when you want to make real phone calls to generate new call records (Run 3 in the demo below).

---

## Prerequisites

- **Part 1 set up and working** — see the [root README](../README.md). `loops/` is a separate npm package inside that repo.
- **At least one call record in `../data/calls.db`** — make a real call, or run `npm run seed-calls` (below) for ten synthetic ones.
- **Node.js 20+**
- **`sqlite3`** on your PATH for the approval commands (macOS ships it; otherwise `brew install sqlite`).

You do **not** need Vonage or Deepgram credentials here. The loops never call either.

---

## Quick Start

```bash
# From the repo root — set up Part 1's environment if you haven't already
cp .env.example .env
# fill in VONAGE_APP_ID, VONAGE_PRIVATE_KEY_PATH, DEEPGRAM_API_KEY, BASE_URL

# Then set up the loops environment
cd loops
cp .env.example .env
# defaults are already correct — DB_PATH points at ../data/calls.db
# which is where Part 1 writes. No API keys needed here.

npm install
npm run seed-calls
npm run eval
npm run review
```

`npm run eval` creates the `eval_cases` table and loads the four seed cases on first run, so there is no separate migration step.

---

## The three-run demo

The loop is the point, not either command on its own. Run it three times, with different evidence each time, and watch the eval suite grow.

### Run 1 — From pre-built seeds

```bash
npm run eval
# 4 cases pass — baseline confirmed

npm run review
# → returns handoff (3 calls)          proposal written
# → billing handoff (2 calls)          proposal written
# → timeout pattern (3 calls)          Skipped — already covered by case seed-002 in the suite
# → fallback without timeout (2 calls) proposal written
#
# 3 proposals written
```

Note the skip. The timeout pattern is real — three calls hit the deadline — but `seed-002` already asserts exactly that (`"Where is order SLOW999?"` → `fallback`), so the loop declines to propose a duplicate of a case already in the suite. A pattern is a duplicate when it *asserts* the same thing, no matter which detector found it.

See what is waiting:

```bash
sqlite3 ../data/calls.db \
  "SELECT id, notes, status FROM eval_cases WHERE status = 'pending';"
```

Add one to the suite (paste a real id from that output):

```bash
sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'added' WHERE id = 'proposal-<id>';"
```

```bash
npm run eval
# 5 passed, 0 failed — the proposal you added is now part of the suite
```

That is the whole cycle: the review loop found a pattern in real evidence, a human added it, and the regression suite grew by one case. Nothing entered the suite automatically — the loop only ever writes `pending`.

### Run 2 — After adding more synthetic data

What happens here depends on whether you ran `npm run seed-calls` in the Quick Start.

**If you skipped it** (you had real call records already), add the synthetic ten now:

```bash
npm run seed-calls
# 10 inserted, 0 skipped

npm run review
# returns and billing handoffs are new — proposals written
# blocked-fallback pattern is new — proposal written
```

**If you already ran it**, you get the other half of the lesson:

```bash
npm run seed-calls
# 0 inserted, 10 skipped   ← idempotent, safe to re-run

npm run review
# → returns handoff (3 calls)          Skipped — already covered by case proposal-… in the suite
# → billing handoff (2 calls)          Skipped — already proposed as proposal-…
# → timeout pattern (3 calls)          Skipped — already covered by case seed-002 in the suite
# → fallback without timeout (2 calls) Skipped — already proposed as proposal-…
#
# No new proposals written.
```

Both are correct. The loop still finds all four patterns and still prints them — it just refuses to write a proposal that duplicates one already in your queue or already in the suite. **Same evidence, nothing new to say.** A `dismissed` proposal is the exception: dismiss one and the pattern comes back next run, because a human saying "not now" once should not silence a behaviour that keeps happening.

Add another one and the suite grows again:

```bash
sqlite3 ../data/calls.db \
  "SELECT id, notes, status FROM eval_cases WHERE status = 'pending';"

sqlite3 ../data/calls.db \
  "UPDATE eval_cases SET status = 'added' WHERE id = 'proposal-<id>';"

npm run eval
```

### Run 3 — After real phone calls

Make three calls to your running Part 1 agent (`npm run dev` at the repo root):

```bash
cd ..
npm run dev
```

| Call | What to say | What it generates |
| --- | --- | --- |
| 1 | "Where is order A1001?" | `outcome: completed` — working correctly |
| 2 | "I want to return my order" | `outcome: handoff`, `handoff_reason: returns` |
| 3 | "I want to cancel my order" | `outcome: handoff`, `handoff_reason: cancellation` |

> Make each one a **separate call**. Calls 2 and 3 both hand off, and a handoff transfers you to a human — that call is over. Dial again for the next one.

Then inspect the new records:

```bash
sqlite3 ../data/calls.db \
  "SELECT call_id, outcome, handoff_reason \
   FROM call_records ORDER BY started_at DESC LIMIT 3;"
```

Then run the review loop:

```bash
cd loops
npm run review
```

Call 1 completed cleanly — the loop finds no pattern worth proposing and moves on. That's intentional. A good loop is selective, not noisy.

Calls 2 and 3 both ended in handoffs, but for different reasons. The review loop surfaces them as separate proposals because they would need separate fixes — a returns capability is a different integration than a cancellation flow. Two proposals, two decisions for the reviewer to make.

If you followed Part 1 before starting this tutorial, A1001 is already in your database. The loop will still find nothing to propose for it. The calls that matter here are the returns and cancellation requests.

```bash
npm run eval
# stable — no new approvals yet
```

The review loop cannot tell the difference between a record from a real phone call and one from the seed script — it reads the same columns either way.

---

## All commands

```bash
npm run eval          # regression runner — exit 1 if any cases fail
npm run review        # transcript review — always exit 0, proposals are informational
npm run seed-calls    # load demo call records into ../data/calls.db
npm test              # 110 tests
npm run typecheck     # tsc --noEmit
```

Reports from each eval run are written to `loops/reports/` (gitignored) so you can diff runs.

Two directories named `data/` mean different things: **`../data/calls.db`** is generated evidence and is gitignored; **`loops/data/seed-calls.json`** is committed fixture input. Don't tidy one into the other.

---

## Troubleshooting

**`npm run eval` shows 0 cases** — the `eval_cases` table has no `added` rows. Either every case was dismissed, or `DB_PATH` points at a different file than the one you have been writing to. Check with `sqlite3 ../data/calls.db "SELECT status, COUNT(*) FROM eval_cases GROUP BY status;"`.

**`npm run review` writes 0 proposals** — every pattern it found already has a `pending` or `added` case asserting the same thing. That is the idempotency rule working; the run still prints each pattern and why it was skipped. Add more call records, or dismiss an existing proposal to let the pattern surface again.

**`DB_PATH` not found** — copy `.env.example` to `.env`. The default is `../data/calls.db`, which is where Part 1 writes (`DB_PATH=./data/calls.db` from the repo root — same file, one directory up).

**`sqlite3` returns `no such table: eval_cases`** — run `npm run eval` first; it creates the table on startup. If you get `no such table: call_records`, the database you pointed at is not the one Part 1 has been writing to.

---

## What's next

The [Part 2 blog post](https://developer.vonage.com/en/blog/) walks through why each boundary exists — why the runner replays logic instead of voice, and why the review loop proposes rather than decides. Both loops are plain CLI scripts, so the manual `npm run eval` trigger can become a CI step on every pull request and `npm run review` a scheduled job that files proposals for you to read on Monday.
