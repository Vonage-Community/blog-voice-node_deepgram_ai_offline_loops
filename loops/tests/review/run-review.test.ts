// End-to-end tests for `npm run review`.
//
// The contract worth spawning a process for: this loop always exits 0. It is an
// observation tool, not a gate — a proposal means "come look at this", never
// "the build is broken". If it ever starts exiting non-zero, a scheduled run
// would begin failing CI for noticing things, which is the opposite of the point.

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listEvalCases } from "../../src/db/eval-schema.js";
import { handoffCall, seedCalls, testDatabase, timeoutCall } from "./fixtures.js";
import { openDatabase } from "../../../src/storage/db.js";
import { ensureEvalSchema } from "../../src/db/eval-schema.js";

const execFileAsync = promisify(execFile);

const LOOPS_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = join(LOOPS_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(LOOPS_ROOT, "src", "run-review.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A database file on disk (the CLI opens by path), seeded with the given calls. */
function seededDatabase(seed: (db: ReturnType<typeof testDatabase>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "review-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "calls.db");

  const db = openDatabase(dbPath);
  ensureEvalSchema(db);
  seed(db);
  db.close();

  return dbPath;
}

async function runCli(
  dbPath: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(TSX, [ENTRY], {
      cwd: LOOPS_ROOT,
      env: { ...process.env, DB_PATH: dbPath, ...env },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? -1 };
  }
}

describe("npm run review", () => {
  it("writes proposals and exits 0", async () => {
    const dbPath = seededDatabase((db) => {
      seedCalls(db, [
        handoffCall("c1", "billing", "I want to dispute a charge"),
        handoffCall("c2", "billing", "Wrong charge on my card"),
      ]);
    });

    const { stdout, code } = await runCli(dbPath);

    expect(code).toBe(0);
    expect(stdout).toContain("Reviewed 2 calls (last 50 window)");
    expect(stdout).toContain("→ billing handoff (2 calls)");
    expect(stdout).toContain("1 proposal written — review with:");

    const db = openDatabase(dbPath);
    const written = listEvalCases(db, "pending");
    db.close();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      expectedOutcome: "handoff",
      expectedHandoffReason: "billing",
      status: "pending",
    });
  }, 30_000);

  it("exits 0 with nothing to report on an empty database", async () => {
    const dbPath = seededDatabase(() => {});

    const { stdout, code } = await runCli(dbPath);

    expect(code).toBe(0);
    expect(stdout).toContain("Reviewed 0 calls");
    expect(stdout).toContain("No new proposals written.");
  }, 30_000);

  it("honours REVIEW_WINDOW", async () => {
    const dbPath = seededDatabase((db) => {
      seedCalls(db, [
        timeoutCall("t1", "SLOW999", "2026-08-01T10:00:00.000Z"),
        timeoutCall("t2", "SLOW999", "2026-08-02T10:00:00.000Z"),
        timeoutCall("t3", "SLOW999", "2026-08-03T10:00:00.000Z"),
      ]);
    });

    // A window of 2 cannot reach the timeout threshold of 3.
    const narrow = await runCli(dbPath, { REVIEW_WINDOW: "2" });
    expect(narrow.code).toBe(0);
    expect(narrow.stdout).toContain("Reviewed 2 calls (last 2 window)");
    expect(narrow.stdout).toContain("No new proposals written.");

    const full = await runCli(dbPath, { REVIEW_WINDOW: "50" });
    expect(full.stdout).toContain("→ timeout pattern (3 calls)");
    expect(full.stdout).toContain("1 proposal written");
  }, 30_000);

  it("falls back to the default window when REVIEW_WINDOW is nonsense", async () => {
    const dbPath = seededDatabase(() => {});

    const { stdout, code } = await runCli(dbPath, { REVIEW_WINDOW: "not-a-number" });

    expect(code).toBe(0);
    expect(stdout).toContain("(last 50 window)");
  }, 30_000);

  it("never auto-approves — a second run leaves the queue untouched", async () => {
    const dbPath = seededDatabase((db) => {
      seedCalls(db, [
        handoffCall("c1", "billing", "I want to dispute a charge"),
        handoffCall("c2", "billing", "Wrong charge on my card"),
      ]);
    });

    await runCli(dbPath);
    const second = await runCli(dbPath);

    expect(second.code).toBe(0);
    expect(second.stdout).toContain("No new proposals written.");

    const db = openDatabase(dbPath);
    const all = listEvalCases(db);
    db.close();

    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("pending");
  }, 30_000);
});
