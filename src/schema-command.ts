import { ScoutError } from "./errors.js";
import { loadCachedSpec } from "./session-store.js";
import { extractOperations, operationKey, parseHttpMethodArg } from "./spec-loader.js";
import { isInteractive } from "./utils.js";

export type SchemaOptions = {
  json?: boolean;
};

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

  const detail = {
    operation: operationKey(operation),
    operationId: operation.operationId ?? null,
    summary: operation.summary ?? null,
    description: operation.description ?? null,
    tags: operation.tags,
    deprecated: operation.deprecated,
    secured: operation.secured,
    authParameters: operation.authParameters,
    parameters: operation.parameters,
    requestBody: operation.requestBody ?? null,
    responses: operation.responses,
  };

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  console.log(JSON.stringify(detail, null, 2));
}
