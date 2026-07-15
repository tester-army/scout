import { describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage.js";
import type { RequestRecord } from "./session-store.js";
import type { SpecOperation } from "./spec-loader.js";

function op(method: SpecOperation["method"], path: string): SpecOperation {
  return {
    method,
    path,
    tags: [],
    deprecated: false,
    secured: false,
    authParameters: [],
    parameters: [],
    responses: {},
  };
}

function record(operation: string, schemaValid: RequestRecord["schemaValid"]): RequestRecord {
  return {
    id: "x",
    timestamp: "now",
    source: "call",
    operation,
    method: operation.split(" ")[0] ?? "GET",
    url: "https://x",
    status: 200,
    latencyMs: 1,
    schemaValid,
    requestHeaders: {},
  };
}

describe("computeCoverage", () => {
  const operations = [op("get", "/pets"), op("post", "/pets"), op("get", "/pets/{id}")];

  it("counts unexercised operations", () => {
    const summary = computeCoverage(operations, []);
    expect(summary.totalOperations).toBe(3);
    expect(summary.exercised).toBe(0);
    expect(summary.coveragePercent).toBe(0);
    expect(summary.requestTotals).toEqual({ recorded: 0, matched: 0, probes: 0 });
    expect(summary.untouched).toHaveLength(3);
  });

  it("marks called vs validated", () => {
    const summary = computeCoverage(operations, [
      record("GET /pets", true),
      record("POST /pets", "unknown"),
    ]);

    expect(summary.exercised).toBe(2);
    expect(summary.validated).toBe(1);
    expect(summary.coveragePercent).toBe(67);
    expect(summary.requestTotals).toEqual({ recorded: 2, matched: 2, probes: 0 });
    expect(summary.operations.find((o) => o.operation === "GET /pets")?.state).toBe("validated");
    expect(summary.operations.find((o) => o.operation === "POST /pets")?.state).toBe("called");
    expect(summary.untouched).toEqual(["GET /pets/{id}"]);
  });
});
