import { computeCoverage } from "./coverage.js";
import { filterOperations, scopeOperations, type OperationFilter } from "./operation-filter.js";
import { stringifyJson } from "./output.js";
import { loadProjectConfigOrThrow, resolvePolicy } from "./project-config.js";
import { loadCachedSpec, readRequestRecords } from "./session-store.js";
import { extractOperations } from "./spec-loader.js";
import { isInteractive } from "./utils.js";

export type CoverageOptions = OperationFilter & {
  json?: boolean;
};

/** Reports operations exercised vs total — the "what's left" view. */
export async function runCoverageCommand(options: CoverageOptions): Promise<void> {
  const loadedSpec = loadCachedSpec();
  const { config } = loadProjectConfigOrThrow();
  const operations = filterOperations(
    scopeOperations(extractOperations(loadedSpec.spec), resolvePolicy(config)),
    options,
  );
  const records = readRequestRecords();
  const summary = computeCoverage(operations, records);

  if (options.json || !isInteractive()) {
    console.log(stringifyJson(summary));
    return;
  }

  console.log(
    `Coverage: ${summary.exercised}/${summary.totalOperations} operations exercised (${summary.coveragePercent}%), ${summary.validated} schema-validated.`,
  );
  if (summary.untouched.length > 0) {
    console.log("\nUntested:");
    for (const operation of summary.untouched.slice(0, 30)) {
      console.log(`  ${operation}`);
    }
    if (summary.untouched.length > 30) {
      console.log(`  …and ${summary.untouched.length - 30} more (use --json for the full list)`);
    }
  }
}
