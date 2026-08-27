// -----------------------------------------------------------------------------
// `npm run review` — the transcript review loop.
//
// Read the recent call window, propose eval cases for anything new, print what
// happened. Always exits 0: a proposal is an observation, not a failure. The
// eval runner is the thing that fails a build; this loop only ever tells you
// what it noticed, and a reviewer decides whether it matters.
//
// As in run-eval.ts, `import "dotenv/config"` comes first so that anything
// reading process.env at module scope sees the .env values.
// -----------------------------------------------------------------------------

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { openEvalDatabase } from "./db/eval-schema.js";
import {
  DEFAULT_WINDOW,
  formatReviewSummary,
  reviewTranscripts,
} from "./review/transcript-review.js";

const LOOPS_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Parse REVIEW_WINDOW, ignoring anything that is not a positive integer. */
function windowSize(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW;
}

function main(): void {
  const dbPath = resolve(LOOPS_ROOT, process.env.DB_PATH ?? "../data/calls.db");
  const db = openEvalDatabase(dbPath);

  try {
    const summary = reviewTranscripts(db, {
      windowSize: windowSize(process.env.REVIEW_WINDOW),
    });

    // Printed relative to the repo root so the sqlite3 commands can be pasted
    // straight into a shell sitting in loops/.
    console.log(formatReviewSummary(summary, { dbPath: relative(LOOPS_ROOT, dbPath) }));
  } finally {
    db.close();
  }

  // Explicitly 0 — see the header. Nothing this loop finds is a build failure.
  process.exitCode = 0;
}

main();
