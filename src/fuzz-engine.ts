import { ScoutError } from "./errors.js";
import { createFinding, type Finding } from "./findings.js";
import { executeCall, type CallResult, type ExecutorContext } from "./http-executor.js";
import { loadSessionState } from "./session-store.js";
import { operationKey, type SpecOperation } from "./spec-loader.js";
import { validateSchemaValue } from "./verdict.js";

const DEFAULT_MAX_CASES = 25;
const DEFAULT_OVERSIZED_LENGTH = 4096;
const MAX_OVERSIZED_LENGTH = 65_536;
const MAX_SCHEMA_DEPTH = 6;
const MAX_BASELINE_ARRAY_ITEMS = 20;
const MALFORMED_JSON = '{"__scout_malformed":';
const MAX_FUZZ_CASES = 100;
const MAX_FUZZ_ATTEMPTS = 500;
export const MAX_FUZZ_BODY_BYTES = 256 * 1024;

type JsonSchema = Record<string, unknown>;
export type RequestSchema = JsonSchema | boolean;
type JsonPath = Array<string | number>;

export type FuzzCaseKind =
  | "malformed-json"
  | "null"
  | "wrong-type"
  | "missing-required"
  | "boundary"
  | "oversized"
  | "unknown-field"
  | "enum";

export type FuzzCase = {
  id: string;
  kind: FuzzCaseKind;
  title: string;
  target: string;
  expectedReject: boolean;
  body?: unknown;
  rawBody?: string;
};

export type FuzzPlanOptions = {
  maxCases?: number;
  oversizedLength?: number;
  specVersion?: string;
};

export type FuzzRunOptions = FuzzPlanOptions & {
  caseId?: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

/** Selects one reproducible fuzz case by stable id, or returns the full plan. */
export function selectFuzzCases(cases: FuzzCase[], caseId?: string): FuzzCase[] {
  if (!caseId) return cases;
  const selected = cases.filter((fuzzCase) => fuzzCase.id === caseId);
  if (selected.length === 0) {
    throw new ScoutError(`Unknown fuzz case "${caseId}".`, {
      code: "NOT_FOUND",
      hint: "Run the same fuzz command with --dry-run --json to list stable case IDs.",
    });
  }
  return selected;
}

export type FuzzCaseResult = {
  case: Omit<FuzzCase, "body" | "rawBody">;
  requestId: string;
  status: number;
  verdict: CallResult["verdict"];
};

export type FuzzSummary = {
  runId: string;
  casesPlanned: number;
  casesRun: number;
  findingsCreated: number;
  stoppedReason?: "rate-limited" | "budget-limited";
  findings: Finding[];
  results: FuzzCaseResult[];
};

/** Returns the serialized byte size of a JSON-compatible fuzz body. */
export function fuzzBodySize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf-8");
}

/** Reads an own property without traversing an adversarial prototype chain. */
function getOwnValue(
  container: Record<string, unknown> | unknown[],
  key: string | number,
): unknown {
  return Object.prototype.hasOwnProperty.call(container, key)
    ? Reflect.get(container, key)
    : undefined;
}

/** Defines an enumerable own property without invoking __proto__ setters. */
function setOwnValue(
  container: Record<string, unknown> | unknown[],
  key: string | number,
  value: unknown,
): void {
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Clones a schema for request validation and removes readOnly-only requirements. */
function prepareRequestSchema(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(prepareRequestSchema(item, seen));
    return result;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(source)) {
    setOwnValue(result, key, prepareRequestSchema(item, seen));
  }
  const allOfBranches = Array.isArray(result.allOf)
    ? result.allOf.filter(
        (branch): branch is Record<string, unknown> =>
          Boolean(branch) && typeof branch === "object" && !Array.isArray(branch),
      )
    : [];
  const propertySources = [result, ...allOfBranches]
    .map((branch) => branch.properties)
    .filter(
      (properties): properties is Record<string, unknown> =>
        Boolean(properties) && typeof properties === "object" && !Array.isArray(properties),
    );
  const readOnlyNames = new Set<string>();
  for (const properties of propertySources) {
    for (const [name, property] of Object.entries(properties)) {
      if (property && typeof property === "object" && (property as JsonSchema).readOnly === true) {
        readOnlyNames.add(name);
      }
    }
  }
  for (const branch of [result, ...allOfBranches]) {
    if (Array.isArray(branch.required)) {
      branch.required = branch.required.filter(
        (name): name is string => typeof name === "string" && !readOnlyNames.has(name),
      );
    }
  }
  return result;
}

