// -----------------------------------------------------------------------------
// An optional local dashboard for the two loops.
//
// This is NOT part of the tutorial. The tutorial is still two CLI commands and a
// `sqlite3` query, and it stays that way — nothing here is imported by
// `run-eval.ts`, `run-review.ts`, or `seed-more-calls.ts`. Delete this directory
// and Part 2 is unchanged.
//
// What it is for: watching the loop work. A proposal queue you can see is a
// different experience from a proposal queue you have to SELECT, and for a demo
// — or a blog post screenshot — that difference is the whole point.
//
// What it deliberately is not: a product. It cannot edit an eval case, read a
// transcript, or run either loop. See index.html and the archived plan for why
// each of those absences is a decision rather than a gap.
//
// Note on AGENTS.md: that file says loops/ depends on better-sqlite3 and dotenv,
// "nothing else … no Express". This directory is the documented exception, and
// AGENTS.md now records it. The rule still holds for everything the tutorial
// actually runs.
// -----------------------------------------------------------------------------

// Must come before any import that reads process.env at module scope.
import "dotenv/config";

import express, { type Express, type Request, type Response } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseType } from "better-sqlite3";

// Three levels, not two. `loops/src/dashboard/` sits at the same depth as
// `runner/` and `review/`, so `../../src/...` would resolve to
// `loops/src/storage/` — a directory that does not exist — and fail with a
// confusing "cannot find module".
import { openDatabase } from "../../../src/storage/db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where `npm run eval` writes its JSON reports. */
const REPORTS_DIR = process.env.REPORTS_DIR ?? join(HERE, "..", "..", "reports");

/** How many eval reports to hand the page. It renders the newest five. */
const MAX_EVAL_RUNS = 10;

/** How many recent calls to hand the page. */
const MAX_CALLS = 20;

/** One row of the recent-calls table. */
export interface CallSummary {
  call_id: string;
  outcome: string;
  handoff_reason: string | null;
  fallback_used: number;
  started_at: string;
  agent_version: string;
}

/** One pending proposal, as the page renders it. */
export interface ProposalSummary {
  id: string;
  input: string;
  notes: string | null;
  expected_outcome: string;
  expected_handoff_reason: string | null;
  created_at: string;
  source_call_ids: string[];
}

/** A proposal a human has already decided on. */
export interface DecisionSummary extends ProposalSummary {
  status: "added" | "dismissed";
}

/** A proposal row as SQLite returns it, before the evidence array is parsed. */
type ProposalRow<T extends ProposalSummary> = Omit<T, "source_call_ids"> & {
  source_call_ids: string | null;
};

/**
 * Build the app around an already-open database.
 *
 * The handle is injected rather than opened here so tests can pass `:memory:`
 * and the entry point can own the real file. Same convention as the rest of
 * `loops/` — no module-level global connection.
 */
