import { randomUUID } from "node:crypto";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./constants.js";
import { ScoutError } from "./errors.js";
import {
  loadProjectConfigOrThrow,
  resolvePolicy,
  type ResolvedPolicy,
  type ScoutProjectConfig,
} from "./project-config.js";
import { redactJsonSecrets, redactSecretsOnly, redactUrl } from "./redaction.js";
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
const SECRETISH_HEADER_RE =
  /(^|[-_])(authorization|api[-_]?key|key|token|secret|cookie|session|password|auth)([-_]|$)/i;
const SECRETISH_QUERY_KEY_RE =
  /(^|[-_])(api[-_]?key|key|token|secret|password|session|auth|signature|sig)([-_]|$)/i;
const INVALID_CREDENTIAL = "scout-invalid-credential";
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
  rawBody?: string;
  noAuth?: boolean;
  invalidAuth?: boolean;
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

/** Returns a deterministic invalid credential while retaining the declared auth scheme. */
function invalidCredentialValue(value: string, declaredScheme?: string): string {
  if (declaredScheme) return `${declaredScheme} ${INVALID_CREDENTIAL}`;
  const scheme = /^(\s*(?:Bearer|Basic|Digest|Negotiate)\s+)/i.exec(value)?.[1];
  return scheme ? `${scheme}${INVALID_CREDENTIAL}` : INVALID_CREDENTIAL;
}

/** Collects credential header values and scheme payloads for output redaction. */
function collectCredentialSecrets(value: string, secrets: string[]): void {
  secrets.push(value);
  const credential = /^\s*(?:Bearer|Basic)\s+(.+?)\s*$/i.exec(value)?.[1];
  if (credential) secrets.push(credential);
}

/** Adds currently available env-reference values without requiring them to exist. */
function collectAvailableEnvSecrets(template: string, secrets: string[]): void {
  for (const match of template.matchAll(ENV_REF_RE)) {
    const name = match[1] ?? match[2];
    const value = name ? process.env[name] : undefined;
    if (value) secrets.push(value);
  }
}

type CookiePair = { name: string; value: string };

/** Parses a Cookie header into name/value pairs. */
function parseCookieHeader(value: string): CookiePair[] {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator === -1
        ? { name: part, value: "" }
        : { name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim() };
    });
}

