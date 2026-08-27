// -----------------------------------------------------------------------------
// The eval report — the run's two outputs.
//
// A regression suite that only prints to a terminal tells you about right now.
// One that only writes JSON tells you nothing while you are watching it. So
// every run produces both: a summary a human reads at a glance, and a file the
// next run can be compared against.
//
// The two share one clock. `runAt` is a full ISO timestamp; the filename stamp
// and the console header are both sliced from that same string, in UTC. Getting
// the filename from local time while `runAt` is UTC would put two different
// times on one report — a small thing that makes a report archive unreadable
// six months later.
// -----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalResult } from "./replay.js";

export interface EvalReport {
  runAt: string;
  agentVersion: string;
  totalCases: number;
  passed: number;
  failed: number;
  results: EvalResult[];
}

/** Tally the results into the report shape. Pure — the caller supplies the clock. */
export function buildReport(
  results: EvalResult[],
  agentVersion: string,
  runAt: string,
): EvalReport {
  const passed = results.filter((r) => r.passed).length;
  return {
    runAt,
    agentVersion,
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/**
 * `eval-2026-08-27T1400.json` — sortable, and unambiguous about which run it was.
 * Minute precision is deliberate: a second run in the same minute overwrites the
 * first, which is the right behaviour for a suite you re-run while fixing a
 * failure. You want the fix's report, not fourteen of them.
 */
export function reportFileName(runAt: string): string {
  return `eval-${runAt.slice(0, 16).replace(/:/g, "")}.json`;
}

/** Write the report and return the absolute path. Creates the directory if needed. */
export function writeReport(report: EvalReport, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, reportFileName(report.runAt));
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export interface SummaryOptions {
  /** Path to show on the last line — display form, not necessarily absolute. */
  reportPath?: string;
  /** Per-case human labels (the eval case's notes). Falls back to the input string. */
  labels?: Record<string, string>;
}

/**
 * Render the run as the block a human reads.
 *
 * A failing case gets a second line naming the disagreement. When the outcomes
 * match but something else did not — the right outcome reached for the wrong
 * reason, or without calling the tool — that line would read
 * "expected: completed | actual: completed", so the specific reason is printed
 * underneath it. A report that makes a real failure look like a formatting bug
 * is worse than no report.
 */
export function formatSummary(report: EvalReport, options: SummaryOptions = {}): string {
  const { reportPath, labels = {} } = options;
  const header = `Eval run — ${report.agentVersion} — ${report.runAt.slice(0, 16)}`;
  const lines = [header, "─".repeat(header.length)];

  for (const result of report.results) {
    const label = truncate(labels[result.caseId] ?? result.input);
    lines.push(`${result.passed ? "✓" : "✗"} ${result.caseId}  ${label}`);

    if (!result.passed) {
      lines.push(
        `    expected: ${describe(result.expected)} | actual: ${describe(result.actual)}`,
      );
      if (result.expected.outcome === result.actual.outcome && result.failureReason) {
        lines.push(`    ${result.failureReason}`);
      }
    }
  }

  lines.push("");
  lines.push(`${report.passed} passed, ${report.failed} failed`);
  if (reportPath) lines.push(`Report saved to ${reportPath}`);

  return lines.join("\n");
}

/**
 * Keep one case to one terminal line. A hand-authored case's notes are a short
 * phrase, but a proposal's notes are a full sentence of evidence — printed whole,
 * they wrap and the tick column stops being scannable. The report JSON keeps the
 * untruncated text.
 */
function truncate(text: string, max = 64): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "handoff (billing)" or just "completed". */
function describe(observation: { outcome: string; handoffReason?: string }): string {
  return observation.handoffReason
    ? `${observation.outcome} (${observation.handoffReason})`
    : observation.outcome;
}
