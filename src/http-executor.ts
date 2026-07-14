import { randomUUID } from "node:crypto";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./constants.js";
import { ScoutError } from "./errors.js";
import {
  loadProjectConfigOrThrow,
  resolvePolicy,
  type ResolvedPolicy,
  type ScoutProjectConfig,
} from "./project-config.js";
import { redactSecretsOnly, redactUrl } from "./redaction.js";
import {
  appendRequestRecord,
  incrementRequestCount,
  loadCachedSpec,
  loadSessionState,
  type RequestRecord,
} from "./session-store.js";
import {
  extractOperations,
  operationKey,
  SAFE_METHODS,
  type HttpMethod,
  type LoadedSpec,
  type SpecOperation,
} from "./spec-loader.js";
import { buildVerdict, type Verdict } from "./verdict.js";

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const SECRETISH_HEADER_RE = /auth|token|key|secret|cookie|session|password/i;
const MAX_STORED_BODY_LENGTH = 4000;

export type ExecutorContext = {
  cwd: string;
  config: ScoutProjectConfig;
  policy: ResolvedPolicy;
  loadedSpec: LoadedSpec;
  operations: SpecOperation[];
};

export type CallRequest = {
  method: HttpMethod;
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  noAuth?: boolean;
  expect?: number;
  source: "call" | "sweep";
  timeoutMs?: number;
};

export type CallResult = {
  requestId: string;
  operation: string | null;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    contentType?: string;
    body: unknown;
    bodyIsJson: boolean;
  };
  verdict: Verdict;
};

/** Simple token bucket so sweeps cannot hammer a target API. */
export class RateLimiter {
  private nextAvailableAt = 0;
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = 1000 / Math.max(requestsPerSecond, 0.1);
  }

  /** Waits until the next request slot is available. */
  async take(): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = scheduledAt + this.intervalMs;
    const waitMs = scheduledAt - now;
    if (waitMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
  }
}

/** Loads config + cached spec into a ready-to-execute context. */
export function createExecutorContext(options?: {
  cwd?: string;
  config?: string;
  policyOverrides?: Partial<ResolvedPolicy>;
}): ExecutorContext {
  const cwd = options?.cwd ?? process.cwd();
  const { config } = loadProjectConfigOrThrow({ cwd, config: options?.config });
  const loadedSpec = loadCachedSpec(cwd);

  return {
    cwd,
    config,
    policy: resolvePolicy(config, options?.policyOverrides),
    loadedSpec,
    operations: extractOperations(loadedSpec.spec),
  };
}

/**
 * Resolves `$VAR` / `${VAR}` references in a header template from the
 * environment, collecting resolved secret values for later redaction.
 */
export function resolveEnvRefs(template: string): { value: string; secrets: string[] } {
  const secrets: string[] = [];
  const value = template.replace(ENV_REF_RE, (_match, braced, bare) => {
    const name = (braced ?? bare) as string;
    const resolved = process.env[name];
    if (resolved === undefined || resolved === "") {
      throw new ScoutError(`Environment variable ${name} is not set (referenced in headers).`, {
        code: "ENV_VAR_MISSING",
        hint: process.env.CI
          ? `Provide it via the workflow env block: \`env: ${name}: \${{ secrets.${name} }}\`.`
          : `Export it before running: \`export ${name}=...\`.`,
      });
    }
    secrets.push(resolved);
    return resolved;
  });

  return { value, secrets };
}

/**
 * Matches a request path against the spec's operations. Accepts both the
 * template form (`/users/{id}`) and a concrete path (`/users/123`).
 */
export function matchOperation(
  operations: SpecOperation[],
  method: HttpMethod,
  path: string,
): { operation: SpecOperation; extractedPathParams: Record<string, string> } | null {
  const exact = operations.find((op) => op.method === method && op.path === path);
  if (exact) {
    return { operation: exact, extractedPathParams: {} };
  }

  const requestSegments = path.split("/").filter((segment) => segment.length > 0);
  for (const op of operations) {
    if (op.method !== method) continue;
    const templateSegments = op.path.split("/").filter((segment) => segment.length > 0);
    if (templateSegments.length !== requestSegments.length) continue;

    const extractedPathParams: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < templateSegments.length; i++) {
      const template = templateSegments[i] as string;
      const actual = requestSegments[i] as string;
      const paramMatch = /^\{(.+)\}$/.exec(template);
      if (paramMatch) {
        extractedPathParams[paramMatch[1] as string] = actual;
      } else if (template !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { operation: op, extractedPathParams };
    }
  }

  return null;
}

function substitutePathParams(path: string, pathParams: Record<string, string>): string {
  const substituted = path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = pathParams[name];
    return value !== undefined ? encodeURIComponent(value) : match;
  });

  const unresolved = [...substituted.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (unresolved.length > 0) {
    throw new ScoutError(`Missing path parameter(s): ${unresolved.join(", ")}.`, {
      code: "VALIDATION_ERROR",
      hint: `Provide them with --path-param, e.g. --path-param ${unresolved[0]}=<value>.`,
    });
  }

  return substituted;
}

