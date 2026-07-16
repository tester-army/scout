import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallResult, ExecutorContext } from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";
import {
  evaluateProbe,
  planSweep,
  planSweepDetailed,
  readLatestSweepRun,
  runSweep,
  type ProbeKind,
  type SweepPlanEntry,
} from "./sweep-engine.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    response: { status, headers: {}, body: {}, bodyIsJson: true, bodyTruncated: false },
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

/** Creates a minimal persisted executor context for sweep execution tests. */
function context(operations: SpecOperation[], budget: number): ExecutorContext {
  const cwd = mkdtempSync(join(tmpdir(), "scout-sweep-"));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, ".scout"));
  writeFileSync(
    join(cwd, ".scout", "state.json"),
    JSON.stringify({
      specSource: "spec.json",
      specHash: "hash",
      createdAt: new Date().toISOString(),
      requestCount: 0,
    }),
  );
  return {
    cwd,
    config: { spec: "spec.json", baseUrl: "https://api.example.com" },
    policy: { allowMutations: false, rateLimit: 100_000, budget },
    loadedSpec: {
      spec: {},
      source: "spec.json",
      hash: "hash",
      title: "API",
      version: "1",
      specVersion: "3.0.0",
      converted: false,
      dereferenced: true,
      warnings: [],
    },
    operations,
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

  it("skips a templated path whose variable has no declared parameter", () => {
    // Spec defect: path has {recordId} but declares no path parameter. Must be
    // skipped, never planned as happy-path (which would throw at execution).
    const detailed = planSweepDetailed([op({ path: "/domains/records/{recordId}" })]);
    expect(detailed.entries).toEqual([]);
    expect(detailed.decisions).toEqual([
      {
        operation: "GET /domains/records/{recordId}",
        disposition: "ineligible",
        reason: "unsupported-path-constraints",
      },
    ]);
  });

  it("skips when a synthetic param cannot cover every path template variable", () => {
    // One declared+synthesizable param, but the path has a second, uncovered var.
    const plan = planSweep([
      op({
        path: "/domains/{domain}/records/{recordId}",
        parameters: [{ name: "recordId", in: "path", required: true }],
      }),
    ]);
    expect(plan).toEqual([]);
  });

  it("explains ineligible probes", () => {
    const detailed = planSweepDetailed(
      [
        op({ method: "post", path: "/pets" }),
        op({
          path: "/admin",
          secured: true,
          authParameters: [{ name: "Authorization", in: "header" }],
        }),
      ],
      { noAuthProbes: false },
    );

    expect(detailed.decisions).toEqual([
      { operation: "POST /pets", disposition: "ineligible", reason: "unsafe-method" },
      { operation: "GET /admin", kind: "happy-path", disposition: "planned" },
      {
        operation: "GET /admin",
        kind: "missing-auth",
        disposition: "ineligible",
        reason: "auth-probes-disabled",
      },
      {
        operation: "GET /admin",
        kind: "invalid-auth",
        disposition: "ineligible",
        reason: "auth-probes-disabled",
      },
    ]);
  });
});

describe("runSweep", () => {
  it("returns a capped dry-run plan without sending requests", async () => {
    const operations = [op({ path: "/a" }), op({ path: "/b" })];
    const executor = context(operations, 10);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runSweep(executor, operations, { dryRun: true, maxRequests: 1 });

    expect(summary).toMatchObject({
      probesPlanned: 2,
      probesRunnable: 1,
      probesRun: 0,
      probesCapped: 1,
      stopReason: "dry-run",
    });
    expect(summary.plan?.find((entry) => entry.operation === "GET /b")).toMatchObject({
      disposition: "capped",
      reason: "max-requests",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readLatestSweepRun(executor.cwd)).toBeNull();
  });

  it("stops cleanly before an exhausted budget", async () => {
    const operations = [op({ path: "/a" })];
    const executor = context(operations, 0);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runSweep(executor, operations);

    expect(summary).toMatchObject({
      probesRun: 0,
      probesCapped: 1,
      stopReason: "budget-exhausted",
      complete: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readLatestSweepRun(executor.cwd)?.stopReason).toBe("budget-exhausted");
  });

  it("records a probe error and continues the batch instead of aborting", async () => {
    const operations = [op({ path: "/a" }), op({ path: "/b" })];
    const executor = context(operations, 10);
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runSweep(executor, operations);

    expect(summary).toMatchObject({
      probesRun: 1,
      probesErrored: 1,
      stopReason: "completed",
    });
    expect(summary.errors?.[0]?.operation).toBe("GET /a");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly after a 429 without recording a finding for it", async () => {
    const operations = [op({ path: "/a" }), op({ path: "/b" })];
    const executor = context(operations, 10);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runSweep(executor, operations);

    expect(summary).toMatchObject({
      probesRun: 1,
      findingsDetected: 0,
      stopReason: "rate-limited",
      complete: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(readLatestSweepRun(executor.cwd)?.stopReason).toBe("rate-limited");
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
    expect(findings[0]?.status).toBe("candidate");
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
    expect(findings[0]?.status).toBe("candidate");
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
    expect(findings[0]?.status).toBe("candidate");
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
