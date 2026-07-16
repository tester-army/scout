import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ScoutError } from "./errors.js";
import {
  createFinding,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
} from "./findings.js";
import { executeCall, type CallResult, type ExecutorContext } from "./http-executor.js";
import { appendFileSecure, getSessionDirPath, loadSessionState } from "./session-store.js";
import { operationKey, SAFE_METHODS, type SpecOperation } from "./spec-loader.js";

const SYNTHETIC_STRING_ID = "scout-nonexistent-000000";
const SYNTHETIC_UUID = "00000000-0000-4000-8000-000000000000";
const SWEEP_RUNS_FILENAME = "sweep-runs.jsonl";

export type ProbeKind =
  | "happy-path"
  | "missing-auth"
  | "invalid-auth"
  | "required-query"
  | "not-found-shape";

export type SweepPlanEntry = {
  kind: ProbeKind;
  operation: SpecOperation;
  noAuth?: boolean;
  invalidAuth?: boolean;
  pathParams?: Record<string, string>;
  expect?: number;
};

export type SweepOptions = {
  maxRequests?: number;
  noAuthProbes?: boolean;
  dryRun?: boolean;
};

export type SweepPlanDisposition = "planned" | "ineligible" | "capped";

export type SweepPlanDecision = {
  operation: string;
  kind?: ProbeKind;
  disposition: SweepPlanDisposition;
  reason?:
    | "unsafe-method"
    | "unsupported-required-input"
    | "unsupported-path-constraints"
    | "auth-probes-disabled"
    | "no-replaceable-credential"
    | "max-requests"
    | "budget-exhausted";
};

export type SweepStopReason =
  | "completed"
  | "dry-run"
  | "max-requests"
  | "budget-exhausted"
  | "rate-limited";

export type SweepRunRecord = {
  runId: string;
  startedAt: string;
  completedAt: string;
  baseUrl: string;
  probesPlanned: number;
  probesRun: number;
  requestCountBefore: number;
  requestCountAfter: number;
  stopReason: Exclude<SweepStopReason, "dry-run">;
  complete: boolean;
};

export type SweepSummary = {
  runId: string;
  probesPlanned: number;
  probesRunnable: number;
  probesRun: number;
  probesSkipped: number;
  probesCapped: number;
  findingsDetected: number;
  stopReason: SweepStopReason;
  complete: boolean;
  findings: Finding[];
  plan?: SweepPlanDecision[];
};

export type DetailedSweepPlan = {
  entries: SweepPlanEntry[];
  decisions: SweepPlanDecision[];
};

function isParameterFreeGet(operation: SpecOperation): boolean {
  return (
    operation.method === "get" &&
    operation.parameters.filter((param) => param.in === "path" || param.required).length === 0
  );
}

/** Returns one schema-compatible synthetic path parameter when it can be generated safely. */
function syntheticPathParam(operation: SpecOperation): { name: string; value: string } | null {
  const pathParams = operation.parameters.filter((param) => param.in === "path");
  const requiredNonPath = operation.parameters.filter(
    (param) => param.in !== "path" && param.required,
  );
  if (operation.method !== "get" || pathParams.length !== 1 || requiredNonPath.length > 0) {
    return null;
  }

  const parameter = pathParams[0];
  if (!parameter) return null;
  const schema =
    parameter.schema && typeof parameter.schema === "object"
      ? (parameter.schema as Record<string, unknown>)
      : {};
  if (Array.isArray(schema.enum) || schema.const !== undefined || schema.pattern !== undefined) {
    return null;
  }
  if (
    schema.exclusiveMinimum !== undefined ||
    schema.exclusiveMaximum !== undefined ||
    schema.multipleOf !== undefined
  ) {
    return null;
  }

  if (schema.type === "integer" || schema.type === "number") {
    const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
    const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
    let candidate = 2_147_483_647;
    if (maximum !== undefined) candidate = Math.min(candidate, maximum);
    if (minimum !== undefined) candidate = Math.max(candidate, minimum);
    if (schema.type === "integer") candidate = Math.trunc(candidate);
    return Number.isFinite(candidate) ? { name: parameter.name, value: String(candidate) } : null;
  }

  if (schema.type !== undefined && schema.type !== "string") return null;
  if (schema.format !== undefined && schema.format !== "uuid") return null;
  let candidate = schema.format === "uuid" ? SYNTHETIC_UUID : SYNTHETIC_STRING_ID;
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  const minLength = typeof schema.minLength === "number" ? schema.minLength : undefined;
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return null;
  if (schema.format === "uuid" && ((minLength ?? 0) > 36 || (maxLength ?? 36) < 36)) return null;
  if (maxLength !== undefined) candidate = candidate.slice(0, Math.max(0, maxLength));
  if (minLength !== undefined && candidate.length < minLength) {
    candidate = candidate.padEnd(minLength, "0");
  }
  return candidate ? { name: parameter.name, value: candidate } : null;
}

