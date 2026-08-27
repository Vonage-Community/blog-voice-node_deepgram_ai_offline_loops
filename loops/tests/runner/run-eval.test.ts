// End-to-end tests for the `npm run eval` entry point.
//
// These spawn the real CLI as a child process, because the thing under test is
// the process exit code — the contract CI depends on. A test that imported a
// function and checked its return value would not catch a CLI that computes the
// right answer and then exits 0 regardless.
//
// Each test gets its own temp database and temp reports directory, so nothing
// here touches the real data/calls.db.

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { insertEvalCase, openEvalDatabase } from "../../src/db/eval-schema.js";
import type { EvalReport } from "../../src/runner/report.js";

const execFileAsync = promisify(execFile);

const LOOPS_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = join(LOOPS_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(LOOPS_ROOT, "src", "run-eval.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A scratch database + reports directory for one CLI run. */
function workspace(): { dbPath: string; reportsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
  tempDirs.push(dir);
  return { dbPath: join(dir, "calls.db"), reportsDir: join(dir, "reports") };
}

interface RunResult {
  stdout: string;
  code: number;
}

async function runCli(env: { dbPath: string; reportsDir: string }): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(TSX, [ENTRY], {
      cwd: LOOPS_ROOT,
      env: { ...process.env, DB_PATH: env.dbPath, REPORTS_DIR: env.reportsDir },
    });
    return { stdout, code: 0 };
  } catch (err) {
    // execFile rejects on a non-zero exit; the payload still carries stdout.
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? -1 };
  }
}

function readOnlyReport(reportsDir: string): EvalReport {
  const files = readdirSync(reportsDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(reportsDir, files[0]!), "utf8")) as EvalReport;
}

describe("npm run eval", () => {
  it("seeds an empty database, passes all four seed cases, and exits 0", async () => {
    const ws = workspace();

    const { stdout, code } = await runCli(ws);

    expect(code).toBe(0);
    expect(stdout).toContain("4 passed, 0 failed");
    expect(stdout).toContain("Eval run — order-status-v1 —");

    const report = readOnlyReport(ws.reportsDir);
    expect(report).toMatchObject({ totalCases: 4, passed: 4, failed: 0 });
    expect(report.results.map((r) => r.caseId)).toEqual([
      "seed-001",
      "seed-002",
      "seed-003",
      "seed-004",
    ]);
  }, 30_000);

  it("exits 1 when a case fails, so CI catches the regression", async () => {
    const ws = workspace();

    // An approved case that cannot pass: an order-status question expected to
    // hand off. Replay will complete it instead.
    const db = openEvalDatabase(ws.dbPath);
    insertEvalCase(db, {
      id: "regression-001",
      createdAt: "2026-08-27T09:00:00.000Z",
      input: "Where is order A1001?",
      expectedOutcome: "handoff",
      expectedHandoffReason: "billing",
      expectedFallback: false,
      expectedToolCalled: false,
      status: "approved",
      notes: "deliberately wrong expectation",
    });
    db.close();

    const { stdout, code } = await runCli(ws);

    expect(code).toBe(1);
    expect(stdout).toContain("4 passed, 1 failed");
    expect(stdout).toContain("✗ regression-001  deliberately wrong expectation");
    expect(stdout).toContain("expected: handoff (billing) | actual: completed");

    const report = readOnlyReport(ws.reportsDir);
    expect(report.failed).toBe(1);
    const failure = report.results.find((r) => r.caseId === "regression-001");
    expect(failure?.failureReason).toBe('expected outcome "handoff", got "completed"');
  }, 30_000);

  it("ignores cases that are not approved", async () => {
    const ws = workspace();

    const db = openEvalDatabase(ws.dbPath);
    // A proposal the review loop would have written, and a rejected case. A
    // failing proposal must not be able to break the build before a human has
    // agreed it is a real expectation.
    insertEvalCase(db, {
      id: "proposal-001",
      createdAt: "2026-08-27T09:00:00.000Z",
      input: "Where is order A1001?",
      expectedOutcome: "handoff",
      expectedFallback: false,
      expectedToolCalled: false,
      status: "awaiting_review",
    });
    insertEvalCase(db, {
      id: "rejected-001",
      createdAt: "2026-08-27T09:00:00.000Z",
      input: "Where is order A1001?",
      expectedOutcome: "fallback",
      expectedFallback: true,
      expectedToolCalled: true,
      status: "rejected",
    });
    db.close();

    const { stdout, code } = await runCli(ws);

    expect(code).toBe(0);
    expect(stdout).toContain("4 passed, 0 failed");
    expect(stdout).not.toContain("proposal-001");
    expect(stdout).not.toContain("rejected-001");
  }, 30_000);

  it("says so when the approved suite is empty instead of reporting a green run", async () => {
    const ws = workspace();

    // Seed, then reject everything — an empty approved suite.
    await runCli(ws);
    const db = openEvalDatabase(ws.dbPath);
    db.prepare("UPDATE eval_cases SET status = 'rejected'").run();
    db.close();
    rmSync(ws.reportsDir, { recursive: true, force: true });

    const { stdout, code } = await runCli(ws);

    expect(code).toBe(0);
    expect(stdout).toContain("0 passed, 0 failed");
    expect(stdout).toContain("No approved eval cases found");
    expect(readOnlyReport(ws.reportsDir).totalCases).toBe(0);
  }, 30_000);
});
