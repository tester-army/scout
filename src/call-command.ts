import { log } from "@clack/prompts";
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
  rawData?: string;
  rawDataStdin?: boolean;
  header?: string[];
  expect?: number;
  /** Commander sets this to false when `--no-auth` is passed (default true). */
  auth?: boolean;
  invalidAuth?: boolean;
  config?: string;
};

/** Reads all stdin as UTF-8 text without trimming or parsing it. */
async function readRawStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Rejects mutually exclusive call body and authentication modes. */
function assertCompatibleCallOptions(options: CallOptions): void {
  if (options.data !== undefined && options.dataStdin) {
    throw new ScoutError("--data cannot be used with --data-stdin.", {
      code: "VALIDATION_ERROR",
    });
  }
  const hasJsonBody = options.data !== undefined || options.dataStdin === true;
  const hasRawBody = options.rawData !== undefined || options.rawDataStdin === true;
  if (hasJsonBody && hasRawBody) {
    throw new ScoutError("Raw body flags cannot be used with --data or --data-stdin.", {
      code: "VALIDATION_ERROR",
    });
  }
  if (options.rawData !== undefined && options.rawDataStdin) {
    throw new ScoutError("--raw-data cannot be used with --raw-data-stdin.", {
      code: "VALIDATION_ERROR",
    });
  }
  if (options.auth === false && options.invalidAuth) {
    throw new ScoutError("--no-auth cannot be used with --invalid-auth.", {
      code: "VALIDATION_ERROR",
    });
  }
}

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
  assertCompatibleCallOptions(options);
  const httpMethod = parseHttpMethodArg(method);

  let body: unknown;
  let rawBody: string | undefined;
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
  } else if (options.rawDataStdin) {
    rawBody = await readRawStdin();
  } else if (options.rawData !== undefined) {
    rawBody = options.rawData;
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
    ...(rawBody !== undefined ? { rawBody } : {}),
    ...(options.auth === false ? { noAuth: true } : {}),
    ...(options.invalidAuth ? { invalidAuth: true } : {}),
    ...(options.expect !== undefined ? { expect: options.expect } : {}),
  });

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  renderCallHuman(result);
}

/** Prints a concise, readable verdict instead of raw JSON in a TTY. */
function renderCallHuman(result: {
  operation: string | null;
  request: { method: string; url: string };
  response: { status: number; body: unknown };
  verdict: {
    ok: boolean;
    summary: string;
    expectedStatuses: string[];
    schemaErrors: string[];
  };
}): void {
  const { verdict } = result;
  const line = verdict.ok ? log.success : log.error;

  line(`${result.request.method} ${result.request.url}`);
  log.message(verdict.summary);

  if (result.operation) {
    log.message(
      `operation: ${result.operation}${
        verdict.expectedStatuses.length > 0
          ? ` · documented statuses: ${verdict.expectedStatuses.join(", ")}`
          : ""
      }`,
    );
  }

  if (verdict.schemaErrors.length > 0) {
    log.message(`schema errors:\n${verdict.schemaErrors.map((e) => `  - ${e}`).join("\n")}`);
  }

  const bodyText =
    typeof result.response.body === "string"
      ? result.response.body
      : JSON.stringify(result.response.body, null, 2);
  const preview = bodyText.length > 800 ? `${bodyText.slice(0, 800)}…` : bodyText;
  log.message(`response body:\n${preview}`);
}
