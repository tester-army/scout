import { log } from "@clack/prompts";
import { ScoutError } from "./errors.js";
import { createExecutorContext, executeCall } from "./http-executor.js";
import { extractPath, stringifyExtracted } from "./json-path.js";
import { stringifyJson } from "./output.js";
import { interpolateVars, loadVars, saveVars, type SessionVars } from "./session-vars.js";
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
  allowUndocumented?: boolean;
  authProfile?: string;
  extract?: string;
  capture?: string[];
  failOnVerdict?: boolean;
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

/** Parses repeated `--capture name=path` flags into name/path pairs. */
export function parseCaptureFlags(
  entries: string[] | undefined,
): Array<{ name: string; path: string }> {
  return (entries ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      throw new ScoutError(`Invalid --capture "${entry}". Expected name=path.`, {
        code: "VALIDATION_ERROR",
        hint: "Use --capture name=response.body.path, e.g. --capture projectId=project.id.",
      });
    }
    return { name: entry.slice(0, separator).trim(), path: entry.slice(separator + 1).trim() };
  });
}

/** Stores captured values from a response body, returning a summary for output. */
function applyCaptures(
  captures: Array<{ name: string; path: string }>,
  body: unknown,
  cwd: string,
): Record<string, string> {
  if (captures.length === 0) {
    return {};
  }
  const vars: SessionVars = loadVars(cwd);
  const captured: Record<string, string> = {};
  for (const { name, path } of captures) {
    const value = extractPath(body, path);
    if (value === undefined) {
      throw new ScoutError(`Capture path "${path}" not found in the response body.`, {
        code: "NOT_FOUND",
        hint: "Inspect the response body and adjust the path, e.g. --capture id=data.items[0].id.",
      });
    }
    const stringified = stringifyExtracted(value);
    vars[name] = stringified;
    captured[name] = stringified;
  }
  saveVars(vars, cwd);
  return captured;
}

/** Executes a single instrumented request and prints the verdict. */
export async function runCallCommand(
  method: string,
  path: string,
  options: CallOptions,
): Promise<void> {
  assertCompatibleCallOptions(options);
  const captures = parseCaptureFlags(options.capture);
  const vars = loadVars();
  const interp = (text: string): string => interpolateVars(text, vars);
  const httpMethod = parseHttpMethodArg(method);
  path = interp(path);
  if (options.data !== undefined) options.data = interp(options.data);
  if (options.rawData !== undefined) options.rawData = interp(options.rawData);
  const pathParam = (options.pathParam ?? []).map(interp);
  const query = (options.query ?? []).map(interp);
  const header = (options.header ?? []).map(interp);

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

  const context = createExecutorContext({
    authProfile: options.authProfile,
  });
  const result = await executeCall(context, {
    method: httpMethod,
    path,
    source: "call",
    pathParams: parseKeyValueFlags(pathParam, "--path-param"),
    query: parseKeyValueFlags(query, "--query"),
    headers: parseHeaderKvFlags(header),
    ...(body !== undefined ? { body } : {}),
    ...(rawBody !== undefined ? { rawBody } : {}),
    ...(options.auth === false ? { noAuth: true } : {}),
    ...(options.invalidAuth ? { invalidAuth: true } : {}),
    ...(options.allowUndocumented ? { allowUndocumented: true } : {}),
    ...(options.expect !== undefined ? { expect: options.expect } : {}),
  });

  const captured = applyCaptures(captures, result.response.body, context.cwd);
  if (options.failOnVerdict && !result.verdict.ok) process.exitCode = 1;

  if (options.extract !== undefined) {
    const value = extractPath(result.response.body, options.extract);
    if (value === undefined) {
      throw new ScoutError(`Extract path "${options.extract}" not found in the response body.`, {
        code: "NOT_FOUND",
        hint: "Inspect the response body and adjust the path, e.g. --extract data.items[0].id.",
      });
    }
    for (const warning of result.warnings ?? []) console.error(`warning: ${warning}`);
    console.log(stringifyExtracted(value));
    return;
  }

  if (options.json || !isInteractive()) {
    console.log(stringifyJson(Object.keys(captured).length > 0 ? { ...result, captured } : result));
    return;
  }

  renderCallHuman(result);
  if (Object.keys(captured).length > 0) {
    log.message(
      `captured:\n${Object.entries(captured)
        .map(([n, v]) => `  ${n} = ${v}`)
        .join("\n")}`,
    );
  }
}

/** Prints a concise, readable verdict instead of raw JSON in a TTY. */
function renderCallHuman(result: {
  operation: string | null;
  request: { method: string; url: string };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    bodyTruncated: boolean;
  };
  verdict: {
    ok: boolean;
    summary: string;
    expectedStatuses: string[];
    schemaErrors: string[];
  };
  warnings?: string[];
}): void {
  const { verdict } = result;
  const line = verdict.ok ? log.success : log.error;

  line(`${result.request.method} ${result.request.url}`);
  log.message(verdict.summary);

  for (const warning of result.warnings ?? []) log.warn(warning);

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

  const headerLines = Object.entries(result.response.headers).map(([n, v]) => `  ${n}: ${v}`);
  if (headerLines.length > 0) {
    log.message(`response headers:\n${headerLines.join("\n")}`);
  }

  const bodyText =
    typeof result.response.body === "string"
      ? result.response.body
      : JSON.stringify(result.response.body, null, 2);
  const preview = bodyText.length > 2000 ? `${bodyText.slice(0, 2000)}…` : bodyText;
  log.message(`response body${result.response.bodyTruncated ? " (truncated)" : ""}:\n${preview}`);
}