/** Builds a deterministic probe plan with explicit ineligibility reasons. */
export function planSweepDetailed(
  operations: SpecOperation[],
  options: SweepOptions = {},
): DetailedSweepPlan {
  const entries: SweepPlanEntry[] = [];
  const decisions: SweepPlanDecision[] = [];

  /** Adds one executable probe and its public decision. */
  const add = (entry: SweepPlanEntry): void => {
    entries.push(entry);
    decisions.push({
      operation: operationKey(entry.operation),
      kind: entry.kind,
      disposition: "planned",
    });
  };
  /** Adds one public ineligibility decision. */
  const skip = (
    operation: SpecOperation,
    reason: NonNullable<SweepPlanDecision["reason"]>,
    kind?: ProbeKind,
  ): void => {
    decisions.push({
      operation: operationKey(operation),
      ...(kind ? { kind } : {}),
      disposition: "ineligible",
      reason,
    });
  };

  for (const operation of operations) {
    if (!SAFE_METHODS.includes(operation.method)) {
      skip(operation, "unsafe-method");
      continue;
    }

    if (isParameterFreeGet(operation)) {
      add({ kind: "happy-path", operation });

      if (operation.secured) {
        if (options.noAuthProbes === false) {
          skip(operation, "auth-probes-disabled", "missing-auth");
          skip(operation, "auth-probes-disabled", "invalid-auth");
        } else if (operation.authParameters.length === 0) {
          skip(operation, "no-replaceable-credential", "missing-auth");
          skip(operation, "no-replaceable-credential", "invalid-auth");
        } else {
          add({ kind: "missing-auth", operation, noAuth: true });
          add({ kind: "invalid-auth", operation, invalidAuth: true });
        }
      }
      continue;
    }

    const hasPathParams = operation.parameters.some((param) => param.in === "path");
    const hasRequiredQueryParams = operation.parameters.some(
      (param) => param.in === "query" && param.required,
    );
    if (operation.method === "get" && !hasPathParams && hasRequiredQueryParams) {
      add({ kind: "required-query", operation });
      continue;
    }

    const pathParam = syntheticPathParam(operation);
    if (pathParam) {
      add({
        kind: "not-found-shape",
        operation,
        pathParams: { [pathParam.name]: pathParam.value },
        expect: 404,
      });
      continue;
    }

    skip(
      operation,
      operation.method === "get" && hasPathParams
        ? "unsupported-path-constraints"
        : "unsupported-required-input",
    );
  }

  return { entries, decisions };
}

/** Builds the executable portion of a deterministic sweep plan. */
export function planSweep(
  operations: SpecOperation[],
  options: SweepOptions = {},
): SweepPlanEntry[] {
  return planSweepDetailed(operations, options).entries;
}

function findingFor(
  entry: SweepPlanEntry,
  result: CallResult,
  severity: FindingSeverity,
  category: FindingCategory,
  title: string,
  description: string,
  status?: Finding["status"],
): Finding {
  const { operation } = entry;
  let repro = `scout call ${operation.method.toUpperCase()} ${operation.path}`;
  if (entry.noAuth) repro += " --no-auth";
  if (entry.invalidAuth) repro += " --invalid-auth";
  for (const [name, value] of Object.entries(entry.pathParams ?? {})) {
    repro += ` --path-param ${name}=${value}`;
  }

  return createFinding({
    source: "sweep",
    severity,
    category,
    endpoint: operationKey(operation),
    title,
    ...(status ? { status } : {}),
    description,
    evidence: [
      `${result.request.method} ${result.request.url} -> ${result.response.status} (${result.verdict.latencyMs}ms)`,
      ...result.verdict.schemaErrors.slice(0, 5),
    ],
    repro,
  });
}

