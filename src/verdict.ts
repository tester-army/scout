import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { SpecOperation, SpecResponse } from "./spec-loader.js";

export type Verdict = {
  status: number;
  expectedStatuses: string[];
  statusExpected: boolean | "unknown";
  expectMatched?: boolean;
  schemaValid: boolean | "unknown";
  schemaErrors: string[];
  schemaNote?: string;
  contentTypeMatch: boolean | "unknown";
  latencyMs: number;
  redacted: boolean;
};

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

function selectContentSchema(
  response: SpecResponse,
  contentType: string | undefined,
): { schema: unknown; declaredContentTypes: string[] } {
  const content = response.content ?? {};
  const declaredContentTypes = Object.keys(content);
  if (declaredContentTypes.length === 0) {
    return { schema: undefined, declaredContentTypes };
  }

  const normalized = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const exactKey = declaredContentTypes.find((key) => key.toLowerCase() === normalized);
  if (exactKey) {
    return { schema: content[exactKey]?.schema, declaredContentTypes };
  }

  const jsonKey = declaredContentTypes.find((key) => key.toLowerCase().includes("json"));
  if (normalized.includes("json") && jsonKey) {
    return { schema: content[jsonKey]?.schema, declaredContentTypes };
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
  const { operation, status } = options;

  const base = {
    status,
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
  const normalizedContentType = (options.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  const contentTypeMatch: Verdict["contentTypeMatch"] =
    declaredContentTypes.length === 0
      ? "unknown"
      : declaredContentTypes.some(
          (key) =>
            key.toLowerCase() === normalizedContentType ||
            (key.toLowerCase().includes("json") && (normalizedContentType ?? "").includes("json")),
        );

  if (schema === undefined || schema === null || typeof schema !== "object") {
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

  const validator = compileValidator(schema, options.specVersion);
  if (!validator) {
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

  const valid = validator(options.body);
  const schemaErrors = valid
    ? []
    : (validator.errors ?? []).map(
        (error) => `${error.instancePath || "(root)"} ${error.message ?? "invalid"}`,
      );

  return {
    ...base,
    expectedStatuses,
    statusExpected,
    schemaValid: Boolean(valid),
    schemaErrors,
    contentTypeMatch,
  };
}
