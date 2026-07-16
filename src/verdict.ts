import { Ajv, type ValidateFunction } from "ajv";
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
      ajv31 = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
      addFormats(ajv31);
    }
    return ajv31;
  }

  if (!ajv30) {
    ajv30 = new Ajv({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv30);
  }
  return ajv30;
}

/**
 * Converts OpenAPI 3.0 `nullable: true` into JSON Schema `type: [..., "null"]`
 * so ajv validates null values the way the spec author intended.
 */
function transformNullable(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(transformNullable);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    result[key] = transformNullable(value);
  }

  if (result.nullable === true) {
    delete result.nullable;
    if (typeof result.type === "string") {
      result.type = [result.type, "null"];
    } else if (Array.isArray(result.type) && !result.type.includes("null")) {
      result.type = [...result.type, "null"];
    }
  }

  return result;
}

function compileValidator(schema: object, specVersion: string): ValidateFunction | null {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }

  let validator: ValidateFunction | null = null;
  try {
    const prepared = specVersion.startsWith("3.1")
      ? schema
      : (transformNullable(structuredClone(schema)) as object);
    validator = getAjv(specVersion).compile(prepared);
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
        if (compileValidator(schema, specVersion) === null) {
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

/** Validates one JSON-compatible value against an OpenAPI response or request schema. */
export function validateSchemaValue(
  schema: object | boolean,
  specVersion: string,
  value: unknown,
): { valid: boolean; errors: string[] } | null {
  if (schema === true) return { valid: true, errors: [] };
  if (schema === false) return { valid: false, errors: ["(root) boolean schema is false"] };
  const validator = compileValidator(schema, specVersion);
  if (!validator) return null;
  const valid = validator(value);
  return {
    valid: Boolean(valid),
    errors: valid
      ? []
      : (validator.errors ?? []).map(
          (error) => `${error.instancePath || "(root)"} ${error.message ?? "invalid"}`,
        ),
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
export function buildVerdict(options: {
  operation: SpecOperation | null;
  specVersion: string;
  status: number;
  contentType?: string;
  body: unknown;
  bodyIsJson: boolean;
  latencyMs: number;
  expect?: number;
  redacted: boolean;
}): Verdict {
  return finalizeVerdict(buildVerdictCore(options));
}

function buildVerdictCore(options: {
  operation: SpecOperation | null;
  specVersion: string;
  status: number;
  contentType?: string;
  body: unknown;
  bodyIsJson: boolean;
  latencyMs: number;
  expect?: number;
  redacted: boolean;
}): VerdictCore {
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

  const validation = validateSchemaValue(schema, options.specVersion, options.body);
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
