import { writeFileSync } from "node:fs";
import { computeCoverage } from "./coverage.js";
import { parseSeverity, readFindings, type FindingSeverity } from "./findings.js";
import { buildReportJson, buildReportMarkdown } from "./report.js";
import { loadCachedSpec, loadSessionState, readRequestRecords } from "./session-store.js";
import { extractOperations } from "./spec-loader.js";
import { isInteractive } from "./utils.js";

export type ReportOptions = {
  json?: boolean;
  md?: string;
  jsonFile?: string;
  ci?: boolean;
  severityThreshold?: string;
  upload?: boolean;
};

/** Compiles findings + coverage into a report with CI-friendly exit codes. */
export async function runReportCommand(options: ReportOptions): Promise<void> {
  const state = loadSessionState();
  const loadedSpec = loadCachedSpec();
  const operations = extractOperations(loadedSpec.spec);
  const findings = readFindings();
  const coverage = computeCoverage(operations, readRequestRecords());
  const severityThreshold: FindingSeverity = options.severityThreshold
    ? parseSeverity(options.severityThreshold)
    : "high";

  const input = {
    title: loadedSpec.title,
    version: loadedSpec.version,
    specSource: state.specSource,
    findings,
    coverage,
    severityThreshold,
  };

  const reportJson = buildReportJson(input);
  const markdown = buildReportMarkdown(input);

  if (options.md) {
    writeFileSync(options.md, `${markdown}\n`);
  }
  if (options.jsonFile) {
    writeFileSync(options.jsonFile, `${JSON.stringify(reportJson, null, 2)}\n`);
  }

  if (options.upload) {
    // Fast-follow: uploadReportViaApi once the ingest endpoint ships.
    reportJson.summary = { ...reportJson.summary };
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
