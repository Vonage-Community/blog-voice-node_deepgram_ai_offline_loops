// -----------------------------------------------------------------------------
// The transcript review loop — read stored calls, propose eval cases, stop.
//
// Its only side effect is writing rows to `eval_cases` with
// `status = 'awaiting_review'`. It never approves anything, never edits an
// existing case, and never touches a prompt, a tool, or any live configuration.
// The loop proposes; humans decide. That boundary is the reason this is safe to
// run against the production database while a call is in progress.
//
// It reads two tables and no others: `call_records` for evidence, `eval_cases`
// to avoid proposing something already on someone's desk.
// -----------------------------------------------------------------------------

import type { Database as DatabaseType } from "better-sqlite3";
import type { CallRecord } from "../../../src/storage/db.js";
import { readCallRecord } from "../../../src/storage/call-records.js";
import { insertEvalCase } from "../db/eval-schema.js";
import { findPatterns, type Pattern } from "./pattern-finder.js";

/** Calls to look back over when REVIEW_WINDOW is not set. */
export const DEFAULT_WINDOW = 50;

/** One pattern's fate: written as a proposal, or skipped because it is covered. */
export interface ProposalOutcome {
  pattern: Pattern;
  /** The id written, or null when skipped. */
  proposalId: string | null;
  skippedReason: string | null;
}

export interface ReviewSummary {
  runAt: string;
  windowSize: number;
  callsReviewed: number;
  outcomes: ProposalOutcome[];
  proposalsWritten: number;
}

export interface ReviewOptions {
  windowSize?: number;
  /** Injectable clock — tests need deterministic ids and timestamps. */
  now?: () => Date;
}

/**
 * Review the recent call window and write proposals for anything new.
 *
 * Returns everything the CLI needs to print, including the patterns that were
 * *not* written. A run that finds a pattern and skips it is a meaningful
 * result — "this is still happening, and it is still sitting in your queue" —
 * and hiding it would make the loop look like it stopped noticing.
 */
export function reviewTranscripts(
  db: DatabaseType,
  options: ReviewOptions = {},
): ReviewSummary {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW;
  const now = options.now ?? (() => new Date());
  const runAt = now().toISOString();

  const records = readRecentCalls(db, windowSize);
  const patterns = findPatterns(records);

  // Ids embed a millisecond timestamp, which is not unique within a run: two
  // patterns of the same type land in the same millisecond and collide. The
  // insert helper uses ON CONFLICT DO NOTHING, so a collision would be dropped
  // in silence — the exact failure mode the schema notes warn about. Track what
  // this run has issued and disambiguate before writing, not after.
  const issuedIds = new Set<string>();
  const outcomes: ProposalOutcome[] = [];

  for (const pattern of patterns) {
    const covered = existingCoverage(db, pattern);
    if (covered) {
      outcomes.push({ pattern, proposalId: null, skippedReason: covered });
      continue;
    }

    const id = uniqueId(db, pattern, now().getTime(), issuedIds);
    const written = insertEvalCase(db, {
      id,
      createdAt: runAt,
      input: pattern.input,
      expectedOutcome: pattern.expected.outcome,
      expectedHandoffReason: pattern.expected.handoffReason,
      expectedFallback: pattern.expected.fallback,
      expectedToolCalled: pattern.expected.toolCalled,
      mockToolResult: pattern.expected.mockToolResult,
      // Never anything else. A loop that can approve its own proposals is a loop
      // that can change what "correct" means without a human in the room.
      status: "awaiting_review",
      notes: pattern.description,
      // The one representative call keeps `source_call_id` meaningful; the whole
      // group is the evidence a reviewer needs to judge the proposal.
      sourceCallId: pattern.callIds[0] ?? null,
      sourceCallIds: pattern.callIds,
    });

    if (!written) {
      // Unreachable given the id disambiguation above, and worth saying out loud
      // rather than reporting a proposal that does not exist.
      throw new Error(`proposal id collision on "${id}" — refusing to report a silent drop`);
    }

    outcomes.push({ pattern, proposalId: id, skippedReason: null });
  }

  return {
    runAt,
    windowSize,
    callsReviewed: records.length,
    outcomes,
    proposalsWritten: outcomes.filter((o) => o.proposalId !== null).length,
  };
}

/**
 * Load the most recent calls, oldest first.
 *
 * Two ids-then-fetch queries rather than one join, because `readCallRecord` is
 * Part 1's own deserializer: a hand-rolled row parser here would drift from the
 * live schema the first time a column changed, and the loop would start
 * reviewing a slightly wrong picture of what happened. Fifty point lookups cost
 * nothing at this size.
 *
 * The window is taken newest-first (that is what "the last N calls" means) and
 * then reversed, so evidence lists and representative utterances read in call
 * order and stay stable as the window fills.
 */
export function readRecentCalls(db: DatabaseType, limit: number): CallRecord[] {
  const rows = db
    .prepare(
      "SELECT call_id FROM call_records ORDER BY started_at DESC, call_id DESC LIMIT ?",
    )
    .all(limit) as Array<{ call_id: string }>;

  return rows
    .map((row) => readCallRecord(db, row.call_id))
    .filter((record): record is CallRecord => record !== null)
    .reverse();
}

