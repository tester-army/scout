import { describe, expect, it } from "vitest";
import type { CoverageSummary } from "./coverage.js";
import { createFinding, type Finding } from "./findings.js";
import {
  buildReportJson,
  buildReportMarkdown,
  countAtOrAboveThreshold,
  countBySeverity,
} from "./report.js";

const coverage: CoverageSummary = {
  totalOperations: 4,
  exercised: 2,
  validated: 1,
  coveragePercent: 50,
  requestTotals: { recorded: 2, matched: 2, probes: 1 },
  operations: [],
  untouched: ["GET /a", "POST /b"],
};

const provenance = {
  runId: "run-1",
  baseUrl: "https://api.example.com",
  requestTotals: { session: 2, recorded: 2, probes: 1, run: 1 },
  stopReason: "completed" as const,
};

function finding(severity: Finding["severity"], title: string): Finding {
  return createFinding({
    source: "sweep",
    severity,
    category: "contract-violation",
    endpoint: "GET /pets",
    title,
  });
}

describe("countBySeverity", () => {
  it("counts each severity", () => {
    const counts = countBySeverity([
      finding("high", "a"),
      finding("high", "b"),
      finding("low", "c"),
    ]);
    expect(counts.high).toBe(2);
    expect(counts.low).toBe(1);
    expect(counts.critical).toBe(0);
  });
});

describe("countAtOrAboveThreshold", () => {
  it("includes findings at or above the threshold", () => {
    const findings = [finding("critical", "a"), finding("high", "b"), finding("low", "c")];
    expect(countAtOrAboveThreshold(findings, "high")).toBe(2);
    expect(countAtOrAboveThreshold(findings, "critical")).toBe(1);
    expect(countAtOrAboveThreshold(findings, "info")).toBe(3);
  });

  it("does not gate CI on unconfirmed candidates", () => {
    const candidate = { ...finding("critical", "candidate"), status: "candidate" as const };
    expect(countAtOrAboveThreshold([candidate], "high")).toBe(0);
  });

  it("does not gate CI on dismissed findings", () => {
    const dismissed = { ...finding("critical", "dismissed"), status: "dismissed" as const };
    expect(countAtOrAboveThreshold([dismissed], "high")).toBe(0);
  });
});

describe("buildReportJson", () => {
  it("passes when no findings meet the threshold", () => {
    const report = buildReportJson({
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      findings: [finding("low", "minor")],
      coverage,
      severityThreshold: "high",
      provenance,
    });

    expect(report.summary.passed).toBe(true);
    expect(report.summary.findingsAtOrAboveThreshold).toBe(0);
  });

  it("fails when a finding meets the threshold", () => {
    const report = buildReportJson({
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      findings: [finding("critical", "bad")],
      coverage,
      severityThreshold: "high",
      provenance,
    });

    expect(report.summary.passed).toBe(false);
  });

  it("fails incomplete, under-covered, or unprobed runs", () => {
    const report = buildReportJson({
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      findings: [],
      coverage,
      severityThreshold: "high",
      minCoverage: 80,
      requireProbes: true,
      provenance: {
        ...provenance,
        requestTotals: { session: 2, recorded: 2, probes: 0, run: 1 },
        stopReason: "rate-limited",
      },
    });

    expect(report.summary.passed).toBe(false);
    expect(report.summary.complete).toBe(false);
    expect(report.summary.incomplete).toBe(true);
    expect(report.summary.incompleteReasons).toEqual([
      "sweep-rate-limited",
      "coverage-below-minimum",
      "no-probes-recorded",
    ]);
    expect(report.provenance.runId).toBe("run-1");
    expect(report.coverage).not.toHaveProperty("operations");
  });

  it("assigns distinct CI exit codes for findings vs completeness gates", () => {
    const base = {
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      coverage,
      severityThreshold: "high" as const,
      provenance,
    };

    // Clean run: pass, exit 0.
    expect(buildReportJson({ ...base, findings: [] }).summary.ciExitCode).toBe(0);

    // Findings gate fails -> exit 1 (takes precedence).
    const findingsFail = buildReportJson({ ...base, findings: [finding("critical", "bad")] });
    expect(findingsFail.summary.findingsGatePassed).toBe(false);
    expect(findingsFail.summary.ciExitCode).toBe(1);

    // Only completeness fails -> exit 3.
    const completenessFail = buildReportJson({ ...base, findings: [], minCoverage: 80 });
    expect(completenessFail.summary.findingsGatePassed).toBe(true);
    expect(completenessFail.summary.completenessGatePassed).toBe(false);
    expect(completenessFail.summary.ciExitCode).toBe(3);

    // Both fail -> findings code wins (1).
    const bothFail = buildReportJson({
      ...base,
      findings: [finding("critical", "bad")],
      minCoverage: 80,
    });
    expect(bothFail.summary.ciExitCode).toBe(1);
  });

  it("uses exact coverage for a 100 percent gate", () => {
    const report = buildReportJson({
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      findings: [],
      coverage: {
        ...coverage,
        totalOperations: 200,
        exercised: 199,
        coveragePercent: 100,
      },
      severityThreshold: "high",
      minCoverage: 100,
      provenance,
    });
    expect(report.summary.incompleteReasons).toContain("coverage-below-minimum");
  });
});

describe("buildReportMarkdown", () => {
  it("renders findings and coverage", () => {
    const md = buildReportMarkdown({
      title: "API",
      version: "1.0.0",
      specSource: "spec.json",
      findings: [finding("high", "Missing pagination")],
      coverage,
      severityThreshold: "high",
      provenance,
    });

    expect(md).toContain("# Scout report: API `1.0.0`");
    expect(md).toContain("Missing pagination");
    expect(md).toContain("Untested operations");
    expect(md).toContain("FAIL");
  });
});
