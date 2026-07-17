import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { operationKey, type SpecOperation, type SpecResponse } from "./spec-loader.js";

export type Verdict = {
  /** Pre-computed pass/fail: false on any definitive contract violation. */
  ok: boolean;
  /** One-line human-readable summary of the verdict. */
  summary: string;
  status: number;
  expectedStatuses: string[];
  statusExpected: boolean | "unknown";
  expectMatched?: boolean;
  schemaValid: boolean | "unknown";
  schemaErrors: string[];
  schemaNote?: string;
  contentTypeMatch: boolean | "unknown";
  /** True when the response status is 5xx — a server-side failure. */
  serverError: boolean;
  latencyMs: number;
  redacted: boolean;
};

type VerdictCore = Omit<Verdict, "ok" | "summary">;

/**
 * A verdict fails only on a definitive contract violation: a schema
 * mismatch, an unmet `--expect`, or an undocumented status. "unknown"
 * checks never fail — scout cannot judge what the spec does not describe.
 *
 * An explicit `--expect` is a user assertion and takes precedence: if the
 * user expected this status and got it, an undocumented status does not
 * fail the verdict (the spec gap is surfaced separately, not as a failure).
 */
export function isVerdictOk(verdict: VerdictCore): boolean {
  if (verdict.expectMatched === false) return false;
  if (verdict.contentTypeMatch === false) return false;
  if (verdict.schemaValid === false) return false;
  // An explicit --expect is a user assertion and wins. Absent one, an
  // unrequested server error or undocumented status fails the verdict.
  if (verdict.expectMatched === undefined) {
    if (verdict.serverError) return false;
    if (verdict.statusExpected === false) return false;
  }
  return true;
}

function describeStatusExpected(verdict: VerdictCore): string {
  if (verdict.statusExpected === "unknown") return "undocumented";
  if (verdict.statusExpected) return "expected";
  // Status is not in the spec. If the user asserted it via --expect and it
  // matched, that is a spec gap, not a failure.
  return verdict.expectMatched === true ? "not-in-spec" : "UNEXPECTED";
}

/** Renders the compact one-line verdict summary. */
export function summarizeVerdict(verdict: VerdictCore): string {
  const parts: string[] = [];

  if (verdict.expectMatched !== undefined) {
    parts.push(verdict.expectMatched ? "expect: matched" : "expect: MISMATCH");
  }

  parts.push(`status: ${describeStatusExpected(verdict)}`);

  if (verdict.serverError) {
    parts.push("SERVER ERROR");
  }

  if (verdict.schemaValid === "unknown") {
    parts.push(`schema: n/a${verdict.schemaNote ? ` (${verdict.schemaNote})` : ""}`);
  } else {
    parts.push(verdict.schemaValid ? "schema: valid" : "schema: INVALID");
  }

  if (verdict.contentTypeMatch === false) {
    parts.push("content-type: MISMATCH");
  }

  parts.push(`${verdict.latencyMs}ms`);

  const glyph = isVerdictOk(verdict) ? "PASS" : "FAIL";
  return `${glyph} · ${parts.join(" · ")}`;
}

function finalizeVerdict(core: VerdictCore): Verdict {
  return { ...core, ok: isVerdictOk(core), summary: summarizeVerdict(core) };
}

let ajv30: Ajv | null = null;
let ajv31: Ajv | null = null;
const validatorCache = new WeakMap<object, ValidateFunction | null>();

function getAjv(specVersion: string): Ajv {
  if (specVersion.startsWith("3.1")) {
    if (!ajv31) {
      ajv31 = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false });
      addFormats(ajv31);
    }
    return ajv31;
  }

  if (!ajv30) {
    ajv30 = new Ajv({ strict: false, allErrors: true, validateFormats: true, logger: false });
    addFormats(ajv30);
  }
  return ajv30;
}

type SchemaTransformOptions = {
  /** Apply OpenAPI 3.0 → JSON Schema fixups (`nullable`, duplicate enums). */
  normalize: boolean;
  /**
   * When set, rewrites local `#/components/...` refs to point into the
   * shared components document registered under this `$id`, so ajv compiles
   * each component schema once instead of once per operation.
   */
  refBaseId?: string;
};