function assertHostAllowed(url: URL, config: ScoutProjectConfig): void {
  const baseHost = new URL(config.baseUrl).host;
  const allowedHosts = new Set([baseHost, ...(config.allowHosts ?? [])]);
  if (!allowedHosts.has(url.host)) {
    throw new ScoutError(`Host ${url.host} is not allowlisted.`, {
      code: "HOST_BLOCKED",
      hint: `Allowed hosts: ${[...allowedHosts].join(", ")}. Add it to allowHosts in scout.json or re-run \`scout init --allow-host ${url.host}\`.`,
    });
  }
}

function assertMethodAllowed(method: HttpMethod, policy: ResolvedPolicy): void {
  if (SAFE_METHODS.includes(method) || policy.allowMutations) {
    return;
  }

  throw new ScoutError(`${method.toUpperCase()} requests are blocked (mutations disabled).`, {
    code: "MUTATION_BLOCKED",
    hint: "Re-run `scout init` with --allow-mutations, or set policy.allowMutations to true in scout.json.",
  });
}

function assertBudgetAvailable(cwd: string, policy: ResolvedPolicy): void {
  const state = loadSessionState(cwd);
  if (state.requestCount >= policy.budget) {
    throw new ScoutError(
      `Session request budget exhausted (${state.requestCount}/${policy.budget}).`,
      {
        code: "BUDGET_EXCEEDED",
        hint: "Raise policy.budget in scout.json, or re-run `scout init` to start a fresh session.",
      },
    );
  }
}

function redactRecordValue(value: string, secrets: string[]): string {
  return redactSecretsOnly(value, secrets);
}

function truncateBody(body: string): string {
  return body.length > MAX_STORED_BODY_LENGTH
    ? `${body.slice(0, MAX_STORED_BODY_LENGTH)}…[truncated]`
    : body;
}

/**
 * Executes one instrumented request against the target API: guardrails,
 * env-ref auth injection, verdict, redacted evidence log, budget counter.
 */
export async function executeCall(
  context: ExecutorContext,
  request: CallRequest,
  rateLimiter?: RateLimiter,
): Promise<CallResult> {
  const match = matchOperation(context.operations, request.method, request.path);
  const operation = match?.operation ?? null;

  const pathParams = { ...(match?.extractedPathParams ?? {}), ...(request.pathParams ?? {}) };
  const templatePath = operation && match ? operation.path : request.path;
  const concretePath = substitutePathParams(templatePath, pathParams);

  const baseUrl = context.config.baseUrl.replace(/\/$/, "");
  const url = new URL(`${baseUrl}${concretePath.startsWith("/") ? "" : "/"}${concretePath}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.append(key, value);
  }

  assertHostAllowed(url, context.config);
  assertMethodAllowed(request.method, context.policy);
  assertBudgetAvailable(context.cwd, context.policy);

  const secrets: string[] = [];
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(context.config.headers ?? {})) {
    if (request.noAuth && SECRETISH_HEADER_RE.test(name)) continue;
    const resolved = resolveEnvRefs(template);
    headers[name] = resolved.value;
    secrets.push(...resolved.secrets);
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name] = value;
  }

  const hasBody = request.body !== undefined;
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  if (rateLimiter) {
    await rateLimiter.take();
  }

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method.toUpperCase(),
      headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (error) {
    incrementRequestCount(context.cwd);
    throw new Error(
      redactRecordValue(
        `Request to ${url.host} failed: ${error instanceof Error ? error.message : String(error)}`,
        secrets,
      ),
      { cause: error },
    );
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  const rawBody = await response.text().catch(() => "");
  let body: unknown = rawBody;
  let bodyIsJson = false;
  try {
    body = JSON.parse(rawBody);
    bodyIsJson = true;
  } catch {
    // keep raw text
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const verdict = buildVerdict({
    operation,
    specVersion: context.loadedSpec.specVersion,
    status: response.status,
    contentType,
    body,
    bodyIsJson,
    latencyMs,
    expect: request.expect,
    redacted: secrets.length > 0,
  });

  const requestId = randomUUID();
  const redactedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SECRETISH_HEADER_RE.test(name) ? "[redacted]" : redactRecordValue(value, secrets),
    ]),
  );

  const record: RequestRecord = {
    id: requestId,
    timestamp: new Date().toISOString(),
    source: request.source,
    operation: operation ? operationKey(operation) : null,
    method: request.method.toUpperCase(),
    url: redactUrl(url.toString(), secrets),
    status: response.status,
    latencyMs,
    schemaValid: verdict.schemaValid,
    requestHeaders: redactedHeaders,
    ...(hasBody
      ? { requestBody: truncateBody(redactRecordValue(JSON.stringify(request.body), secrets)) }
      : {}),
    responseBody: truncateBody(redactRecordValue(rawBody, secrets)),
    ...(contentType ? { responseContentType: contentType } : {}),
  };

  incrementRequestCount(context.cwd);
  appendRequestRecord(record, context.cwd);

  return {
    requestId,
    operation: operation ? operationKey(operation) : null,
    request: {
      method: request.method.toUpperCase(),
      url: redactUrl(url.toString(), secrets),
      headers: redactedHeaders,
      ...(hasBody ? { body: request.body } : {}),
    },
    response: {
      status: response.status,
      ...(contentType ? { contentType } : {}),
      body: bodyIsJson ? body : truncateBody(redactRecordValue(rawBody, secrets)),
      bodyIsJson,
    },
    verdict,
  };
}