export function createDashboardApp(db: DatabaseType): Express {
  const app = express();
  app.use(express.json());

  // --- Proposals ------------------------------------------------------------

  app.get("/api/proposals", (_req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, input, notes, expected_outcome, expected_handoff_reason,
                created_at, source_call_ids
           FROM eval_cases
          WHERE status = 'pending'
          ORDER BY created_at DESC, id DESC`,
      )
      .all() as Array<ProposalRow<ProposalSummary>>;

    res.json(rows.map(withEvidence));
  });

  // The only two writes in the whole dashboard, and they are the same single
  // UPDATE the blog post shows as a `sqlite3` one-liner. That is deliberate:
  // the button is a shortcut for a command a reader could type, not a new
  // capability. Anything the UI can do, the CLI can already do.
  app.post("/api/proposals/:id/add", (req: Request, res: Response) => {
    setStatus(db, routeId(req), "added", res);
  });

  app.post("/api/proposals/:id/dismiss", (req: Request, res: Response) => {
    setStatus(db, routeId(req), "dismissed", res);
  });

  // --- Decisions ------------------------------------------------------------

  // Where proposals go once a human has answered them. Read-only, like every
  // panel except the queue: the rows were never deleted, so this is a view of
  // data the table already holds, not a new feature.
  //
  // `source_call_id IS NOT NULL` is what separates a decision from a seed. The
  // seed cases are `added` too, but nobody decided anything — they were written
  // by hand before there were calls. Every proposal the review loop writes
  // carries the call it came from.
  app.get("/api/decisions", (_req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, input, notes, expected_outcome, expected_handoff_reason,
                created_at, source_call_ids, status
           FROM eval_cases
          WHERE status IN ('added', 'dismissed')
            AND source_call_id IS NOT NULL
          ORDER BY created_at DESC, id DESC`,
      )
      .all() as Array<ProposalRow<DecisionSummary>>;

    res.json(rows.map(withEvidence));
  });

  // --- Eval runs ------------------------------------------------------------

  app.get("/api/eval-runs", (_req: Request, res: Response) => {
    res.json(readEvalRuns());
  });

  // --- Recent calls ---------------------------------------------------------

  app.get("/api/calls", (_req: Request, res: Response) => {
    const calls = db
      .prepare(
        `SELECT call_id, outcome, handoff_reason, fallback_used, started_at, agent_version
           FROM call_records
          ORDER BY started_at DESC, call_id DESC
          LIMIT ?`,
      )
      .all(MAX_CALLS) as CallSummary[];

    res.json(calls);
  });

  // --- The page -------------------------------------------------------------

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(HERE, "index.html"));
  });

  return app;
}

/** Parse the stored JSON evidence array. The page shows its length as evidence weight. */
function withEvidence<T extends ProposalSummary>(row: ProposalRow<T>): T {
  return {
    ...row,
    source_call_ids: row.source_call_ids ? (JSON.parse(row.source_call_ids) as string[]) : [],
  } as T;
}

/**
 * The `:id` path segment as a plain string.
 *
 * Express types a route param as `string | string[]` — the array case is for
 * repeated segments, which this route does not have. Narrowing here keeps the
 * two handlers to one line each instead of repeating the coercion.
 */
function routeId(req: Request): string {
  const { id } = req.params;
  return Array.isArray(id) ? (id[0] ?? "") : (id ?? "");
}

/**
 * Move one proposal to a new status.
 *
 * 404 when nothing was updated. `UPDATE` reports zero changes both for an id
 * that does not exist and for one already at the target status, and the page
 * treats both the same way — the row is gone from the queue either way, which
 * is the only thing the caller acts on.
 */
function setStatus(
  db: DatabaseType,
  id: string,
  status: "added" | "dismissed",
  res: Response,
): void {
  const result = db.prepare("UPDATE eval_cases SET status = ? WHERE id = ?").run(status, id);

  if (result.changes === 0) {
    res.status(404).json({ error: `no eval case with id "${id}"` });
    return;
  }

  res.json({ id, status });
}

/**
 * The most recent eval reports, newest first.
 *
 * Report filenames are `eval-YYYY-MM-DDThhmm.json`, which sorts
 * lexicographically in timestamp order — so a reverse name sort is a reverse
 * time sort, with no need to stat or parse anything first.
 *
 * A missing reports directory is an empty list, not an error: it simply means
 * `npm run eval` has never run here, and the page has an empty state for that.
 * An unreadable or malformed individual report is skipped rather than failing
 * the request, so one truncated file cannot blank the whole panel.
 */
function readEvalRuns(): unknown[] {
  let files: string[];
  try {
    files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  return files
    .sort()
    .reverse()
    .slice(0, MAX_EVAL_RUNS)
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(REPORTS_DIR, file), "utf8")) as unknown;
      } catch {
        return null;
      }
    })
    .filter((report): report is unknown => report !== null);
}

/** Open the real database and listen. Only the CLI entry point calls this. */
export function startDashboard(): void {
  const dbPath = process.env.DB_PATH ?? "../data/calls.db";
  const port = Number(process.env.DASHBOARD_PORT) || 4000;

  const db = openDatabase(dbPath);
  createDashboardApp(db).listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });
}

// Run only when executed directly, so importing this module in a test does not
// bind a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}