/**
 * Clones a schema for ajv, optionally normalizing OpenAPI 3.0 constructs
 * (`nullable: true` into JSON Schema null unions; duplicate enum entries,
 * which real-world specs (e.g. Vercel) contain and ajv rejects as invalid)
 * and rewriting `#/components/...` refs to a shared registered document.
 */
function transformSchema(
  schema: unknown,
  memo: Map<object, unknown>,
  options: SchemaTransformOptions,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const existing = memo.get(schema);
  if (existing !== undefined) {
    return existing;
  }
  if (Array.isArray(schema)) {
    const items: unknown[] = [];
    memo.set(schema, items);
    for (const item of schema) items.push(transformSchema(item, memo, options));
    return items;
  }

  const result: Record<string, unknown> = {};
  memo.set(schema, result);
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (
      key === "$ref" &&
      options.refBaseId !== undefined &&
      typeof value === "string" &&
      value.startsWith("#/components/")
    ) {
      result[key] = `${options.refBaseId}${value}`;
      continue;
    }
    result[key] = transformSchema(value, memo, options);
  }

  if (!options.normalize) {
    return result;
  }

  if (Array.isArray(result.enum)) {
    const seen = new Set<string>();
    result.enum = result.enum.filter((value) => {
      const key = JSON.stringify(value) ?? "undefined";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (result.nullable === true) {
    delete result.nullable;
    if (Array.isArray(result.enum) && !result.enum.includes(null)) {
      result.enum = [...result.enum, null];
    }
    if (typeof result.type === "string") {
      result.type = [result.type, "null"];
    } else if (Array.isArray(result.type) && !result.type.includes("null")) {
      result.type = [...result.type, "null"];
    } else if (result.type === undefined) {
      // `nullable: true` beside anyOf/oneOf/$ref (no `type`): allow null via
      // a union branch, since bare `type: "null"` would reject everything else.
      for (const keyword of ["anyOf", "oneOf"] as const) {
        if (Array.isArray(result[keyword])) {
          result[keyword] = [...(result[keyword] as unknown[]), { type: "null" }];
          break;
        }
      }
    }
  }

  return result;
}

const componentsIdCache = new WeakMap<object, string>();
let componentsIdCounter = 0;

/**
 * Registers a spec's `components` with the ajv instance once (under a stable
 * synthetic `$id`) so that every response schema referencing them shares one
 * compilation of each component schema, instead of ajv recompiling the whole
 * component graph per operation — prohibitively slow on large specs (Stripe).
 */
function registerComponents(ajv: Ajv, components: object, specVersion: string): string {
  let id = componentsIdCache.get(components);
  if (id === undefined) {
    id = `scout://spec-components/${componentsIdCounter++}`;
    componentsIdCache.set(components, id);
  }
  if (!ajv.getSchema(id)) {
    const prepared = specVersion.startsWith("3.1")
      ? components
      : transformSchema(components, new Map(), { normalize: true });
    ajv.addSchema({ $id: id, components: prepared });
  }
  return id;
}

/**
 * Compiles a response/request schema, resolving any `#/components/...` refs
 * that survive dereferencing (circular refs are intentionally left as `$ref`
 * nodes) against the spec's components registered as a shared ajv document.
 */
function compileValidator(
  schema: object,
  specVersion: string,
  components?: object,
): ValidateFunction | null {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }

  let validator: ValidateFunction | null = null;
  try {
    const ajv = getAjv(specVersion);
    const refBaseId =
      components && !("components" in schema)
        ? registerComponents(ajv, components, specVersion)
        : undefined;
    const prepared = transformSchema(schema, new Map(), {
      normalize: !specVersion.startsWith("3.1"),
      refBaseId,
    }) as object;
    validator = ajv.compile(prepared);
  } catch {
    validator = null;
  }

  validatorCache.set(schema, validator);
  return validator;
}

/**
 * Counts operations whose response schemas cannot be compiled by ajv (usually
 * unresolved `$ref`s or invalid JSON Schema). These silently degrade to
 * `schema: n/a` at request time — indistinguishable from "no schema defined" —
 * so init surfaces the count up front instead of letting validation look
 * load-bearing when it isn't.
 */
export function countUncompilableSchemaOperations(
  operations: SpecOperation[],
  specVersion: string,
  components?: object,
): { count: number; operations: string[] } {
  const uncompilable: string[] = [];
  for (const operation of operations) {
    let hasUncompilable = false;
    for (const response of Object.values(operation.responses)) {
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        if (!mediaType.toLowerCase().includes("json")) continue;
        const schema = media?.schema;
        if (!schema || (typeof schema !== "object" && typeof schema !== "boolean")) continue;
        if (typeof schema === "boolean") continue;
        if (compileValidator(schema, specVersion, components) === null) {
          hasUncompilable = true;
          break;
        }
      }
      if (hasUncompilable) break;
    }
    if (hasUncompilable) uncompilable.push(operationKey(operation));
  }
  return { count: uncompilable.length, operations: uncompilable };
}