/** Evaluates a single probe result into zero or more findings. */
export function evaluateProbe(entry: SweepPlanEntry, result: CallResult): Finding[] {
  const findings: Finding[] = [];
  const { operation } = entry;

  if (result.verdict.statusExpected === false) {
    findings.push(
      findingFor(
        entry,
        result,
        "medium",
        "contract-violation",
        `Undocumented status ${result.response.status}`,
        `Spec declares statuses [${result.verdict.expectedStatuses.join(", ")}] but the operation returned ${result.response.status}.`,
      ),
    );
  }
  if (result.verdict.schemaValid === false) {
    findings.push(
      findingFor(
        entry,
        result,
        "high",
        "contract-violation",
        `Response schema mismatch for status ${result.response.status}`,
        `The ${result.response.status} response body failed validation against its OpenAPI schema.`,
      ),
    );
  }
  if (result.verdict.contentTypeMatch === false) {
    findings.push(
      findingFor(
        entry,
        result,
        "medium",
        "contract-violation",
        `Response content type mismatch for status ${result.response.status}`,
        `The ${result.response.status} response Content-Type does not match a media type declared for that response.`,
      ),
    );
  }

  if (entry.kind === "happy-path") {
    if (result.response.status >= 500) {
      findings.push(
        findingFor(
          entry,
          result,
          "high",
          "error-handling",
          `Server error ${result.response.status} on happy path`,
          "A parameter-free GET returned a 5xx status.",
        ),
      );
    }
  }

  if (
    entry.kind === "missing-auth" &&
    result.response.status >= 200 &&
    result.response.status < 300
  ) {
    findings.push(
      findingFor(
        entry,
        result,
        "high",
        "auth",
        "Potential auth bypass: secured operation returned 2xx without credentials",
        "The spec requires credentials, but the probe returned 2xx after removing its declared credential. Validate response semantics and confirm no ambient authentication remained.",
        "candidate",
      ),
    );
  }

  if (
    entry.kind === "invalid-auth" &&
    result.response.status >= 200 &&
    result.response.status < 300
  ) {
    findings.push(
      findingFor(
        entry,
        result,
        "high",
        "auth",
        "Potential auth bypass: secured operation returned 2xx with invalid credentials",
        "The spec requires credentials, but the probe returned 2xx after replacing its declared credential. Validate response semantics and confirm no ambient authentication remained.",
        "candidate",
      ),
    );
  }

  if (entry.kind === "required-query") {
    const requiredQueryParams = operation.parameters
      .filter((param) => param.in === "query" && param.required)
      .map((param) => param.name);
    const parameterList = requiredQueryParams.join(", ");

    if (result.response.status >= 200 && result.response.status < 300) {
      findings.push(
        findingFor(
          entry,
          result,
          "medium",
          "contract-violation",
          "Required query parameters were not enforced",
          `The operation declares required query parameters [${parameterList}], but a request omitting them returned ${result.response.status}.`,
        ),
      );
    } else if (result.response.status >= 500) {
      findings.push(
        findingFor(
          entry,
          result,
          "high",
          "error-handling",
          `Server error ${result.response.status} when required query parameters were omitted`,
          `Omitting required query parameters [${parameterList}] produced a 5xx response instead of a client error.`,
        ),
      );
    }
  }

  if (entry.kind === "not-found-shape") {
    const syntheticId = Object.values(entry.pathParams ?? {})[0] ?? "unknown";
    if (result.response.status >= 200 && result.response.status < 300) {
      findings.push(
        findingFor(
          entry,
          result,
          "medium",
          "data-integrity",
          "Synthetic candidate ID returned 2xx",
          `A schema-compatible synthetic id (${syntheticId}) returned ${result.response.status}. Verify it did not identify an existing resource before classifying this as incorrect missing-resource handling.`,
          "candidate",
        ),
      );
    } else if (result.response.status >= 500) {
      findings.push(
        findingFor(
          entry,
          result,
          "medium",
          "error-handling",
          `Server error ${result.response.status} for missing resource`,
          "A lookup with a synthetic id produced a 5xx instead of a clean 404.",
        ),
      );
    }
  }

  return findings;
}

/** Reads the latest persisted sweep provenance for reports. */
export function readLatestSweepRun(cwd = process.cwd()): SweepRunRecord | null {
  const path = join(getSessionDirPath(cwd), SWEEP_RUNS_FILENAME);
  if (!existsSync(path)) return null;
  const runId = loadSessionState(cwd).runId;
  const records = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SweepRunRecord);
  return records.findLast((record) => record.runId === runId) ?? null;
}

