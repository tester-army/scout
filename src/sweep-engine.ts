import {
  createFinding,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
} from "./findings.js";
import {
  executeCall,
  RateLimiter,
  type CallResult,
  type ExecutorContext,
} from "./http-executor.js";
import { operationKey, SAFE_METHODS, type SpecOperation } from "./spec-loader.js";

const SYNTHETIC_ID = "scout-nonexistent-000000";

export type ProbeKind = "happy-path" | "missing-auth" | "invalid-auth" | "not-found-shape";

export type SweepPlanEntry = {
  kind: ProbeKind;
  operation: SpecOperation;
  noAuth?: boolean;
  pathParams?: Record<string, string>;
  expect?: number;
};

export type SweepOptions = {
  maxRequests?: number;
  noAuthProbes?: boolean;
};

export type SweepSummary = {
  probesPlanned: number;
  probesRun: number;
  findingsCreated: number;
  findings: Finding[];
};

function isParameterFreeGet(operation: SpecOperation): boolean {
  return (
    operation.method === "get" &&
    operation.parameters.filter((param) => param.in === "path" || param.required).length === 0
  );
}

function singlePathParam(operation: SpecOperation): string | null {
  const pathParams = operation.parameters.filter((param) => param.in === "path");
  const requiredNonPath = operation.parameters.filter(
    (param) => param.in !== "path" && param.required,
  );
  if (operation.method === "get" && pathParams.length === 1 && requiredNonPath.length === 0) {
    return pathParams[0]?.name ?? null;
  }
  return null;
}

/**
 * Builds a deterministic probe plan over the (already filtered) operation
 * set. Pure — the executor runs it through the same guardrailed path.
 */
export function planSweep(
  operations: SpecOperation[],
  options: SweepOptions = {},
): SweepPlanEntry[] {
  const plan: SweepPlanEntry[] = [];

  for (const operation of operations) {
    if (!SAFE_METHODS.includes(operation.method)) continue;

    if (isParameterFreeGet(operation)) {
      plan.push({ kind: "happy-path", operation });

      if (operation.secured && options.noAuthProbes !== false) {
        plan.push({ kind: "missing-auth", operation, noAuth: true });
      }
      continue;
    }

    const paramName = singlePathParam(operation);
    if (paramName) {
      plan.push({
        kind: "not-found-shape",
        operation,
        pathParams: { [paramName]: SYNTHETIC_ID },
        expect: 404,
      });
    }
  }

  return plan;
}

function findingFor(
  operation: SpecOperation,
  result: CallResult,
  severity: FindingSeverity,
  category: FindingCategory,
  title: string,
  description: string,
): Finding {
  return createFinding({
    source: "sweep",
    severity,
    category,
    endpoint: operationKey(operation),
    title,
    description,
    evidence: [
      `${result.request.method} ${result.request.url} -> ${result.response.status} (${result.verdict.latencyMs}ms)`,
      ...result.verdict.schemaErrors.slice(0, 5),
    ],
    repro: `scout call ${operation.method.toUpperCase()} ${operation.path}`,
  });
}

/** Evaluates a single probe result into zero or more findings. */
export function evaluateProbe(entry: SweepPlanEntry, result: CallResult): Finding[] {
  const findings: Finding[] = [];
  const { operation } = entry;

  if (entry.kind === "happy-path") {
    if (result.verdict.statusExpected === false) {
      findings.push(
        findingFor(
          operation,
          result,
          "medium",
          "contract-violation",
          `Undocumented status ${result.response.status}`,
          `Spec declares statuses [${result.verdict.expectedStatuses.join(", ")}] but endpoint returned ${result.response.status}.`,
        ),
      );
    }
    if (result.verdict.schemaValid === false) {
      findings.push(
        findingFor(
          operation,
          result,
          "high",
          "contract-violation",
          "Response body does not match spec schema",
          "The response failed schema validation against the OpenAPI spec.",
        ),
      );
    }
    if (result.response.status >= 500) {
      findings.push(
        findingFor(
          operation,
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
        operation,
        result,
        "critical",
        "auth",
        "Secured endpoint returned 2xx without credentials",
        "The spec marks this operation as secured, but it responded successfully with no auth headers.",
      ),
    );
  }

  if (entry.kind === "not-found-shape") {
    if (result.response.status >= 200 && result.response.status < 300) {
      findings.push(
        findingFor(
          operation,
          result,
          "medium",
          "data-integrity",
          "Synthetic ID returned 2xx",
          `A request for a non-existent resource id (${SYNTHETIC_ID}) returned ${result.response.status} instead of 404.`,
        ),
      );
    } else if (result.response.status >= 500) {
      findings.push(
        findingFor(
          operation,
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

/** Runs a sweep plan through the guardrailed executor, collecting findings. */
export async function runSweep(
  context: ExecutorContext,
  operations: SpecOperation[],
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const plan = planSweep(operations, options);
  const limited = options.maxRequests !== undefined ? plan.slice(0, options.maxRequests) : plan;

  const rateLimiter = new RateLimiter(context.policy.rateLimit);
  const findings: Finding[] = [];
  let probesRun = 0;

  for (const entry of limited) {
    const result = await executeCall(
      context,
      {
        method: entry.operation.method,
        path: entry.operation.path,
        source: "sweep",
        ...(entry.pathParams ? { pathParams: entry.pathParams } : {}),
        ...(entry.noAuth ? { noAuth: true } : {}),
        ...(entry.expect !== undefined ? { expect: entry.expect } : {}),
      },
      rateLimiter,
    );
    probesRun += 1;
    findings.push(...evaluateProbe(entry, result));
  }

  return {
    probesPlanned: limited.length,
    probesRun,
    findingsCreated: findings.length,
    findings,
  };
}