/**
 * Renders one ajv error as a human-actionable string, surfacing the
 * keyword-specific detail (e.g. which additional property was found,
 * which enum values are allowed) that `error.message` alone omits.
 */
function formatAjvError(error: ErrorObject): string {
  const path = error.instancePath || "(root)";
  const message = error.message ?? "invalid";
  const detail = describeAjvErrorParams(error);
  return detail ? `${path} ${message} (${detail})` : `${path} ${message}`;
}

function describeAjvErrorParams(error: ErrorObject): string | null {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return `found: ${String(params.additionalProperty)}`;
    case "unevaluatedProperties":
      return `found: ${String(params.unevaluatedProperty)}`;
    case "enum": {
      const allowed = params.allowedValues;
      return Array.isArray(allowed) ? `allowed: ${allowed.map(String).join(", ")}` : null;
    }
    case "const":
      return `allowed: ${JSON.stringify(params.allowedValue)}`;
    case "oneOf": {
      const passing = params.passingSchemas;
      return Array.isArray(passing) && passing.length > 0
        ? `matched schemas at indexes: ${passing.join(", ")}`
        : "matched none";
    }
    default:
      return null;
  }
}

/** Validates one JSON-compatible value against an OpenAPI response or request schema. */
export function validateSchemaValue(
  schema: object | boolean,
  specVersion: string,
  value: unknown,
  components?: object,
): { valid: boolean; errors: string[] } | null {
  if (schema === true) return { valid: true, errors: [] };
  if (schema === false) return { valid: false, errors: ["(root) boolean schema is false"] };
  const validator = compileValidator(schema, specVersion, components);
  if (!validator) return null;
  const valid = validator(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : (validator.errors ?? []).map(formatAjvError),
  };
}

/** Selects the response definition for a status: exact > 2XX-style > default. */
export function selectResponseSpec(
  responses: Record<string, SpecResponse>,
  status: number,
): { response: SpecResponse; matchedBy: "exact" | "wildcard" | "default" } | null {
  const exact = responses[String(status)];
  if (exact) return { response: exact, matchedBy: "exact" };

  const wildcard = responses[`${Math.floor(status / 100)}XX`];
  if (wildcard) return { response: wildcard, matchedBy: "wildcard" };

  if (responses.default) return { response: responses.default, matchedBy: "default" };

  return null;
}

function normalizeMediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Matches a concrete media type against an OpenAPI media range. */
export function mediaTypeMatches(declared: string, actual: string | undefined): boolean {
  const [declaredType, declaredSubtype] = normalizeMediaType(declared).split("/");
  const [actualType, actualSubtype] = normalizeMediaType(actual).split("/");
  if (!declaredType || !declaredSubtype || !actualType || !actualSubtype) return false;
  if (declaredType !== "*" && declaredType !== actualType) return false;
  if (declaredSubtype === "*" || declaredSubtype === actualSubtype) return true;
  if (declaredSubtype.startsWith("*+")) {
    return actualSubtype.endsWith(declaredSubtype.slice(1));
  }
  return false;
}