/**
 * Returns a request-body schema from the operation's first JSON-compatible
 * media type, falling back to application/x-www-form-urlencoded (whose
 * schemas are the same JSON Schema objects; the executor form-encodes
 * structured bodies for form-only operations).
 */
export function selectJsonRequestSchema(operation: SpecOperation): RequestSchema | null {
  const content = operation.requestBody?.content ?? {};
  const keys = Object.keys(content);
  const mediaType =
    keys.find((key) => {
      const normalized = key.toLowerCase();
      return normalized === "application/json" || normalized.endsWith("+json");
    }) ??
    keys.find(
      (key) => key.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded",
    );
  const schema = mediaType ? content[mediaType]?.schema : undefined;
  return typeof schema === "boolean" || (schema && typeof schema === "object")
    ? (prepareRequestSchema(schema) as RequestSchema)
    : null;
}

/** Resolves the effective schema branch used for deterministic value generation. */
function effectiveSchema(schema: JsonSchema): JsonSchema {
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      const first = alternatives.find(
        (candidate): candidate is JsonSchema => Boolean(candidate) && typeof candidate === "object",
      );
      if (first) return { ...schema, ...first, [keyword]: undefined };
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    return allOf.reduce<JsonSchema>(
      (merged, candidate) => {
        if (!candidate || typeof candidate !== "object") return merged;
        const branch = candidate as JsonSchema;
        return {
          ...merged,
          ...branch,
          properties: {
            ...((merged.properties as Record<string, unknown> | undefined) ?? {}),
            ...((branch.properties as Record<string, unknown> | undefined) ?? {}),
          },
          required: [
            ...new Set([
              ...((merged.required as string[] | undefined) ?? []),
              ...((branch.required as string[] | undefined) ?? []),
            ]),
          ],
        };
      },
      { ...schema, allOf: undefined },
    );
  }

  return schema;
}

/** Infers the JSON type when a schema omits an explicit type. */
function schemaType(schema: JsonSchema): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return type.find((candidate): candidate is string => candidate !== "null");
  }
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return undefined;
}

