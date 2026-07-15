import { writeFileSync } from "node:fs";
import { computeCoverage } from "./coverage.js";
import { ScoutError } from "./errors.js";
import { parseSeverity, readFindings, type FindingSeverity } from "./findings.js";
import { loadProjectConfigOrThrow } from "./project-config.js";
import { buildReportJson, buildReportMarkdown, type ReportInput } from "./report.js";
import { loadCachedSpec, loadSessionState, readRequestRecords } from "./session-store.js";
import { extractOperations } from "./spec-loader.js";
import { readLatestSweepRun } from "./sweep-engine.js";
import { isInteractive } from "./utils.js";

export type ReportOptions = {
  json?: boolean;
  md?: string;
  jsonFile?: string;
  ci?: boolean;
  severityThreshold?: string;
  minCoverage?: number;
  requireProbes?: boolean;
};

/** Compiles findings + coverage into a report with CI-friendly exit codes. */
export async function runReportCommand(options: ReportOptions): Promise<void> {
  const state = loadSessionState();
  const loadedSpec = loadCachedSpec();
  const { config } = loadProjectConfigOrThrow();
  const operations = extractOperations(loadedSpec.spec);
  const findings = readFindings();
  const records = readRequestRecords();
  const coverage = computeCoverage(operations, records);
  const sweepRun = readLatestSweepRun();
  const severityThreshold: FindingSeverity = options.severityThreshold
    ? parseSeverity(options.severityThreshold)
    : "high";
  const minCoverage = options.minCoverage ?? 0;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 100) {
    throw new ScoutError("--min-coverage must be between 0 and 100.", {
      code: "VALIDATION_ERROR",
    });
  }
  const requireProbes = options.requireProbes ?? options.ci === true;

  const input: ReportInput = {
    title: loadedSpec.title,
    version: loadedSpec.version,
    specSource: state.specSource,
    findings,
    coverage,
    severityThreshold,
    minCoverage,
    requireProbes,
    provenance: {
      runId: state.runId,
      baseUrl: sweepRun?.baseUrl ?? config.baseUrl,
      requestTotals: {
        session: state.requestCount,
        recorded: coverage.requestTotals.recorded,
        probes: sweepRun?.probesRun ?? 0,
        run: sweepRun ? sweepRun.requestCountAfter - sweepRun.requestCountBefore : 0,
      },
      stopReason: sweepRun?.stopReason ?? "not-run",
    },
  };

  const reportJson = buildReportJson(input);
  const markdown = buildReportMarkdown(input);

  if (options.md) {
    writeFileSync(options.md, `${markdown}\n`);
  }
  if (options.jsonFile) {
    writeFileSync(options.jsonFile, `${JSON.stringify(reportJson, null, 2)}\n`);
  }

  if (options.ci && !reportJson.summary.passed) {
    process.exitCode = 1;
  }

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(reportJson, null, 2));
    return;
  }

  console.log(markdown);
}
