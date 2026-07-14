import { describe, expect, it } from "vitest";
import type { CallResult } from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";
import { evaluateProbe, planSweep, type ProbeKind, type SweepPlanEntry } from "./sweep-engine.js";

function op(overrides: Partial<SpecOperation>): SpecOperation {
  return {
    method: "get",
    path: "/",
    tags: [],
    deprecated: false,
    secured: false,
    authParameters: [],
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
  it("plans both auth probes after happy-path for secured parameter-free GETs", () => {
    const plan = planSweep([
      op({
        path: "/admin",
        secured: true,
        authParameters: [{ name: "Authorization", in: "header" }],
      }),
    ]);
    expect(plan.map((entry) => entry.kind)).toEqual(["happy-path", "missing-auth", "invalid-auth"]);
    expect(plan[1]?.noAuth).toBe(true);
    expect(plan[2]?.invalidAuth).toBe(true);
  });

  it("skips auth probes when disabled", () => {
    const plan = planSweep(
      [
        op({
          path: "/admin",
          secured: true,
          authParameters: [{ name: "Authorization", in: "header" }],
        }),
      ],
      { noAuthProbes: false },
    );
    expect(plan.map((entry) => entry.kind)).toEqual(["happy-path"]);
  });

  it("skips auth probes when no replaceable credential location is known", () => {
    const plan = planSweep([op({ path: "/admin", secured: true })]);
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

  it("generates schema-compatible synthetic path values", () => {
    const integerPlan = planSweep([
      op({
        path: "/pets/{id}",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", maximum: 999 } },
        ],
      }),
    ]);
    expect(integerPlan[0]?.pathParams).toEqual({ id: "999" });

    const uuidPlan = planSweep([
      op({
        path: "/pets/{id}",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
      }),
    ]);
    expect(uuidPlan[0]?.pathParams?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("skips synthetic IDs constrained to known values", () => {
    expect(
      planSweep([
        op({
          path: "/pets/{id}",
          parameters: [
            { name: "id", in: "path", required: true, schema: { enum: ["one", "two"] } },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("skips synthetic IDs with unsupported schema constraints", () => {
    expect(
      planSweep([
        op({
          path: "/pets/{id}",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer", multipleOf: 3 } },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("plans required-query without path parameters", () => {
    const plan = planSweep([
      op({
        path: "/search",
        parameters: [
          { name: "query", in: "query", required: true },
          { name: "limit", in: "query", required: false },
        ],
      }),
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe("required-query");
  });

  it("plans required-query when auth probes are disabled", () => {
    const plan = planSweep(
      [
        op({
          path: "/search",
          secured: true,
          parameters: [{ name: "query", in: "query", required: true }],
        }),
      ],
      { noAuthProbes: false },
    );

    expect(plan.map((entry) => entry.kind)).toEqual(["required-query"]);
  });

  it("does not plan required-query when a path parameter is present", () => {
    const plan = planSweep([
      op({
        path: "/search/{scope}",
        parameters: [
          { name: "scope", in: "path", required: true },
          { name: "query", in: "query", required: true },
        ],
      }),
    ]);

    expect(plan).toEqual([]);
  });

  it("ignores non-safe methods", () => {
    expect(planSweep([op({ method: "post", path: "/pets" })])).toEqual([]);
  });
});

describe("evaluateProbe", () => {
  const happy: SweepPlanEntry = { kind: "happy-path", operation: op({ path: "/pets" }) };

  it("flags schema violations on happy path", () => {
    const findings = evaluateProbe(happy, result(200, { schemaValid: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Response schema mismatch for status 200");
  });

  it("flags content-type violations on happy path", () => {
    const findings = evaluateProbe(happy, result(200, { contentTypeMatch: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Response content type mismatch for status 200");
  });

  it("flags 5xx on happy path", () => {
    const findings = evaluateProbe(happy, result(500));
    expect(findings.some((f) => f.severity === "high" && f.category === "error-handling")).toBe(
      true,
    );
  });

  it("raises high-severity candidate when secured endpoint returns 2xx without auth", () => {
    const entry: SweepPlanEntry = {
      kind: "missing-auth",
      operation: op({ path: "/admin", secured: true }),
      noAuth: true,
    };
    const findings = evaluateProbe(entry, result(200));
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.category).toBe("auth");
    expect(findings[0]?.repro).toContain("--no-auth");
  });

  it("raises high-severity candidate when secured endpoint returns 2xx with invalid auth", () => {
    const entry: SweepPlanEntry = {
      kind: "invalid-auth",
      operation: op({ path: "/admin", secured: true }),
      invalidAuth: true,
    };
    const findings = evaluateProbe(entry, result(204));
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.category).toBe("auth");
    expect(findings[0]?.repro).toContain("--invalid-auth");
  });

  it("flags required-query 2xx as a medium contract violation", () => {
    const entry: SweepPlanEntry = {
      kind: "required-query",
      operation: op({
        path: "/search",
        parameters: [
          { name: "query", in: "query", required: true },
          { name: "region", in: "query", required: true },
        ],
      }),
    };
    const findings = evaluateProbe(entry, result(200));
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.category).toBe("contract-violation");
    expect(findings[0]?.description).toContain("[query, region]");
    expect(findings[0]?.repro).toBe("scout call GET /search");
  });

  it("flags required-query 5xx as high error-handling", () => {
    const entry: SweepPlanEntry = {
      kind: "required-query",
      operation: op({
        path: "/search",
        parameters: [{ name: "query", in: "query", required: true }],
      }),
    };
    const findings = evaluateProbe(entry, result(500));
    expect(findings.some((f) => f.severity === "high" && f.category === "error-handling")).toBe(
      true,
    );
  });

  it("flags synthetic-id 2xx as data-integrity", () => {
    const entry: SweepPlanEntry = {
      kind: "not-found-shape",
      operation: op({
        path: "/pets/{id}",
        parameters: [{ name: "id", in: "path", required: true }],
      }),
      pathParams: { id: "scout-nonexistent-000000" },
      expect: 404,
    };
    const findings = evaluateProbe(entry, result(200));
    expect(findings[0]?.category).toBe("data-integrity");
    expect(findings[0]?.title).toContain("candidate");
    expect(findings[0]?.repro).toContain(`--path-param id=scout-nonexistent-000000`);
  });

  it.each<ProbeKind>([
    "happy-path",
    "missing-auth",
    "invalid-auth",
    "required-query",
    "not-found-shape",
  ])("contract-validates %s responses without duplicate findings", (kind) => {
    const entry: SweepPlanEntry = {
      kind,
      operation: op({
        path: "/probe",
        parameters:
          kind === "required-query" ? [{ name: "query", in: "query", required: true }] : [],
      }),
    };
    const findings = evaluateProbe(
      entry,
      result(418, {
        statusExpected: false,
        schemaValid: false,
        contentTypeMatch: false,
      }),
    );

    expect(findings.map((finding) => finding.title)).toEqual([
      "Undocumented status 418",
      "Response schema mismatch for status 418",
      "Response content type mismatch for status 418",
    ]);
  });
});
