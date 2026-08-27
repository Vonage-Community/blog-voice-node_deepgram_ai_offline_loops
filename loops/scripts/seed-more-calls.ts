// -----------------------------------------------------------------------------
// `npm run seed-calls` — load demo call records into the shared database.
//
// The loops need evidence to work on, and a reader who has not yet wired up a
// phone number has none. These ten synthetic calls give both loops something to
// find on the first run: three `returns` handoffs, two `billing` handoffs, three
// tool timeouts, and two calls where the policy refused a second lookup.
//
// The records are written in exactly the shape Part 1 writes — verified against
// the real database, not inferred from the types. That matters more than it
// sounds: the review loop's timeout detector matches `result === "timeout"`, the
// bare string Part 1 stores. Seed a plausible-looking `{ kind: "timeout" }` or
// `"blocked"` instead and the detector finds nothing, forever, without an error.
// -----------------------------------------------------------------------------

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { openDatabase, type CallRecord } from "../../src/storage/db.js";
import { writeCallRecord } from "../../src/storage/call-records.js";

const LOOPS_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Committed fixture input — not the generated `data/calls.db` one level up. */
export const SEED_CALLS_PATH = fileURLToPath(
  new URL("../data/seed-calls.json", import.meta.url),
);

export interface SeedResult {
  inserted: string[];
  skipped: string[];
}

/** Read and lightly validate the committed seed file. */
export function readSeedCalls(path: string = SEED_CALLS_PATH): CallRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of call records`);
  }
  for (const [index, record] of parsed.entries()) {
    const callId = (record as { callId?: unknown }).callId;
    if (typeof callId !== "string" || callId.length === 0) {
      throw new Error(`${path}[${index}]: missing callId`);
    }
  }
  return parsed as CallRecord[];
}

/**
 * Insert the seed calls, skipping any `call_id` already present.
 *
 * Note what this is *not*: `INSERT OR IGNORE`. That clause ignores every
 * constraint violation, not just the primary key, so a malformed record would
 * disappear and be counted as an ordinary duplicate — the same trap the eval
 * schema hit. An explicit existence check keeps the skip meaning exactly one
 * thing, and lets the insert itself go through Part 1's own `writeCallRecord`
 * rather than a second column list here that could drift from the live schema.
 *
 * The existence check also protects real evidence: if a real call somehow shared
 * an id, seeding would never overwrite it (`writeCallRecord` is INSERT OR
 * REPLACE on its own).
 */
export function seedCalls(db: DatabaseType, records: CallRecord[]): SeedResult {
  const exists = db.prepare("SELECT 1 FROM call_records WHERE call_id = ?");
  const result: SeedResult = { inserted: [], skipped: [] };

  const run = db.transaction(() => {
    for (const record of records) {
      if (exists.get(record.callId)) {
        result.skipped.push(record.callId);
        continue;
      }
      writeCallRecord(db, record);
      result.inserted.push(record.callId);
    }
  });
  run();

  return result;
}

function main(): void {
  const dbPath = resolve(LOOPS_ROOT, process.env.DB_PATH ?? "../data/calls.db");

  // Part 1's opener, so seeding a fresh clone creates `call_records` with the
  // live DDL rather than something this script invented.
  const db = openDatabase(dbPath);
  try {
    const records = readSeedCalls();
    const { inserted, skipped } = seedCalls(db, records);

    console.log(
      `${inserted.length} inserted, ${skipped.length} skipped ` +
        `— ${relative(LOOPS_ROOT, dbPath)}`,
    );
    if (inserted.length > 0) {
      console.log("\nNext: npm run review");
    }
  } finally {
    db.close();
  }
}

// Only run when invoked as a script, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