/** Serializes Cookie header pairs without changing their names or order. */
function serializeCookieHeader(pairs: CookiePair[]): string {
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/** Removes or replaces auth cookies while preserving unrelated cookie pairs. */
function transformCookieHeader(
  value: string,
  authCookieNames: string[],
  mode: "remove" | "invalidate",
): string | undefined {
  const pairs = parseCookieHeader(value);
  const targetNames = new Set(
    authCookieNames.length > 0 ? authCookieNames : pairs.map((pair) => pair.name),
  );
  const transformed = pairs
    .filter((pair) => mode !== "remove" || !targetNames.has(pair.name))
    .map((pair) =>
      mode === "invalidate" && targetNames.has(pair.name)
        ? { ...pair, value: INVALID_CREDENTIAL }
        : pair,
    );
  return transformed.length > 0 ? serializeCookieHeader(transformed) : undefined;
}

/** Adds individual cookie values to the redaction set. */
function collectCookieSecrets(value: string, secrets: string[]): void {
  for (const pair of parseCookieHeader(value)) {
    if (pair.value && pair.value !== INVALID_CREDENTIAL) secrets.push(pair.value);
  }
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
  if (request.noAuth && request.invalidAuth) {
    throw new ScoutError("--no-auth cannot be used with --invalid-auth.", {
      code: "VALIDATION_ERROR",
    });
  }
  if (request.body !== undefined && request.rawBody !== undefined) {
    throw new ScoutError("JSON and raw request bodies cannot be used together.", {
      code: "VALIDATION_ERROR",
    });
  }

  const match = matchOperation(context.operations, request.method, request.path);
  const operation = match?.operation ?? null;
  const authHeaderNames = new Set(
    operation?.authParameters
      .filter((parameter) => parameter.in === "header")
      .map((parameter) => parameter.name.toLowerCase()) ?? [],
  );
  const authHeaderSchemes = new Map(
    operation?.authParameters
      .filter((parameter) => parameter.in === "header" && parameter.scheme)
      .map((parameter) => [parameter.name.toLowerCase(), parameter.scheme as string]) ?? [],
  );
  const authQueryNames = new Set(
    operation?.authParameters
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name) ?? [],
  );
  const authCookieNames =
    operation?.authParameters
      .filter((parameter) => parameter.in === "cookie")
      .map((parameter) => parameter.name) ?? [];
  const hasDeclaredAuthParameters = (operation?.authParameters.length ?? 0) > 0;
  /** Matches a spec-declared credential header. */
  const isDeclaredCredentialHeader = (name: string) =>
    authHeaderNames.has(name.toLowerCase()) ||
    (name.toLowerCase() === "cookie" && authCookieNames.length > 0);
  /** Matches a credential header for probe mutation. */
  const isProbeCredentialHeader = (name: string) =>
    hasDeclaredAuthParameters ? isDeclaredCredentialHeader(name) : SECRETISH_HEADER_RE.test(name);
  /** Matches a credential header that must be redacted. */
  const isSensitiveHeader = (name: string) =>
    authHeaderNames.has(name.toLowerCase()) || SECRETISH_HEADER_RE.test(name);
  /** Matches a credential query parameter for probe mutation. */
  const isProbeCredentialQuery = (name: string) =>
    hasDeclaredAuthParameters ? authQueryNames.has(name) : SECRETISH_QUERY_KEY_RE.test(name);
  /** Matches a credential query parameter that must be redacted. */
  const isSensitiveQuery = (name: string) =>
    authQueryNames.has(name) || SECRETISH_QUERY_KEY_RE.test(name);

  const pathParams = { ...(match?.extractedPathParams ?? {}), ...(request.pathParams ?? {}) };
  const templatePath = operation && match ? operation.path : request.path;
  const concretePath = substitutePathParams(templatePath, pathParams);

  const baseUrl = context.config.baseUrl.replace(/\/$/, "");
  const url = new URL(`${baseUrl}${concretePath.startsWith("/") ? "" : "/"}${concretePath}`);
  const secrets: string[] = [];
  let hasCredentialTarget = false;
  for (const [key, value] of Object.entries(request.query ?? {})) {
    const credentialLike = isProbeCredentialQuery(key);
    const syntheticCredential = request.invalidAuth === true && credentialLike;
    if (credentialLike) hasCredentialTarget = true;
    if (request.noAuth && credentialLike) continue;
    const effectiveValue = syntheticCredential ? INVALID_CREDENTIAL : value;
    url.searchParams.append(key, effectiveValue);
    if (isSensitiveQuery(key)) secrets.push(value);
  }
  for (const name of authQueryNames) {
    hasCredentialTarget = true;
    if (request.invalidAuth && !url.searchParams.has(name)) {
      url.searchParams.append(name, INVALID_CREDENTIAL);
    }
  }

  assertHostAllowed(url, context.config);
  assertMethodAllowed(request.method, context.policy);
  assertBudgetAvailable(context.cwd, context.policy);

  const headers: Record<string, string> = {};
  const syntheticCredentialHeaders = new Set<string>();
  for (const [name, template] of Object.entries(context.config.headers ?? {})) {
    let effectiveTemplate = template;
    if (isSensitiveHeader(name)) {
      collectAvailableEnvSecrets(template, secrets);
      if (name.toLowerCase() === "cookie") {
        collectCookieSecrets(template, secrets);
      } else {
        collectCredentialSecrets(template, secrets);
      }
    }
    if (isProbeCredentialHeader(name)) {
      hasCredentialTarget = true;
      if (name.toLowerCase() === "cookie") {
        if (request.noAuth) {
          const transformed = transformCookieHeader(template, authCookieNames, "remove");
          if (transformed === undefined) continue;
          effectiveTemplate = transformed;
        } else if (request.invalidAuth) {
          effectiveTemplate = transformCookieHeader(template, authCookieNames, "invalidate") ?? "";
          syntheticCredentialHeaders.add(name.toLowerCase());
        }
      } else if (request.noAuth) {
        continue;
      } else if (request.invalidAuth) {
        headers[name] = invalidCredentialValue(template, authHeaderSchemes.get(name.toLowerCase()));
        syntheticCredentialHeaders.add(name.toLowerCase());
        continue;
      }
    }
    const resolved = resolveEnvRefs(effectiveTemplate);
    headers[name] = resolved.value;
    secrets.push(...resolved.secrets);
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    let effectiveValue = value;
    if (name.toLowerCase() === "cookie") {
      collectCookieSecrets(value, secrets);
    } else if (isSensitiveHeader(name)) {
      collectCredentialSecrets(value, secrets);
    }
    if (isProbeCredentialHeader(name)) {
      hasCredentialTarget = true;
      if (name.toLowerCase() === "cookie") {
        if (request.noAuth) {
          const transformed = transformCookieHeader(value, authCookieNames, "remove");
          if (transformed === undefined) continue;
          effectiveValue = transformed;
        } else if (request.invalidAuth) {
          effectiveValue = transformCookieHeader(value, authCookieNames, "invalidate") ?? "";
          syntheticCredentialHeaders.add(name.toLowerCase());
        }
      } else if (request.noAuth) {
        continue;
      } else if (request.invalidAuth) {
        headers[name] = invalidCredentialValue(value, authHeaderSchemes.get(name.toLowerCase()));
        syntheticCredentialHeaders.add(name.toLowerCase());
        continue;
      }
    }
    headers[name] = effectiveValue;
  }

  for (const name of authHeaderNames) {
    hasCredentialTarget = true;
    const existingName = Object.keys(headers).find((header) => header.toLowerCase() === name);
    if (request.invalidAuth && !existingName) {
      const headerName =
        operation?.authParameters.find(
          (parameter) => parameter.in === "header" && parameter.name.toLowerCase() === name,
        )?.name ?? name;
      headers[headerName] =
        name === "authorization"
          ? `${authHeaderSchemes.get(name) ?? "Bearer"} ${INVALID_CREDENTIAL}`
          : INVALID_CREDENTIAL;
      syntheticCredentialHeaders.add(name);
    }
  }
  if (authCookieNames.length > 0) {
    hasCredentialTarget = true;
    const cookieHeader = Object.keys(headers).find((header) => header.toLowerCase() === "cookie");
    if (request.invalidAuth) {
      const existingPairs = cookieHeader ? parseCookieHeader(headers[cookieHeader] ?? "") : [];
      const missingPairs = authCookieNames
        .filter((name) => !existingPairs.some((pair) => pair.name === name))
        .map((name) => ({ name, value: INVALID_CREDENTIAL }));
      if (missingPairs.length > 0) {
        const headerName = cookieHeader ?? "Cookie";
        headers[headerName] = serializeCookieHeader([...existingPairs, ...missingPairs]);
        syntheticCredentialHeaders.add("cookie");
      }
    }
  }

  if (request.invalidAuth && !hasCredentialTarget) {
    headers.Authorization = `Bearer ${INVALID_CREDENTIAL}`;
    syntheticCredentialHeaders.add("authorization");
  }

  const hasBody = request.body !== undefined || request.rawBody !== undefined;
  let serializedBody: string | undefined;
  if (request.rawBody !== undefined) {
    serializedBody = request.rawBody;
  } else if (request.body !== undefined) {
    serializedBody = JSON.stringify(request.body);
  }
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
      body: serializedBody,
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
      isSensitiveHeader(name) &&
      (name.toLowerCase() === "cookie" || !syntheticCredentialHeaders.has(name.toLowerCase()))
        ? "[redacted]"
        : redactRecordValue(value, secrets),
    ]),
  );

  const redactedUrl = redactUrl(url.toString(), secrets, authQueryNames);

  const record: RequestRecord = {
    id: requestId,
    timestamp: new Date().toISOString(),
    source: request.source,
    operation: operation ? operationKey(operation) : null,
    method: request.method.toUpperCase(),
    url: redactedUrl,
    status: response.status,
    latencyMs,
    schemaValid: verdict.schemaValid,
    requestHeaders: redactedHeaders,
    ...(hasBody
      ? { requestBody: truncateBody(redactRecordValue(serializedBody ?? "", secrets)) }
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
      url: redactedUrl,
      headers: redactedHeaders,
      ...(hasBody
        ? {
            body:
              request.rawBody !== undefined
                ? redactRecordValue(request.rawBody, secrets)
                : redactJsonSecrets(request.body, secrets),
          }
        : {}),
    },
    response: {
      status: response.status,
      ...(contentType ? { contentType } : {}),
      body: bodyIsJson
        ? redactJsonSecrets(body, secrets)
        : truncateBody(redactRecordValue(rawBody, secrets)),
      bodyIsJson,
    },
    verdict,
  };
}
