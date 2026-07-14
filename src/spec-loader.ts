import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { convertObj } from "swagger2openapi";
import { ScoutError } from "./errors.js";

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const SAFE_METHODS: readonly HttpMethod[] = ["get", "head", "options"];

const DISCOVERY_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/api-docs",
  "/v3/api-docs",
  "/api/openapi.json",
  "/.well-known/openapi.json",
];

export type SpecParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: unknown;
  example?: unknown;
};

export type SpecResponse = {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
};

export type SpecOperation = {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  secured: boolean;
  parameters: SpecParameter[];
  requestBody?: {
    required: boolean;
    content: Record<string, { schema?: unknown }>;
  };
  responses: Record<string, SpecResponse>;
};

export type OpenApiDocument = {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url?: string }>;
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, unknown>>;
  components?: unknown;
  tags?: Array<{ name?: string; description?: string }>;
};

export type LoadedSpec = {
  spec: OpenApiDocument;
  source: string;
  hash: string;
  title: string;
  version: string;
  specVersion: string;
  converted: boolean;
  dereferenced: boolean;
  warnings: string[];
  /** Absolute base URL derived from `servers[0]`, if resolvable. */
  defaultBaseUrl?: string;
};

/** Returns a stable content hash for a parsed spec document. */
export function hashSpec(spec: unknown): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Resolves an absolute base URL from the spec's first server entry.
 * Substitutes server-variable defaults, and resolves relative server URLs
 * (e.g. `/api`) against the spec's source URL when the spec was fetched
 * over HTTP. Returns undefined when nothing usable can be derived.
 */
export function resolveServerBaseUrl(spec: OpenApiDocument, source: string): string | undefined {
  const server = spec.servers?.[0];
  const rawUrl = server?.url?.trim();
  if (!rawUrl) {
    return undefined;
  }

  const variables = (server as { variables?: Record<string, { default?: unknown }> }).variables;
  const substituted = rawUrl.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const fallback = variables?.[name]?.default;
    return typeof fallback === "string" ? fallback : match;
  });

  if (/\{[^}]+\}/.test(substituted)) {
    return undefined;
  }

  try {
    if (isUrl(substituted)) {
      return substituted.replace(/\/$/, "");
    }
    if (isUrl(source)) {
      return new URL(substituted, source).toString().replace(/\/$/, "");
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Probes common well-known paths under a base URL for an OpenAPI spec.
 * Returns the first URL that responds 200 with a JSON/YAML-looking body.
 */
export async function discoverSpecUrl(baseUrl: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, "");
  const attempted: string[] = [];

  for (const path of DISCOVERY_PATHS) {
    const candidate = `${base}${path}`;
    attempted.push(candidate);
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const text = await response.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || /^(openapi|swagger)\s*:/m.test(trimmed.slice(0, 500))) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  throw new ScoutError(`No OpenAPI spec found under ${base}. Probed: ${attempted.join(", ")}`, {
    code: "SPEC_INVALID",
    hint: "Pass the spec location explicitly: `scout init <url-or-file>`.",
  });
}

/**
 * Loads, converts (Swagger 2 -> OpenAPI 3), and dereferences a spec from a
 * URL or local file. Imperfect specs degrade to warnings instead of hard
 * failures — broken refs become spec-quality findings later, not crashes.
 */
export async function loadSpec(source: string): Promise<LoadedSpec> {
  const warnings: string[] = [];
  const resolvedSource = isUrl(source) ? source : resolve(source);

  if (!isUrl(source) && !existsSync(resolvedSource)) {
    throw new ScoutError(`Spec file not found: ${resolvedSource}`, {
      code: "SPEC_INVALID",
      hint: "Check the path, or pass a URL. Use `scout init --discover --base-url <url>` to probe well-known spec locations.",
    });
  }

  let parsed: OpenApiDocument;
  try {
    parsed = (await SwaggerParser.parse(resolvedSource)) as unknown as OpenApiDocument;
  } catch (error) {
    throw new ScoutError(
      `Failed to parse spec from ${source}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "SPEC_INVALID",
        hint: "Ensure the source is valid OpenAPI 3.x or Swagger 2 JSON/YAML.",
        cause: error,
      },
    );
  }

  let converted = false;
  if (parsed.swagger === "2.0") {
    try {
      const result = await convertObj(parsed as never, { patch: true, warnOnly: true });
      parsed = result.openapi as unknown as OpenApiDocument;
      converted = true;
    } catch (error) {
      throw new ScoutError(
        `Failed to convert Swagger 2 spec to OpenAPI 3: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          code: "SPEC_INVALID",
          hint: "Fix the Swagger 2 document or provide an OpenAPI 3.x spec directly.",
          cause: error,
        },
      );
    }
  }

  if (!parsed.openapi && !converted) {
    throw new ScoutError(`Document from ${source} is not an OpenAPI 3.x or Swagger 2 spec.`, {
      code: "SPEC_INVALID",
      hint: 'The document must declare an `openapi: 3.x` or `swagger: "2.0"` version field.',
    });
  }

  let dereferenced = false;
  let finalSpec = parsed;
  try {
    finalSpec = (await SwaggerParser.dereference(
      structuredClone(parsed) as never,
      {
        dereference: { circular: "ignore" },
      } as never,
    )) as unknown as OpenApiDocument;
    dereferenced = true;
  } catch (error) {
    warnings.push(
      `Could not fully dereference spec: ${
        error instanceof Error ? error.message : String(error)
      }. Operations with unresolved $refs cannot be schema-validated.`,
    );
    try {
      finalSpec = (await SwaggerParser.bundle(
        structuredClone(parsed) as never,
      )) as unknown as OpenApiDocument;
    } catch {
      finalSpec = parsed;
    }
  }

  const defaultBaseUrl = resolveServerBaseUrl(finalSpec, source);

  return {
    spec: finalSpec,
    source,
    hash: hashSpec(finalSpec),
    title: finalSpec.info?.title ?? "Untitled API",
    version: finalSpec.info?.version ?? "0.0.0",
    specVersion: finalSpec.openapi ?? "3.0.0",
    converted,
    dereferenced,
    warnings,
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
  };
}