/**
 * Is this pattern already covered by a case a human has seen?
 *
 * Two statuses count as covered. `awaiting_review` is the rule as specified:
 * do not stack duplicates in a queue somebody has not worked through yet.
 * `approved` is the same argument one step later — the case is already in the
 * suite, so re-proposing it is pure noise. Only `rejected` lets a pattern come
 * back, and that is deliberate: a human said "not this", and if the behaviour
 * keeps happening they should get the chance to say it again with fresh
 * evidence rather than have the loop quietly agree with them forever.
 *
 * Identity is (input, expected_outcome) — what the case asserts — not the
 * detector that produced it. That is what makes the overlap between detector 1
 * and detector 3 resolve itself.
 */
function existingCoverage(db: DatabaseType, pattern: Pattern): string | null {
  const row = db
    .prepare(
      `SELECT id, status FROM eval_cases
        WHERE input = ? AND expected_outcome = ? AND status IN ('awaiting_review', 'approved')
        LIMIT 1`,
    )
    .get(pattern.input, pattern.expected.outcome) as
    | { id: string; status: string }
    | undefined;

  if (!row) return null;
  return row.status === "approved"
    ? `already covered by approved case ${row.id}`
    : `already proposed as ${row.id}`;
}

/**
 * `proposal-<epoch-ms>-<pattern-type>`, with a numeric suffix if that is taken.
 *
 * The timestamp makes the id look unique. It is not, in two ways, and both are
 * reachable: two patterns of the same type inside one run share the millisecond,
 * and a re-proposal after a rejection regenerates the same base id as the
 * rejected row still sitting in the table. Either way `insertEvalCase` would hit
 * ON CONFLICT DO NOTHING and drop the proposal in silence, so the check covers
 * both this run and what is already stored.
 */
function uniqueId(
  db: DatabaseType,
  pattern: Pattern,
  epochMs: number,
  issued: Set<string>,
): string {
  const base = `proposal-${epochMs}-${pattern.type}`;
  const taken = (id: string): boolean => issued.has(id) || idExists(db, id);

  let id = base;
  for (let n = 2; taken(id); n += 1) id = `${base}-${n}`;
  issued.add(id);
  return id;
}

function idExists(db: DatabaseType, id: string): boolean {
  return db.prepare("SELECT 1 FROM eval_cases WHERE id = ?").get(id) !== undefined;
}

// --- Console output ---------------------------------------------------------

export interface SummaryOptions {
  /** Database path as it should appear in the copy-pasteable sqlite3 commands. */
  dbPath?: string;
}

/** Render the run for a human reading the terminal. */
export function formatReviewSummary(
  summary: ReviewSummary,
  options: SummaryOptions = {},
): string {
  const dbPath = options.dbPath ?? "../data/calls.db";
  const header = `Transcript Review — ${summary.runAt.slice(0, 16)}`;
  const lines = [header, "─".repeat(header.length)];

  lines.push(
    `Reviewed ${summary.callsReviewed} call${summary.callsReviewed === 1 ? "" : "s"} ` +
      `(last ${summary.windowSize} window)`,
  );
  lines.push("");
  lines.push(`Patterns found: ${summary.outcomes.length}`);

  for (const outcome of summary.outcomes) {
    const { pattern } = outcome;
    lines.push("");
    const n = pattern.callIds.length;
    lines.push(`→ ${pattern.label} (${n} call${n === 1 ? "" : "s"})`);
    if (outcome.proposalId) {
      lines.push(`  Proposed eval case: ${outcome.proposalId}`);
    } else {
      lines.push(`  Skipped — ${outcome.skippedReason}`);
    }
    lines.push(`  Input: "${pattern.input}"`);
    lines.push(`  Expected: ${describeExpectation(pattern)}`);
  }

  lines.push("");
  if (summary.proposalsWritten === 0) {
    lines.push("No new proposals written.");
  } else {
    lines.push(`${summary.proposalsWritten} proposal${
      summary.proposalsWritten === 1 ? "" : "s"
    } written — review with:`);
    lines.push(
      `  sqlite3 ${dbPath} \\\n    "SELECT id, notes, status FROM eval_cases ` +
        `WHERE status = 'awaiting_review';"`,
    );
    lines.push("");
    lines.push("Approve a proposal:");
    lines.push(
      `  sqlite3 ${dbPath} \\\n    "UPDATE eval_cases SET status = 'approved' ` +
        `WHERE id = '${firstProposalId(summary)}';"`,
    );
  }

  return lines.join("\n");
}

function describeExpectation(pattern: Pattern): string {
  const { outcome, handoffReason } = pattern.expected;
  return handoffReason ? `${outcome} (${handoffReason})` : outcome;
}

function firstProposalId(summary: ReviewSummary): string {
  return summary.outcomes.find((o) => o.proposalId)?.proposalId ?? "proposal-id";
}
