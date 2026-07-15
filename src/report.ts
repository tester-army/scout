import type { CoverageSummary } from "./coverage.js";
import {
  FINDING_SEVERITIES,
  severityRank,
  type Finding,
  type FindingSeverity,
} from "./findings.js";
import type { SweepStopReason } from "./sweep-engine.js";

export type ReportProvenance = {
  runId: string;
  baseUrl: string;
  requestTotals: {
    session: number;
    recorded: number;
    probes: number;
    run: number;
  };
  stopReason: Exclude<SweepStopReason, "dry-run"> | "not-run";
};

export type ReportInput = {
  title: string;
  version: string;
  specSource: string;
  findings: Finding[];
  coverage: CoverageSummary;
  severityThreshold: FindingSeverity;
  minCoverage?: number;
  requireProbes?: boolean;
  provenance: ReportProvenance;
};

export type ReportCoverage = Omit<CoverageSummary, "operations">;

export type ReportJson = {
  summary: {
    passed: boolean;
    complete: boolean;
    incomplete: boolean;
    incompleteReasons: string[];
    totalFindings: number;
    candidateFindings: number;
    dismissedFindings: number;
    bySeverity: Record<FindingSeverity, number>;
    coveragePercent: number;
    exercised: number;
    totalOperations: number;
    findingsAtOrAboveThreshold: number;
    severityThreshold: FindingSeverity;
    minCoverage: number;
    requireProbes: boolean;
  };
  provenance: ReportProvenance;
  api: { title: string; version: string; specSource: string };
  generatedAt: string;
  findings: Finding[];
  coverage: ReportCoverage;
};

/** Counts findings by severity. */
export function countBySeverity(findings: Finding[]): Record<FindingSeverity, number> {
  const counts = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<
    FindingSeverity,
    number
  >;
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Number of findings at or above the given severity threshold. */
export function countAtOrAboveThreshold(findings: Finding[], threshold: FindingSeverity): number {
  const min = severityRank(threshold);
  return findings.filter(
    (finding) =>
      finding.status !== "candidate" &&
      finding.status !== "dismissed" &&
      severityRank(finding.severity) >= min,
  ).length;
}

/** Returns every reason a report run is incomplete for its configured gate. */
export function reportIncompleteReasons(input: ReportInput): string[] {
  const minCoverage = input.minCoverage ?? 0;
  const reasons: string[] = [];
  if (input.provenance.stopReason === "not-run") {
    reasons.push("no-sweep-run");
  } else if (input.provenance.stopReason !== "completed") {
    reasons.push(`sweep-${input.provenance.stopReason}`);
  }
  if (input.provenance.requestTotals.session !== input.provenance.requestTotals.recorded) {
    reasons.push("request-log-incomplete");
  }
  const exactCoverage =
    input.coverage.totalOperations === 0
      ? 0
      : (input.coverage.exercised / input.coverage.totalOperations) * 100;
  if (exactCoverage < minCoverage) reasons.push("coverage-below-minimum");
  if (input.requireProbes && input.provenance.requestTotals.probes === 0) {
    reasons.push("no-probes-recorded");
  }
  return reasons;
}

/** Builds the machine-readable report payload. */
export function buildReportJson(input: ReportInput): ReportJson {
  const bySeverity = countBySeverity(input.findings);
  const findingsAtOrAboveThreshold = countAtOrAboveThreshold(
    input.findings,
    input.severityThreshold,
  );
  const minCoverage = input.minCoverage ?? 0;
  const requireProbes = input.requireProbes ?? false;
  const incompleteReasons = reportIncompleteReasons({ ...input, minCoverage, requireProbes });
  const complete = incompleteReasons.length === 0;
  const { operations: _operations, ...coverage } = input.coverage;

  return {
    summary: {
      passed: findingsAtOrAboveThreshold === 0 && complete,
      complete,
      incomplete: !complete,
      incompleteReasons,
      totalFindings: input.findings.length,
      candidateFindings: input.findings.filter((finding) => finding.status === "candidate").length,
      dismissedFindings: input.findings.filter((finding) => finding.status === "dismissed").length,
      bySeverity,
      coveragePercent: input.coverage.coveragePercent,
      exercised: input.coverage.exercised,
      totalOperations: input.coverage.totalOperations,
      findingsAtOrAboveThreshold,
      severityThreshold: input.severityThreshold,
      minCoverage,
      requireProbes,
    },
    provenance: input.provenance,
    api: { title: input.title, version: input.version, specSource: input.specSource },
    generatedAt: new Date().toISOString(),
    findings: input.findings,
    coverage,
  };
}

function severityEmoji(severity: FindingSeverity): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
    default:
      return "⚪";
  }
}

/** Renders a Markdown report suitable for PR comments and step summaries. */
export function buildReportMarkdown(input: ReportInput): string {
  const report = buildReportJson(input);
  const lines: string[] = [];

  lines.push(`# Scout report: ${input.title} \`${input.version}\``);
  lines.push("");
  lines.push(
    `**Result:** ${report.summary.passed ? "PASS" : "FAIL"} · **Run:** ${report.summary.complete ? "complete" : `incomplete (${report.summary.incompleteReasons.join(", ")})`} · **Stop:** ${report.provenance.stopReason}`,
  );
  lines.push("");
  lines.push(
    `**Findings:** ${report.summary.totalFindings} · **Coverage:** ${report.coverage.exercised}/${report.coverage.totalOperations} operations (${report.coverage.coveragePercent}%)`,
  );
  lines.push("");

  const severityCells = FINDING_SEVERITIES.map(
    (severity) => `${severityEmoji(severity)} ${severity}: ${report.summary.bySeverity[severity]}`,
  ).join(" · ");
  lines.push(severityCells);
  lines.push("");

  if (input.findings.length === 0) {
    lines.push("No findings recorded. ✅");
  } else {
    const sorted = [...input.findings].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
    lines.push("## Findings");
    lines.push("");
    for (const finding of sorted) {
      lines.push(`### ${severityEmoji(finding.severity)} [${finding.severity}] ${finding.title}`);
      lines.push("");
      lines.push(`- **Endpoint:** \`${finding.endpoint}\``);
      lines.push(`- **Category:** ${finding.category}`);
      lines.push(`- **Source:** ${finding.source}`);
      lines.push(`- **Status:** ${finding.status ?? "confirmed"}`);
      if (finding.description) {
        lines.push(`- **Details:** ${finding.description}`);
      }
      if (finding.evidence?.length) {
        lines.push(`- **Evidence:**`);
        for (const line of finding.evidence) {
          lines.push(`  - \`${line}\``);
        }
      }
      if (finding.repro) {
        lines.push(`- **Repro:** \`${finding.repro}\``);
      }
      lines.push("");
    }
  }

  if (report.coverage.untouched.length > 0) {
    lines.push("## Untested operations");
    lines.push("");
    for (const operation of report.coverage.untouched.slice(0, 50)) {
      lines.push(`- \`${operation}\``);
    }
    if (report.coverage.untouched.length > 50) {
      lines.push(`- …and ${report.coverage.untouched.length - 50} more`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `_${report.summary.passed ? "PASS" : "FAIL"} at severity threshold \`${input.severityThreshold}\` (${report.summary.findingsAtOrAboveThreshold} at/above), minimum coverage ${report.summary.minCoverage}%, probes ${report.summary.requireProbes ? "required" : "optional"}._`,
  );
  lines.push("");
  lines.push("_Generated by [scout](https://github.com/tester-army/scout)._");

  return lines.join("\n");
}