function selectContentSchema(
  response: SpecResponse,
  contentType: string | undefined,
): { schema: unknown; declaredContentTypes: string[] } {
  const content = response.content ?? {};
  const declaredContentTypes = Object.keys(content);
  if (declaredContentTypes.length === 0) {
    return { schema: undefined, declaredContentTypes };
  }

  const matchedKey = declaredContentTypes.find((key) => mediaTypeMatches(key, contentType));
  if (matchedKey) {
    return { schema: content[matchedKey]?.schema, declaredContentTypes };
  }

  return { schema: undefined, declaredContentTypes };
}

/** Builds the mechanical verdict scout attaches to every executed request. */
type BuildVerdictOptions = {
  operation: SpecOperation | null;
  specVersion: string;
  /** Spec `components`, used to resolve `$ref`s left by circular dereferencing. */
  components?: object;
  status: number;
  contentType?: string;
  body: unknown;
  bodyIsJson: boolean;
  latencyMs: number;
  expect?: number;
  redacted: boolean;
};

export function buildVerdict(options: BuildVerdictOptions): Verdict {
  return finalizeVerdict(buildVerdictCore(options));
}

function buildVerdictCore(options: BuildVerdictOptions): VerdictCore {
  const { operation, status } = options;

  const base = {
    status,
    serverError: status >= 500,
    latencyMs: options.latencyMs,
    redacted: options.redacted,
    ...(options.expect !== undefined ? { expectMatched: status === options.expect } : {}),
  };

  if (!operation) {
    return {
      ...base,
      expectedStatuses: [],
      statusExpected: "unknown",
      schemaValid: "unknown",
      schemaErrors: [],
      schemaNote: "operation not found in spec — cannot validate",
      contentTypeMatch: "unknown",
    };
  }

  const expectedStatuses = Object.keys(operation.responses);
  const selected = selectResponseSpec(operation.responses, status);
  const statusExpected: Verdict["statusExpected"] =
    expectedStatuses.length === 0 ? "unknown" : selected !== null;

  if (!selected) {
    return {
      ...base,
      expectedStatuses,
      statusExpected,
      schemaValid: "unknown",
      schemaErrors: [],
      schemaNote: `spec declares no response for status ${status}`,
      contentTypeMatch: "unknown",
    };
  }

  const { schema, declaredContentTypes } = selectContentSchema(
    selected.response,
    options.contentType,
  );
  const contentTypeMatch: Verdict["contentTypeMatch"] =
    declaredContentTypes.length === 0
      ? "unknown"
      : declaredContentTypes.some((key) => mediaTypeMatches(key, options.contentType));

  if (
    schema === undefined ||
    schema === null ||
    (typeof schema !== "object" && typeof schema !== "boolean")
  ) {
    return {
      ...base,
      expectedStatuses,
      statusExpected,
      schemaValid: "unknown",
      schemaErrors: [],
      schemaNote: "no schema defined for this response",
      contentTypeMatch,
    };
  }

  if (!options.bodyIsJson) {
    return {
      ...base,
      expectedStatuses,
      statusExpected,
      schemaValid: "unknown",
      schemaErrors: [],
      schemaNote: "response body is not JSON — cannot validate against schema",
      contentTypeMatch,
    };
  }

  const validation = validateSchemaValue(
    schema,
    options.specVersion,
    options.body,
    options.components,
  );
  if (!validation) {
    return {
      ...base,
      expectedStatuses,
      statusExpected,
      schemaValid: "unknown",
      schemaErrors: [],
      schemaNote: "schema could not be compiled (unresolved $refs or invalid schema)",
      contentTypeMatch,
    };
  }

  return {
    ...base,
    expectedStatuses,
    statusExpected,
    schemaValid: validation.valid,
    schemaErrors: validation.errors,
    contentTypeMatch,
  };
}