/** Returns whether null is explicitly accepted by the schema. */
function allowsNull(schema: RequestSchema): boolean {
  if (typeof schema === "boolean") return schema;
  if (schema.nullable === true || schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return ["oneOf", "anyOf"].some((keyword) => {
    const alternatives = schema[keyword];
    return (
      Array.isArray(alternatives) &&
      alternatives.some(
        (candidate) =>
          candidate && typeof candidate === "object" && allowsNull(candidate as JsonSchema),
      )
    );
  });
}

/** Generates a minimal deterministic value intended to satisfy the supplied schema. */
export function generateBaselineValue(schemaInput: RequestSchema, depth = 0): unknown {
  if (typeof schemaInput === "boolean") return schemaInput ? {} : null;
  const schema = effectiveSchema(schemaInput);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const value = schema.enum.find((candidate) => candidate !== null) ?? schema.enum[0];
    return structuredClone(value);
  }
  if (depth >= MAX_SCHEMA_DEPTH) return null;

  switch (schemaType(schema)) {
    case "object": {
      const result: Record<string, unknown> = {};
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [];
      for (const name of required) {
        const property = properties[name];
        if (typeof property !== "boolean" && (!property || typeof property !== "object")) continue;
        const propertySchema = property as RequestSchema;
        if (typeof propertySchema === "object" && propertySchema.readOnly === true) continue;
        setOwnValue(result, name, generateBaselineValue(propertySchema, depth + 1));
      }
      return result;
    }
    case "array": {
      const itemSchema =
        typeof schema.items === "boolean" || (schema.items && typeof schema.items === "object")
          ? (schema.items as RequestSchema)
          : {};
      const minItems =
        typeof schema.minItems === "number"
          ? Math.min(Math.max(0, Math.trunc(schema.minItems)), MAX_BASELINE_ARRAY_ITEMS)
          : 0;
      return Array.from({ length: minItems }, () => generateBaselineValue(itemSchema, depth + 1));
    }
    case "integer": {
      const minimum = typeof schema.minimum === "number" ? Math.ceil(schema.minimum) : 0;
      return Number.isFinite(minimum) ? minimum : 0;
    }
    case "number": {
      const minimum = typeof schema.minimum === "number" ? schema.minimum : 0;
      return Number.isFinite(minimum) ? minimum : 0;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    case "string":
    default: {
      if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
      if (schema.format === "date") return "2000-01-01";
      if (schema.format === "date-time") return "2000-01-01T00:00:00.000Z";
      if (schema.format === "email") return "scout@example.invalid";
      const minLength =
        typeof schema.minLength === "number" ? Math.max(0, Math.trunc(schema.minLength)) : 1;
      return "s".repeat(Math.min(MAX_OVERSIZED_LENGTH, Math.max(1, minLength)));
    }
  }
}

/** Formats a JSON path as a JSON Pointer-like target. */
function formatPath(path: JsonPath): string {
  if (path.length === 0) return "/";
  return `/${path
    .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

/** Produces an ID-safe suffix from a JSON path. */
function pathId(path: JsonPath): string {
  return path.length === 0
    ? "root"
    : path.map((segment) => String(segment).replace(/[^A-Za-z0-9_-]/g, "-")).join("-");
}

/** Deeply sets a JSON-compatible value without mutating the baseline. */
function setAtPath(baseline: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return structuredClone(value);
  const result = structuredClone(baseline) as Record<string, unknown> | unknown[];
  if (!result || typeof result !== "object") return baseline;
  let current: Record<string, unknown> | unknown[] = result;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index] as string | number;
    const nextSegment = path[index + 1];
    let next = getOwnValue(current, segment);
    if (!next || typeof next !== "object") {
      next = typeof nextSegment === "number" ? [] : {};
      setOwnValue(current, segment, next);
    }
    current = next as Record<string, unknown> | unknown[];
  }
  const leaf = path.at(-1) as string | number;
  setOwnValue(current, leaf, structuredClone(value));
  return result;
}

/** Deeply removes one property without mutating the baseline. */
function removeAtPath(baseline: unknown, path: JsonPath): unknown {
  if (path.length === 0) return undefined;
  const result = structuredClone(baseline) as Record<string, unknown> | unknown[];
  if (!result || typeof result !== "object") return baseline;
  let current: Record<string, unknown> | unknown[] = result;
  for (const segment of path.slice(0, -1)) {
    const next = getOwnValue(current, segment);
    if (!next || typeof next !== "object") return result;
    current = next as Record<string, unknown> | unknown[];
  }
  const leaf = path.at(-1) as string | number;
  if (Array.isArray(current) && typeof leaf === "number") current.splice(leaf, 1);
  else Reflect.deleteProperty(current, leaf);
  return result;
}

/** Returns a deterministic value incompatible with the schema's primary type. */
function wrongTypeValue(schema: RequestSchema): unknown {
  if (typeof schema === "boolean") return undefined;
  switch (schemaType(effectiveSchema(schema))) {
    case "object":
      return "scout-wrong-type";
    case "array":
      return {};
    case "string":
      return 12345;
    case "integer":
    case "number":
      return "scout-wrong-type";
    case "boolean":
      return "scout-wrong-type";
    case "null":
      return {};
    default:
      return undefined;
  }
}

/** Builds deterministic negative cases by mutating one schema dimension at a time. */
export function planFuzzCases(
  schemaInput: RequestSchema,
  baseline: unknown,
  options: FuzzPlanOptions = {},
): FuzzCase[] {
  const maxCases = Math.max(0, Math.min(options.maxCases ?? DEFAULT_MAX_CASES, MAX_FUZZ_CASES));
  if (maxCases === 0) return [];
  if (fuzzBodySize(baseline) > MAX_FUZZ_BODY_BYTES) {
    throw new Error(`Fuzz baseline exceeds ${MAX_FUZZ_BODY_BYTES} bytes.`);
  }
  const specVersion = options.specVersion ?? "3.1.0";
  const oversizedLength = Math.min(
    Math.max(1, options.oversizedLength ?? DEFAULT_OVERSIZED_LENGTH),
    MAX_OVERSIZED_LENGTH,
  );
  const cases: FuzzCase[] = [];
  const fingerprints = new Set<string>();
  let attempts = 0;

  /** Adds a unique case until the configured cap is reached. */
  const addCase = (candidate: FuzzCase): void => {
    if (cases.length >= maxCases || attempts >= MAX_FUZZ_ATTEMPTS) return;
    attempts += 1;
    let evaluated = candidate;
    if (candidate.rawBody !== undefined) {
      if (Buffer.byteLength(candidate.rawBody, "utf-8") > MAX_FUZZ_BODY_BYTES) return;
    } else {
      if (fuzzBodySize(candidate.body) > MAX_FUZZ_BODY_BYTES) return;
      const validation = validateSchemaValue(schemaInput, specVersion, candidate.body);
      if (validation) {
        if (candidate.expectedReject && validation.valid) return;
        evaluated = { ...candidate, expectedReject: !validation.valid };
      }
    }
    const fingerprint = `${evaluated.kind}:${evaluated.target}:${
      evaluated.rawBody ?? JSON.stringify(evaluated.body)
    }`;
    if (fingerprints.has(fingerprint)) return;
    fingerprints.add(fingerprint);
    cases.push(evaluated);
  };

  addCase({
    id: "malformed-json",
    kind: "malformed-json",
    title: "Malformed JSON body",
    target: "/",
    expectedReject: true,
    rawBody: MALFORMED_JSON,
  });

  /** Traverses request-schema nodes and emits local mutations. */
  const visit = (
    schemaValue: RequestSchema,
    path: JsonPath,
    depth: number,
    workingBaseline: unknown,
  ): void => {
    if (cases.length >= maxCases || attempts >= MAX_FUZZ_ATTEMPTS || depth >= MAX_SCHEMA_DEPTH) {
      return;
    }
    attempts += 1;
    if (typeof schemaValue === "boolean") return;
    const schema = effectiveSchema(schemaValue);
    const target = formatPath(path);
    const suffix = pathId(path);

    if (!allowsNull(schemaValue)) {
      addCase({
        id: `null-${suffix}`,
        kind: "null",
        title: `Null at ${target}`,
        target,
        expectedReject: true,
        body: setAtPath(workingBaseline, path, null),
      });
    }

    const wrongType = wrongTypeValue(schema);
    if (wrongType !== undefined) {
      addCase({
        id: `wrong-type-${suffix}`,
        kind: "wrong-type",
        title: `Wrong type at ${target}`,
        target,
        expectedReject: true,
        body: setAtPath(workingBaseline, path, wrongType),
      });
    }

    const type = schemaType(schema);
    if (type === "object") {
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((name): name is string => typeof name === "string")
          : [],
      );
      const unknownPath = [...path, "__scout_unknown"];
      addCase({
        id: `unknown-field-${suffix}`,
        kind: "unknown-field",
        title: `Unknown field at ${target}`,
        target: formatPath(unknownPath),
        expectedReject: schema.additionalProperties === false,
        body: setAtPath(workingBaseline, unknownPath, "scout-unknown"),
      });

      for (const name of Object.keys(properties)) {
        if (cases.length >= maxCases || attempts >= MAX_FUZZ_ATTEMPTS) break;
        const property = properties[name];
        if (typeof property !== "boolean" && (!property || typeof property !== "object")) continue;
        const propertySchema = property as RequestSchema;
        if (typeof propertySchema === "object" && propertySchema.readOnly === true) continue;
        const propertyPath = [...path, name];
        if (required.has(name)) {
          addCase({
            id: `missing-required-${pathId(propertyPath)}`,
            kind: "missing-required",
            title: `Missing required field ${formatPath(propertyPath)}`,
            target: formatPath(propertyPath),
            expectedReject: true,
            body: removeAtPath(workingBaseline, propertyPath),
          });
        }
        const propertyBaseline = setAtPath(
          workingBaseline,
          propertyPath,
          generateBaselineValue(propertySchema, depth + 1),
        );
        visit(propertySchema, propertyPath, depth + 1, propertyBaseline);
      }
      return;
    }

    if (type === "string") {
      const minLength = typeof schema.minLength === "number" ? schema.minLength : undefined;
      const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
      if (minLength !== undefined && minLength > 0) {
        addCase({
          id: `below-min-length-${suffix}`,
          kind: "boundary",
          title: `String below minLength at ${target}`,
          target,
          expectedReject: true,
          body: setAtPath(workingBaseline, path, "s".repeat(Math.max(0, minLength - 1))),
        });
      }
      const desiredLength = maxLength !== undefined ? maxLength + 1 : oversizedLength;
      if (desiredLength <= MAX_OVERSIZED_LENGTH) {
        addCase({
          id: `oversized-${suffix}`,
          kind: "oversized",
          title: `Oversized string at ${target}`,
          target,
          expectedReject: maxLength !== undefined,
          body: setAtPath(workingBaseline, path, "x".repeat(Math.max(1, desiredLength))),
        });
      }
    }

    if (type === "integer" || type === "number") {
      const step = type === "integer" ? 1 : 0.1;
      if (typeof schema.minimum === "number") {
        addCase({
          id: `below-minimum-${suffix}`,
          kind: "boundary",
          title: `Number below minimum at ${target}`,
          target,
          expectedReject: true,
          body: setAtPath(workingBaseline, path, schema.minimum - step),
        });
      }
      if (typeof schema.maximum === "number") {
        addCase({
          id: `above-maximum-${suffix}`,
          kind: "boundary",
          title: `Number above maximum at ${target}`,
          target,
          expectedReject: true,
          body: setAtPath(workingBaseline, path, schema.maximum + step),
        });
      }
    }

    if (type === "array") {
      const itemSchema =
        typeof schema.items === "boolean" || (schema.items && typeof schema.items === "object")
          ? (schema.items as RequestSchema)
          : {};
      if (typeof schema.minItems === "number" && schema.minItems > 0) {
        const count = Math.max(0, Math.trunc(schema.minItems) - 1);
        addCase({
          id: `below-min-items-${suffix}`,
          kind: "boundary",
          title: `Array below minItems at ${target}`,
          target,
          expectedReject: true,
          body: setAtPath(
            workingBaseline,
            path,
            Array.from({ length: count }, () => generateBaselineValue(itemSchema, depth + 1)),
          ),
        });
      }
      if (typeof schema.maxItems === "number" && schema.maxItems + 1 <= MAX_BASELINE_ARRAY_ITEMS) {
        addCase({
          id: `above-max-items-${suffix}`,
          kind: "boundary",
          title: `Array above maxItems at ${target}`,
          target,
          expectedReject: true,
          body: setAtPath(
            workingBaseline,
            path,
            Array.from({ length: Math.trunc(schema.maxItems) + 1 }, () =>
              generateBaselineValue(itemSchema, depth + 1),
            ),
          ),
        });
      }
      const itemBaseline = setAtPath(
        workingBaseline,
        [...path, 0],
        generateBaselineValue(itemSchema, depth + 1),
      );
      visit(itemSchema, [...path, 0], depth + 1, itemBaseline);
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const invalidValue = schema.enum.every((value) => value !== "__scout_invalid_enum")
        ? "__scout_invalid_enum"
        : 9_007_199_254_740_991;
      addCase({
        id: `invalid-enum-${suffix}`,
        kind: "enum",
        title: `Value outside enum at ${target}`,
        target,
        expectedReject: true,
        body: setAtPath(workingBaseline, path, invalidValue),
      });
    }
  };

  visit(schemaInput, [], 0, baseline);
  return cases;
}

/** Builds a sanitized finding for a fuzz case result. */
function findingFor(
  operation: SpecOperation,
  fuzzCase: FuzzCase,
  result: CallResult,
  input: Pick<Finding, "severity" | "category" | "title" | "description"> & {
    status?: Finding["status"];
  },
): Finding {
  return createFinding({
    source: "fuzz",
    severity: input.severity,
    category: input.category,
    endpoint: operationKey(operation),
    title: input.title,
    ...(input.status ? { status: input.status } : {}),
    description: input.description,
    evidence: [
      `case=${fuzzCase.id} target=${fuzzCase.target} status=${result.response.status} latency=${result.verdict.latencyMs}ms`,
      ...result.verdict.schemaErrors.slice(0, 5),
    ],
    repro: `scout fuzz ${operation.method.toUpperCase()} ${operation.path} --case ${fuzzCase.id}`,
  });
}

/** Evaluates one fuzz response into contract and error-handling candidates. */
export function evaluateFuzzCase(
  operation: SpecOperation,
  fuzzCase: FuzzCase,
  result: CallResult,
): Finding[] {
  const findings: Finding[] = [];
  if (result.response.status >= 500) {
    findings.push(
      findingFor(operation, fuzzCase, result, {
        severity: "high",
        category: "error-handling",
        title: `Server error for fuzz case: ${fuzzCase.title}`,
        description: `The ${fuzzCase.kind} case produced ${result.response.status}. Invalid input should fail without a server error.`,
      }),
    );
  }
  if (fuzzCase.expectedReject && result.response.status >= 200 && result.response.status < 300) {
    findings.push(
      findingFor(operation, fuzzCase, result, {
        severity: "medium",
        category: "contract-violation",
        status: "candidate",
        title: `Potential invalid-input acceptance: ${fuzzCase.title}`,
        description:
          "The request violates the documented request schema but returned 2xx. Validate response semantics and side effects before confirming the finding.",
      }),
    );
  }
  if (result.verdict.statusExpected === false) {
    findings.push(
      findingFor(operation, fuzzCase, result, {
        severity: "medium",
        category: "contract-violation",
        title: `Undocumented fuzz response status ${result.response.status}`,
        description: `The operation returned ${result.response.status}, which is absent from its documented responses.`,
      }),
    );
  }
  if (result.verdict.schemaValid === false) {
    findings.push(
      findingFor(operation, fuzzCase, result, {
        severity: "high",
        category: "contract-violation",
        title: `Fuzz response schema mismatch for status ${result.response.status}`,
        description: "The response body failed validation against the schema for this status.",
      }),
    );
  }
  if (result.verdict.contentTypeMatch === false) {
    findings.push(
      findingFor(operation, fuzzCase, result, {
        severity: "medium",
        category: "contract-violation",
        title: `Fuzz response content type mismatch for status ${result.response.status}`,
        description: "The response Content-Type does not match its documented media types.",
      }),
    );
  }
  return findings;
}

/** Merges repeated mechanical findings while retaining bounded per-case evidence. */
function mergeFindings(target: Finding[], incoming: Finding[]): void {
  for (const finding of incoming) {
    const existing = target.find(
      (candidate) =>
        candidate.endpoint === finding.endpoint &&
        candidate.category === finding.category &&
        candidate.title === finding.title &&
        candidate.status === finding.status,
    );
    if (!existing) {
      target.push(finding);
      continue;
    }
    existing.evidence = [
      ...new Set([...(existing.evidence ?? []), ...(finding.evidence ?? [])]),
    ].slice(0, 10);
  }
}

/** Executes a fuzz plan through Scout's guarded, rate-limited HTTP executor. */
export async function runFuzz(
  context: ExecutorContext,
  operation: SpecOperation,
  schema: RequestSchema,
  baseline: unknown,
  options: FuzzRunOptions = {},
): Promise<FuzzSummary> {
  const plan = selectFuzzCases(planFuzzCases(schema, baseline, options), options.caseId);
  const state = loadSessionState(context.cwd);
  const remainingBudget = Math.max(0, context.policy.budget - state.requestCount);
  if (remainingBudget === 0) {
    return {
      runId: state.runId,
      casesPlanned: plan.length,
      casesRun: 0,
      findingsCreated: 0,
      stoppedReason: "budget-limited",
      findings: [],
      results: [],
    };
  }
  const selected = plan.slice(0, remainingBudget);
  const findings: Finding[] = [];
  const results: FuzzCaseResult[] = [];
  let stoppedReason: FuzzSummary["stoppedReason"] =
    selected.length < plan.length ? "budget-limited" : undefined;

  for (const fuzzCase of selected) {
    const result = await executeCall(context, {
      method: operation.method,
      path: operation.path,
      source: "fuzz",
      redactBodyEvidence: true,
      ...(options.pathParams ? { pathParams: options.pathParams } : {}),
      ...(options.query ? { query: options.query } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(fuzzCase.rawBody !== undefined ? { rawBody: fuzzCase.rawBody } : { body: fuzzCase.body }),
    });
    results.push({
      case: {
        id: fuzzCase.id,
        kind: fuzzCase.kind,
        title: fuzzCase.title,
        target: fuzzCase.target,
        expectedReject: fuzzCase.expectedReject,
      },
      requestId: result.requestId,
      status: result.response.status,
      verdict: result.verdict,
    });
    if (result.response.status === 429) {
      stoppedReason = "rate-limited";
      break;
    }
    mergeFindings(findings, evaluateFuzzCase(operation, fuzzCase, result));
  }

  return {
    runId: state.runId,
    casesPlanned: plan.length,
    casesRun: results.length,
    findingsCreated: findings.length,
    ...(stoppedReason ? { stoppedReason } : {}),
    findings,
    results,
  };
}
