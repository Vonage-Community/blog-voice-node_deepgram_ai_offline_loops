import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  formatSummary,
  reportFileName,
  writeReport,
  type EvalReport,
} from "../../src/runner/report.js";
import type { EvalResult } from "../../src/runner/replay.js";

const RUN_AT = "2026-08-27T14:00:12.345Z";

const passing: EvalResult = {
  caseId: "eval-001",
  input: "Where is order A1001?",
  passed: true,
  expected: { outcome: "completed", fallbackUsed: false, toolCalled: true },
  actual: { outcome: "completed", fallbackUsed: false, toolCalled: true },
};

const failing: EvalResult = {
  caseId: "eval-003",
  input: "I want to dispute a charge",
  passed: false,
  expected: {
    outcome: "handoff",
    handoffReason: "billing",
    fallbackUsed: false,
    toolCalled: false,
  },
  actual: { outcome: "completed", fallbackUsed: false, toolCalled: true },
  failureReason: 'expected outcome "handoff", got "completed"',
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-report-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("buildReport", () => {
  it("counts passes and failures", () => {
    const report = buildReport([passing, failing, passing], "order-status-v1", RUN_AT);

    expect(report).toMatchObject({
      runAt: RUN_AT,
      agentVersion: "order-status-v1",
      totalCases: 3,
      passed: 2,
      failed: 1,
    });
    expect(report.results).toHaveLength(3);
  });

  it("reports an empty suite as zero cases, not as a failure", () => {
    expect(buildReport([], "order-status-v1", RUN_AT)).toMatchObject({
      totalCases: 0,
      passed: 0,
      failed: 0,
    });
  });
});

describe("reportFileName", () => {
  it("stamps to the minute, in the same UTC clock as runAt", () => {
    expect(reportFileName(RUN_AT)).toBe("eval-2026-08-27T1400.json");
  });

  it("keeps names sortable across hours and days", () => {
    const names = [
      reportFileName("2026-08-27T09:05:00.000Z"),
      reportFileName("2026-08-27T14:00:00.000Z"),
      reportFileName("2026-09-01T08:00:00.000Z"),
    ];
    expect([...names].sort()).toEqual(names);
  });
});

describe("writeReport", () => {
  it("creates the directory and writes the report as JSON", () => {
    const dir = join(tempDir(), "reports"); // deliberately does not exist yet
    const report = buildReport([passing, failing], "order-status-v1", RUN_AT);

    const path = writeReport(report, dir);

    expect(path).toBe(join(dir, "eval-2026-08-27T1400.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
  });

  it("overwrites within the same minute rather than piling up files", () => {
    const dir = tempDir();
    writeReport(buildReport([failing], "order-status-v1", RUN_AT), dir);
    const path = writeReport(buildReport([passing], "order-status-v1", RUN_AT), dir);

    const written = JSON.parse(readFileSync(path, "utf8")) as EvalReport;
    expect(written.passed).toBe(1);
    expect(written.failed).toBe(0);
  });
});

describe("formatSummary", () => {
  it("renders the header, a tick per case, and the totals", () => {
    const report = buildReport([passing, failing], "order-status-v1", RUN_AT);

    const summary = formatSummary(report, {
      reportPath: "loops/reports/eval-2026-08-27T1400.json",
      labels: { "eval-001": "happy path — order found" },
    });

    expect(summary).toBe(
      [
        "Eval run — order-status-v1 — 2026-08-27T14:00",
        "─".repeat("Eval run — order-status-v1 — 2026-08-27T14:00".length),
        "✓ eval-001  happy path — order found",
        "✗ eval-003  I want to dispute a charge",
        "    expected: handoff (billing) | actual: completed",
        "",
        "1 passed, 1 failed",
        "Report saved to loops/reports/eval-2026-08-27T1400.json",
      ].join("\n"),
    );
  });

  it("truncates a long label so one case stays on one line", () => {
    // Proposal notes are a full sentence of evidence; printed whole they wrap
    // and the tick column stops being scannable.
    const long = "x".repeat(200);
    const summary = formatSummary(buildReport([passing], "order-status-v1", RUN_AT), {
      labels: { "eval-001": long },
    });

    const caseLine = summary.split("\n").find((l) => l.startsWith("✓"))!;
    expect(caseLine.length).toBeLessThan(90);
    expect(caseLine.endsWith("…")).toBe(true);
  });

  it("falls back to the input when a case has no label", () => {
    const summary = formatSummary(buildReport([passing], "order-status-v1", RUN_AT));
    expect(summary).toContain("✓ eval-001  Where is order A1001?");
  });

  it("spells out the reason when the outcomes match but something else did not", () => {
    // Without this line the failure would read "completed | actual: completed"
    // and look like a formatting bug rather than a real regression.
    const sameOutcome: EvalResult = {
      caseId: "eval-009",
      input: "Where is order A1001?",
      passed: false,
      expected: { outcome: "completed", fallbackUsed: false, toolCalled: true },
      actual: { outcome: "completed", fallbackUsed: false, toolCalled: false },
      failureReason: "expected toolCalled true, got false",
    };

    const summary = formatSummary(buildReport([sameOutcome], "order-status-v1", RUN_AT));

    expect(summary).toContain("    expected: completed | actual: completed");
    expect(summary).toContain("    expected toolCalled true, got false");
  });

  it("omits the report path line when there is no path to show", () => {
    const summary = formatSummary(buildReport([passing], "order-status-v1", RUN_AT));
    expect(summary).not.toContain("Report saved to");
    expect(summary.trimEnd().endsWith("1 passed, 0 failed")).toBe(true);
  });
});
