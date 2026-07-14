import { ScoutError } from "./errors.js";
import { createExecutorContext, executeCall } from "./http-executor.js";
import { parseHttpMethodArg } from "./spec-loader.js";
import { isInteractive, readJsonStdin } from "./utils.js";

export type CallOptions = {
  json?: boolean;
  pathParam?: string[];
  query?: string[];
  data?: string;
  dataStdin?: boolean;
  header?: string[];
  expect?: number;
  /** Commander sets this to false when `--no-auth` is passed (default true). */
  auth?: boolean;
  config?: string;
};

/** Parses repeated `k=v` flags into a record. */
export function parseKeyValueFlags(
  entries: string[] | undefined,
  flagName: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      throw new ScoutError(`Invalid ${flagName} "${entry}". Expected key=value.`, {
        code: "VALIDATION_ERROR",
        hint: `Use ${flagName} key=value.`,
      });
    }
    result[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
  }
  return result;
}

/** Parses repeated `--header k:v` flags into a record. */
export function parseHeaderKvFlags(entries: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new ScoutError(`Invalid --header "${entry}". Expected Name:Value.`, {
        code: "VALIDATION_ERROR",
        hint: "Use --header Name:Value.",
      });
    }
    result[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return result;
}

/** Executes a single instrumented request and prints the verdict. */
export async function runCallCommand(
  method: string,
  path: string,
  options: CallOptions,
): Promise<void> {
  const httpMethod = parseHttpMethodArg(method);

  let body: unknown;
  if (options.dataStdin) {
    body = await readJsonStdin("request body");
  } else if (options.data !== undefined) {
    try {
      body = JSON.parse(options.data);
    } catch {
      throw new ScoutError("Invalid JSON in --data.", {
        code: "INVALID_JSON",
        hint: "Pass valid JSON, or use --data-stdin to pipe a larger payload.",
      });
    }
  }

  const context = createExecutorContext({ config: options.config });
  const result = await executeCall(context, {
    method: httpMethod,
    path,
    source: "call",
    pathParams: parseKeyValueFlags(options.pathParam, "--path-param"),
    query: parseKeyValueFlags(options.query, "--query"),
    headers: parseHeaderKvFlags(options.header),
    ...(body !== undefined ? { body } : {}),
    ...(options.auth === false ? { noAuth: true } : {}),
    ...(options.expect !== undefined ? { expect: options.expect } : {}),
  });

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}
