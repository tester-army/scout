import type { RequestRecord } from "./session-store.js";
import { operationKey, type SpecOperation } from "./spec-loader.js";

export type OperationCoverageState = "unexercised" | "called" | "validated";

export type OperationCoverage = {
  operation: string;
  state: OperationCoverageState;
  calls: number;
};

export type CoverageSummary = {
  totalOperations: number;
  exercised: number;
  validated: number;
  coveragePercent: number;
  requestTotals: {
    recorded: number;
    matched: number;
    probes: number;
  };
  operations: OperationCoverage[];
  untouched: string[];
};

/**
 * Folds the request log over the spec's operation set. Coverage is
 * operation-level: one `GET /users/123` marks `GET /users/{id}` exercised.
 */
export function computeCoverage(
  operations: SpecOperation[],
  records: RequestRecord[],
): CoverageSummary {
  const callsByOperation = new Map<string, { calls: number; validated: boolean }>();
  for (const record of records) {
    if (!record.operation) continue;
    const entry = callsByOperation.get(record.operation) ?? { calls: 0, validated: false };
    entry.calls += 1;
    if (record.schemaValid === true) {
      entry.validated = true;
    }
    callsByOperation.set(record.operation, entry);
  }

  const operationCoverage: OperationCoverage[] = operations.map((op) => {
    const key = operationKey(op);
    const entry = callsByOperation.get(key);
    let state: OperationCoverageState = "unexercised";
    if (entry) {
      state = entry.validated ? "validated" : "called";
    }
    return { operation: key, state, calls: entry?.calls ?? 0 };
  });

  const exercised = operationCoverage.filter((op) => op.state !== "unexercised").length;
  const validated = operationCoverage.filter((op) => op.state === "validated").length;

  return {
    totalOperations: operations.length,
    exercised,
    validated,
    coveragePercent:
      operations.length === 0 ? 0 : Math.round((exercised / operations.length) * 100),
    requestTotals: {
      recorded: records.length,
      matched: records.filter((record) => record.operation !== null).length,
      probes: records.filter((record) => record.source === "sweep" || record.source === "fuzz")
        .length,
    },
    operations: operationCoverage,
    untouched: operationCoverage
      .filter((op) => op.state === "unexercised")
      .map((op) => op.operation),
  };
}
