import picomatch from "picomatch";
import { ScoutError } from "./errors.js";
import { HTTP_METHODS, type HttpMethod, type SpecOperation } from "./spec-loader.js";

export type OperationFilter = {
  tag?: string;
  path?: string;
  method?: string;
  search?: string;
};

/** Parses a --method flag value to a supported HTTP method. */
export function parseMethod(value: string): HttpMethod {
  const normalized = value.trim().toLowerCase();
  if ((HTTP_METHODS as readonly string[]).includes(normalized)) {
    return normalized as HttpMethod;
  }

  throw new Error(`--method must be one of: ${HTTP_METHODS.join(", ")}`);
}

/** Applies --tag/--path/--method/--search filters to an operation set. */
export function filterOperations(
  operations: SpecOperation[],
  filter: OperationFilter,
): SpecOperation[] {
  let result = operations;

  if (filter.tag) {
    const tag = filter.tag.toLowerCase();
    result = result.filter((op) => op.tags.some((t) => t.toLowerCase() === tag));
  }

  if (filter.path) {
    const isMatch = picomatch(filter.path, { nocase: true });
    result = result.filter((op) => isMatch(op.path));
  }

  if (filter.method) {
    const method = parseMethod(filter.method);
    result = result.filter((op) => op.method === method);
  }

  if (filter.search) {
    const query = filter.search.toLowerCase();
    result = result.filter((op) =>
      [op.path, op.operationId, op.summary, op.description, ...op.tags]
        .filter(Boolean)
        .some((text) => String(text).toLowerCase().includes(query)),
    );
  }

  return result;
}

/**
 * Resolves filters against the operation set, failing loudly when explicit
 * filters match nothing — silence would waste an agent's turn.
 */
export function resolveOperationsOrThrow(
  operations: SpecOperation[],
  filter: OperationFilter,
): SpecOperation[] {
  const result = filterOperations(operations, filter);
  const hasFilters = Boolean(filter.tag || filter.path || filter.method || filter.search);

  if (result.length === 0 && hasFilters) {
    const applied = [
      filter.tag ? `--tag ${filter.tag}` : null,
      filter.path ? `--path ${filter.path}` : null,
      filter.method ? `--method ${filter.method}` : null,
      filter.search ? `--search ${filter.search}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    throw new ScoutError(`No operations match ${applied}.`, {
      code: "VALIDATION_ERROR",
      hint: "Run `scout endpoints --json` to list available operations and tags.",
    });
  }

  return result;
}