/** Persists one compact sweep run record for later report provenance. */
function appendSweepRun(record: SweepRunRecord, cwd: string): void {
  appendFileSecure(
    join(getSessionDirPath(cwd), SWEEP_RUNS_FILENAME),
    `${JSON.stringify(record)}\n`,
  );
}

/** Applies request and budget caps to a detailed plan. */
function capSweepPlan(
  plan: DetailedSweepPlan,
  maxRequests: number,
  remainingBudget: number,
): { selected: SweepPlanEntry[]; decisions: SweepPlanDecision[]; capped: number } {
  const limit = Math.min(plan.entries.length, maxRequests, remainingBudget);
  let plannedIndex = 0;
  const decisions = plan.decisions.map((decision): SweepPlanDecision => {
    if (decision.disposition !== "planned") return decision;
    const index = plannedIndex++;
    if (index < limit) return decision;
    return {
      ...decision,
      disposition: "capped",
      reason: index >= maxRequests ? "max-requests" : "budget-exhausted",
    };
  });
  return {
    selected: plan.entries.slice(0, limit),
    decisions,
    capped: plan.entries.length - limit,
  };
}

/** Runs a sweep plan through the guardrailed executor, collecting findings. */
export async function runSweep(
  context: ExecutorContext,
  operations: SpecOperation[],
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const startedAt = new Date().toISOString();
  const stateBefore = loadSessionState(context.cwd);
  const plan = planSweepDetailed(operations, options);
  const requestedLimit = Math.max(0, options.maxRequests ?? plan.entries.length);
  const remainingBudget = Math.max(0, context.policy.budget - stateBefore.requestCount);
  const cappedPlan = capSweepPlan(plan, requestedLimit, remainingBudget);
  const probesSkipped = plan.decisions.filter(
    (decision) => decision.disposition === "ineligible",
  ).length;

  if (options.dryRun) {
    return {
      runId: stateBefore.runId,
      probesPlanned: plan.entries.length,
      probesRunnable: cappedPlan.selected.length,
      probesRun: 0,
      probesSkipped,
      probesCapped: cappedPlan.capped,
      findingsDetected: 0,
      stopReason: "dry-run",
      complete: false,
      findings: [],
      plan: cappedPlan.decisions,
    };
  }

  const findings: Finding[] = [];
  let probesRun = 0;
  let stopReason: Exclude<SweepStopReason, "dry-run"> = "completed";
  if (cappedPlan.capped > 0) {
    stopReason =
      remainingBudget <= requestedLimit && remainingBudget < plan.entries.length
        ? "budget-exhausted"
        : "max-requests";
  }

  for (const entry of cappedPlan.selected) {
    let result: CallResult;
    try {
      result = await executeCall(context, {
        method: entry.operation.method,
        path: entry.operation.path,
        source: "sweep",
        ...(entry.pathParams ? { pathParams: entry.pathParams } : {}),
        ...(entry.noAuth ? { noAuth: true } : {}),
        ...(entry.invalidAuth ? { invalidAuth: true } : {}),
        ...(entry.expect !== undefined ? { expect: entry.expect } : {}),
      });
    } catch (error) {
      if (error instanceof ScoutError && error.code === "BUDGET_EXCEEDED") {
        stopReason = "budget-exhausted";
        break;
      }
      throw error;
    }
    probesRun += 1;
    if (result.response.status === 429) {
      stopReason = "rate-limited";
      break;
    }
    findings.push(...evaluateProbe(entry, result));
  }

  const stateAfter = loadSessionState(context.cwd);
  const complete = stopReason === "completed";
  appendSweepRun(
    {
      runId: stateBefore.runId,
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl: context.config.baseUrl,
      probesPlanned: plan.entries.length,
      probesRun,
      requestCountBefore: stateBefore.requestCount,
      requestCountAfter: stateAfter.requestCount,
      stopReason,
      complete,
    },
    context.cwd,
  );

  return {
    runId: stateBefore.runId,
    probesPlanned: plan.entries.length,
    probesRunnable: cappedPlan.selected.length,
    probesRun,
    probesSkipped,
    probesCapped: cappedPlan.capped,
    findingsDetected: findings.length,
    stopReason,
    complete,
    findings,
  };
}
