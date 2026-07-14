import { ScoutError } from "./errors.js";
import { loadCachedSpec } from "./session-store.js";
import { extractOperations, operationKey, parseHttpMethodArg } from "./spec-loader.js";

const DEFAULT_DEPTH = 6;

export type SchemaOptions = {
  json?: boolean;
  depth?: number;
  full?: boolean;
};

/**
 * Caps a fully-dereferenced schema at a nesting depth, replacing deeper
 * objects/arrays with a placeholder. Dereferencing inlines every $ref, so a
 * single operation on a large API (e.g. GitHub) can be tens of thousands of
 * tokens — this keeps the slice context-friendly. `--full` disables it.
 */
export function capDepth(value: unknown, maxDepth: number): { value: unknown; truncated: boolean } {
  let truncated = false;

  function walk(node: unknown, depth: number): unknown {
    if (Array.isArray(node)) {
      if (depth >= maxDepth && node.length > 0) {
        truncated = true;
        return "[…array — use --full]";
      }
      return node.map((item) => walk(item, depth + 1));
    }
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (depth >= maxDepth && entries.length > 0) {
        truncated = true;
        return "[…object — use --full]";
      }
      const out: Record<string, unknown> = {};
      for (const [key, val] of entries) {
        out[key] = walk(val, depth + 1);
      }
      return out;
    }
    return node;
  }

  return { value: walk(value, 0), truncated };
}

/** Prints the full schema detail for a single operation. */
export async function runSchemaCommand(
  method: string,
  path: string,
  options: SchemaOptions,
): Promise<void> {
  const loadedSpec = loadCachedSpec();
  const operations = extractOperations(loadedSpec.spec);
  const normalizedMethod = parseHttpMethodArg(method);

  const operation = operations.find((op) => op.method === normalizedMethod && op.path === path);

  if (!operation) {
    throw new ScoutError(`Operation ${method.toUpperCase()} ${path} not found in spec.`, {
      code: "NOT_FOUND",
      hint: "Run `scout endpoints --json` to list exact method/path pairs.",
    });
  }

  const maxDepth = options.full ? Number.POSITIVE_INFINITY : (options.depth ?? DEFAULT_DEPTH);
  const params = capDepth(operation.parameters, maxDepth);
  const requestBody = capDepth(operation.requestBody ?? null, maxDepth);
  const responses = capDepth(operation.responses, maxDepth);
  const truncated = params.truncated || requestBody.truncated || responses.truncated;

  const detail = {
    operation: operationKey(operation),
    operationId: operation.operationId ?? null,
    summary: operation.summary ?? null,
    description: operation.description ?? null,
    tags: operation.tags,
    deprecated: operation.deprecated,
    secured: operation.secured,
    authParameters: operation.authParameters,
    parameters: params.value,
    requestBody: requestBody.value,
    responses: responses.value,
    ...(truncated
      ? { truncated: true, hint: "Schema capped at depth for context. Pass --full for everything." }
      : {}),
  };

  console.log(JSON.stringify(detail, null, 2));
}