function resolveSecured(
  operationSecurity: unknown,
  documentSecurity: Array<Record<string, unknown>> | undefined,
): boolean {
  const effective = Array.isArray(operationSecurity)
    ? (operationSecurity as Array<Record<string, unknown>>)
    : (documentSecurity ?? []);
  return effective.some((requirement) => Object.keys(requirement ?? {}).length > 0);
}

function toSpecParameters(value: unknown): SpecParameter[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.name === "string" && typeof item.in === "string")
    .map((item) => ({
      name: item.name as string,
      in: item.in as SpecParameter["in"],
      required: Boolean(item.required),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(item.schema !== undefined ? { schema: item.schema } : {}),
      ...(item.example !== undefined ? { example: item.example } : {}),
    }));
}

/** Extracts a flat operation index from a dereferenced OpenAPI 3 document. */
export function extractOperations(spec: OpenApiDocument): SpecOperation[] {
  const operations: SpecOperation[] = [];
  const paths = spec.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathLevelParameters = toSpecParameters((pathItem as Record<string, unknown>).parameters);

    for (const method of HTTP_METHODS) {
      const raw = (pathItem as Record<string, unknown>)[method];
      if (!raw || typeof raw !== "object") continue;
      const operation = raw as Record<string, unknown>;

      const ownParameters = toSpecParameters(operation.parameters);
      const mergedParameters = [
        ...pathLevelParameters.filter(
          (pathParam) =>
            !ownParameters.some((own) => own.name === pathParam.name && own.in === pathParam.in),
        ),
        ...ownParameters,
      ];

      const requestBody =
        operation.requestBody && typeof operation.requestBody === "object"
          ? {
              required: Boolean((operation.requestBody as Record<string, unknown>).required),
              content:
                ((operation.requestBody as Record<string, unknown>).content as Record<
                  string,
                  { schema?: unknown }
                >) ?? {},
            }
          : undefined;

      operations.push({
        method,
        path,
        ...(typeof operation.operationId === "string"
          ? { operationId: operation.operationId }
          : {}),
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        ...(typeof operation.description === "string"
          ? { description: operation.description }
          : {}),
        tags: Array.isArray(operation.tags)
          ? operation.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        deprecated: Boolean(operation.deprecated),
        secured: resolveSecured(operation.security, spec.security),
        parameters: mergedParameters,
        ...(requestBody ? { requestBody } : {}),
        responses: (operation.responses as Record<string, SpecResponse>) ?? {},
      });
    }
  }

  return operations;
}

/** Returns a stable `METHOD /path` identifier for an operation. */
export function operationKey(operation: Pick<SpecOperation, "method" | "path">): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** Parses a positional method argument to a supported HTTP method. */
export function parseHttpMethodArg(value: string): HttpMethod {
  const normalized = value.trim().toLowerCase();
  if ((HTTP_METHODS as readonly string[]).includes(normalized)) {
    return normalized as HttpMethod;
  }

  throw new Error(`method must be one of: ${HTTP_METHODS.join(", ")}`);
}
