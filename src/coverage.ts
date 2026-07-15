import type { RequestRecord } from "./session-store.js";
import { operationKey, type SpecOperation } from "./spec-loader.js";

export type OperationCoverageState = "unexercised" | "called" | "validated";

export type OperationCoverage = {
  operation: string;
  state: OperationCoverageState;
  calls: number;
  controlCalls: number;
  negativeCalls: number;
  statuses: number[];
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
  const callsByOperation = new Map<
    string,
    {
      calls: number;
      controlCalls: number;
      negativeCalls: number;
      statuses: Set<number>;
      validated: boolean;
    }
  >();
  for (const record of records) {
    if (!record.operation) continue;
    const entry = callsByOperation.get(record.operation) ?? {
      calls: 0,
      controlCalls: 0,
      negativeCalls: 0,
      statuses: new Set<number>(),
      validated: false,
    };
    entry.calls += 1;
    const isControl =
      record.testKind === "control" || (!record.testKind && record.source === "call");
    if (isControl) entry.controlCalls += 1;
    else entry.negativeCalls += 1;
    entry.statuses.add(record.status);
    if (isControl && record.status >= 200 && record.status < 400 && record.schemaValid === true) {
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
    return {
      operation: key,
      state,
      calls: entry?.calls ?? 0,
      controlCalls: entry?.controlCalls ?? 0,
      negativeCalls: entry?.negativeCalls ?? 0,
      statuses: [...(entry?.statuses ?? [])].sort((a, b) => a - b),
    };
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
