import { describe, expect, it } from "vitest";
import type { CallResult } from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";
import { evaluateProbe, planSweep, type SweepPlanEntry } from "./sweep-engine.js";

function op(overrides: Partial<SpecOperation>): SpecOperation {
  return {
    method: "get",
    path: "/",
    tags: [],
    deprecated: false,
    secured: false,
    parameters: [],
    responses: {},
    ...overrides,
  };
}

function result(status: number, verdict: Partial<CallResult["verdict"]> = {}): CallResult {
  return {
    requestId: "id",
    operation: "GET /x",
    request: { method: "GET", url: "https://x", headers: {} },
    response: { status, body: {}, bodyIsJson: true },
    verdict: {
      status,
      expectedStatuses: ["200"],
      statusExpected: true,
      schemaValid: true,
      schemaErrors: [],
      contentTypeMatch: true,
      latencyMs: 5,
      redacted: false,
      ...verdict,
    },
  };
}

describe("planSweep", () => {
  it("plans happy-path + missing-auth for secured parameter-free GETs", () => {
    const plan = planSweep([op({ path: "/admin", secured: true })]);
    expect(plan.map((entry) => entry.kind)).toEqual(["happy-path", "missing-auth"]);
    expect(plan[1]?.noAuth).toBe(true);
  });

  it("skips auth probes when disabled", () => {
    const plan = planSweep([op({ path: "/admin", secured: true })], { noAuthProbes: false });
    expect(plan.map((entry) => entry.kind)).toEqual(["happy-path"]);
  });

  it("plans not-found-shape for single path-param GETs", () => {
    const plan = planSweep([
      op({
        path: "/pets/{id}",
        parameters: [{ name: "id", in: "path", required: true }],
      }),
    ]);
    expect(plan[0]?.kind).toBe("not-found-shape");
    expect(plan[0]?.expect).toBe(404);
  });

  it("ignores non-safe methods", () => {
    expect(planSweep([op({ method: "post", path: "/pets" })])).toEqual([]);
  });
});

describe("evaluateProbe", () => {
  const happy: SweepPlanEntry = { kind: "happy-path", operation: op({ path: "/pets" }) };

  it("flags schema violations on happy path", () => {
    const findings = evaluateProbe(happy, result(200, { schemaValid: false }));
    expect(findings.some((f) => f.category === "contract-violation")).toBe(true);
  });

  it("flags 5xx on happy path", () => {
    const findings = evaluateProbe(happy, result(500));
    expect(findings.some((f) => f.severity === "high" && f.category === "error-handling")).toBe(
      true,
    );
  });

  it("raises critical when secured endpoint returns 2xx without auth", () => {
    const entry: SweepPlanEntry = {
      kind: "missing-auth",
      operation: op({ path: "/admin", secured: true }),
      noAuth: true,
    };
    const findings = evaluateProbe(entry, result(200));
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.category).toBe("auth");
  });

  it("flags synthetic-id 2xx as data-integrity", () => {
    const entry: SweepPlanEntry = {
      kind: "not-found-shape",
      operation: op({ path: "/pets/{id}" }),
      expect: 404,
    };
    const findings = evaluateProbe(entry, result(200));
    expect(findings[0]?.category).toBe("data-integrity");
  });
});
