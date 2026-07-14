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
import { loadSessionState } from "./session-store.js";
import { operationKey, SAFE_METHODS, type SpecOperation } from "./spec-loader.js";

const SYNTHETIC_STRING_ID = "scout-nonexistent-000000";
const SYNTHETIC_UUID = "00000000-0000-4000-8000-000000000000";

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

      if (
        operation.secured &&
        operation.authParameters.length > 0 &&
        options.noAuthProbes !== false
      ) {
        plan.push({ kind: "missing-auth", operation, noAuth: true });
        plan.push({ kind: "invalid-auth", operation, invalidAuth: true });
      }
      continue;
    }

    const hasPathParams = operation.parameters.some((param) => param.in === "path");
    const hasRequiredQueryParams = operation.parameters.some(
      (param) => param.in === "query" && param.required,
    );
    if (operation.method === "get" && !hasPathParams && hasRequiredQueryParams) {
      plan.push({ kind: "required-query", operation });
      continue;
    }

    const pathParam = syntheticPathParam(operation);
    if (pathParam) {
      plan.push({
        kind: "not-found-shape",
        operation,
        pathParams: { [pathParam.name]: pathParam.value },
        expect: 404,
      });
    }
  }

  return plan;
}

function findingFor(
  entry: SweepPlanEntry,
  result: CallResult,
  severity: FindingSeverity,
  category: FindingCategory,
  title: string,
  description: string,
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

/** Runs a sweep plan through the guardrailed executor, collecting findings. */
export async function runSweep(
  context: ExecutorContext,
  operations: SpecOperation[],
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const plan = planSweep(operations, options);
  const requestedLimit = options.maxRequests ?? plan.length;
  const remainingBudget = Math.max(
    0,
    context.policy.budget - loadSessionState(context.cwd).requestCount,
  );
  let effectiveLimit = Math.min(requestedLimit, remainingBudget);
  if (requestedLimit > 0 && remainingBudget === 0) effectiveLimit = 1;
  const limited = plan.slice(0, effectiveLimit);

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
        ...(entry.invalidAuth ? { invalidAuth: true } : {}),
        ...(entry.expect !== undefined ? { expect: entry.expect } : {}),
      },
      rateLimiter,
    );
    probesRun += 1;
    findings.push(...evaluateProbe(entry, result));
  }

  return {
    probesPlanned: plan.length,
    probesRun,
    findingsCreated: findings.length,
    findings,
  };
}
