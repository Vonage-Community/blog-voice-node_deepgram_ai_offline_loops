// -----------------------------------------------------------------------------
// `npm run eval` — the regression evaluation runner.
//
// Seed the suite, load every added case, replay each one against the agent's
// logic, print the run, write the report, and exit non-zero if anything failed
// so CI can fail a build on a regression.
//
// Note the import order below, because it is load-bearing and it looks like
// style. `import "dotenv/config"` must come *before* Part 1's agent-version
// module. ESM evaluates a module's imports top-to-bottom before it runs a single
// line of the module body, and `AGENT_VERSION` reads `process.env` at evaluation
// time. Import it above dotenv and it captures the environment as it was before
// `.env` was read — so AGENT_VERSION in your .env would be silently ignored and
// every report would be stamped with the default. Nothing warns you.
// -----------------------------------------------------------------------------

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { AGENT_VERSION } from "../../src/agent/agent-version.js";
import { listEvalCases, openEvalDatabase } from "./db/eval-schema.js";
import { loadSeedCases } from "./db/seed-loader.js";
import { replayAll } from "./runner/replay.js";
import { buildReport, formatSummary, writeReport } from "./runner/report.js";

/** The `loops/` package root, resolved from this module so cwd cannot change the answer. */
const LOOPS_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The repo root — used only to print report paths as `loops/reports/...`. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function main(): void {
  // Paths from .env are relative to the loops package, not to wherever the
  // command was typed. `resolve` leaves an absolute DB_PATH alone.
  const dbPath = resolve(LOOPS_ROOT, process.env.DB_PATH ?? "../data/calls.db");
  const reportsDir = resolve(LOOPS_ROOT, process.env.REPORTS_DIR ?? "reports");

  const db = openEvalDatabase(dbPath);
  try {
    // Idempotent: seeds four cases the first time, changes nothing after that.
    // Running it here means a fresh clone can go straight to `npm run eval`.
    loadSeedCases(db);

    const cases = listEvalCases(db, "added");
    const report = buildReport(replayAll(cases), AGENT_VERSION, new Date().toISOString());
    const reportPath = writeReport(report, reportsDir);

    const labels = Object.fromEntries(
      cases.filter((c) => c.notes !== null).map((c) => [c.id, c.notes as string]),
    );

    console.log(
      formatSummary(report, { reportPath: relative(REPO_ROOT, reportPath), labels }),
    );

    if (report.totalCases === 0) {
      // Not a failure — but a green run against an empty suite proves nothing,
      // and that is worth saying out loud rather than reporting "0 failed".
      console.log(
        "\nNo eval cases in the suite. Check for proposals waiting on you:\n" +
          `  sqlite3 ${relative(REPO_ROOT, dbPath)} ` +
          `"SELECT id, input, notes FROM eval_cases WHERE status = 'pending';"`,
      );
    }

    process.exitCode = report.failed > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

main();
