import { randomUUID } from "node:crypto";
import picomatch from "picomatch";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_DOWNLOAD_BYTES,
  MAX_RESPONSE_PREVIEW_BYTES,
} from "./constants.js";
import { ScoutError } from "./errors.js";
import {
  loadProjectConfigOrThrow,
  resolvePolicy,
  type ResolvedPolicy,
  type ScoutProjectConfig,
} from "./project-config.js";
import {
  looksLikeUnredactedSecret,
  redactJsonSecrets,
  redactSecretsOnly,
  redactUrl,
} from "./redaction.js";
import {
  appendRequestRecordForRun,
  loadCachedSpec,
  reserveRateLimitSlot,
  reserveRequest,
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
const SECRETISH_BODY_KEY_RE =
  /(^|[-_])(api[-_]?key|key|token|secret|password|session|auth|cookie)([-_]|$)/i;
const INVALID_CREDENTIAL = "scout-invalid-credential";
const MAX_STORED_BODY_LENGTH = 4000;

export type ExecutorContext = {
  cwd: string;
  config: ScoutProjectConfig;
  policy: ResolvedPolicy;
  loadedSpec: LoadedSpec;
  operations: SpecOperation[];
  authProfile?: string;
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
  redactBodyEvidence?: boolean;
  expect?: number;
  source: "call" | "sweep" | "fuzz";
  timeoutMs?: number;
  allowUndocumented?: boolean;
  authProfile?: string;
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
    headers: Record<string, string>;
    body: unknown;
    bodyIsJson: boolean;
    bodyTruncated: boolean;
  };
  verdict: Verdict;
  warnings?: string[];
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
  authProfile?: string;
}): ExecutorContext {
  const cwd = options?.cwd ?? process.cwd();
  const { config } = loadProjectConfigOrThrow({ cwd, config: options?.config });
  const loadedSpec = loadCachedSpec(cwd);
  const policy = resolvePolicy(config, options?.policyOverrides);

  return {
    cwd,
    config,
    policy,
    loadedSpec,
    operations: extractOperations(loadedSpec.spec),
    ...(options?.authProfile ? { authProfile: options.authProfile } : {}),
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

/**
 * Picks the wire format for a structured `--data` body from the operation's
 * declared request content types. JSON wins whenever the spec allows it;
 * form encoding is used only when the spec declares form-urlencoded and no
 * JSON variant, so JSON-first APIs keep their existing behavior.
 */
export function selectRequestContentType(
  operation: SpecOperation | null,
): "application/json" | "application/x-www-form-urlencoded" {
  const contentTypes = Object.keys(operation?.requestBody?.content ?? {}).map((type) =>
    type.split(";")[0]?.trim().toLowerCase(),
  );
  const hasJson = contentTypes.some(
    (type) => type === "application/json" || (type?.endsWith("+json") ?? false),
  );
  if (!hasJson && contentTypes.includes("application/x-www-form-urlencoded")) {
    return "application/x-www-form-urlencoded";
  }
  return "application/json";
}

/**
 * Serializes a JSON-compatible value as application/x-www-form-urlencoded
 * using bracket notation for nested objects and arrays
 * (e.g. `metadata[key]=v`, `items[0][price]=p`), the convention used by
 * form-encoded APIs like Stripe.
 */
export function encodeFormBody(body: unknown): string {
  const pairs: string[] = [];
  const append = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      pairs.push(`${encodeURIComponent(key)}=`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => append(`${key}[${index}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        append(`${key}[${childKey}]`, childValue);
      }
      return;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      append(key, value);
    }
  }
  return pairs.join("&");
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
  if (url.host !== baseHost) {
    throw new ScoutError(`Host ${url.host} is not allowlisted.`, {
      code: "HOST_BLOCKED",
      hint: `Scout only permits the configured base URL host: ${baseHost}.`,
    });
  }
}

function assertPathNotNormalized(url: URL, baseUrl: string, concretePath: string): void {
  const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
  const expectedPath = `${basePath}${concretePath.startsWith("/") ? "" : "/"}${concretePath}`;
  if (url.pathname !== expectedPath) {
    throw new ScoutError("Path parameters would normalize outside the documented operation path.", {
      code: "SCOPE_BLOCKED",
      hint: "Do not use dot-segment path parameter values such as . or ...",
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

function assertOperationInScope(method: HttpMethod, path: string, policy: ResolvedPolicy): void {
  if (
    policy.allowedMethods &&
    !policy.allowedMethods.some((allowed) => allowed.toUpperCase() === method.toUpperCase())
  ) {
    throw new ScoutError(`${method.toUpperCase()} is outside the configured operation scope.`, {
      code: "SCOPE_BLOCKED",
      hint: `Allowed methods: ${policy.allowedMethods.join(", ")}.`,
    });
  }
  if (policy.allowedPaths && !policy.allowedPaths.some((pattern) => picomatch(pattern)(path))) {
    throw new ScoutError(`${path} is outside the configured operation scope.`, {
      code: "SCOPE_BLOCKED",
      hint: `Allowed path patterns: ${policy.allowedPaths.join(", ")}.`,
    });
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

function mergeHeadersCaseInsensitive(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      result.set(name.toLowerCase(), { name, value });
    }
  }
  return Object.fromEntries([...result.values()].map(({ name, value }) => [name, value]));
}

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

function mergeCookieHeaders(...values: Array<string | undefined>): string | undefined {
  const result = new Map<string, CookiePair>();
  for (const value of values) {
    for (const pair of value ? parseCookieHeader(value) : []) {
      result.set(pair.name.toLowerCase(), pair);
    }
  }
  return result.size > 0 ? serializeCookieHeader([...result.values()]) : undefined;
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

/** Collects non-trivial values under secret-like body keys for response redaction. */
function collectSecretishBodyValues(
  value: unknown,
  secrets: string[],
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSecretishBodyValues(item, secrets, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRETISH_BODY_KEY_RE.test(key) && typeof item === "string" && item.length >= 4) {
      secrets.push(item);
    }
    collectSecretishBodyValues(item, secrets, seen);
  }
}

function truncateBody(body: string): string {
  return body.length > MAX_STORED_BODY_LENGTH
    ? `${body.slice(0, MAX_STORED_BODY_LENGTH)}…[truncated]`
    : body;
}

/** Reads a response stream up to the hard byte cap and cancels overflow. */
async function readResponseBody(
  response: Response,
  abortController: AbortController,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      parts.push(decoder.decode());
      return { body: parts.join(""), truncated: false };
    }

    const remaining = MAX_RESPONSE_DOWNLOAD_BYTES - bytesRead;
    if (value.byteLength <= remaining) {
      bytesRead += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
      continue;
    }

    if (remaining > 0) {
      parts.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
    }
    parts.push(decoder.decode());
    abortController.abort(new Error("Response body download limit exceeded."));
    await reader.cancel("Response body download limit exceeded.").catch(() => undefined);
    return { body: parts.join(""), truncated: true };
  }
}

/** Truncates a UTF-8 string without exceeding the preview byte cap. */
function createTextPreview(value: string): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= MAX_RESPONSE_PREVIEW_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: new TextDecoder().decode(encoded.subarray(0, MAX_RESPONSE_PREVIEW_BYTES)),
    truncated: true,
  };
}

/** Redacts a Set-Cookie value while preserving its name and attributes. */
function redactSetCookie(value: string, secrets: string[]): string {
  const [cookiePair = "", ...attributes] = value.split(";");
  const separator = cookiePair.indexOf("=");
  const name = (separator === -1 ? cookiePair : cookiePair.slice(0, separator)).trim();
  const redactedPair = `${name}=[redacted]`;
  const redactedAttributes = attributes.map((attribute) =>
    redactSecretsOnly(attribute.trim(), secrets),
  );
  return [redactedPair, ...redactedAttributes].filter(Boolean).join("; ");
}

/**
 * Collects every response header into a plain object so agents can audit the
 * full response surface (e.g. `set-cookie`, `x-powered-by`, `server` leaks).
 * The tester's own secrets are stripped from values; headers whose name looks
 * like a credential are masked to `[redacted]` while the key is preserved so
 * the presence of the leak stays visible.
 */
function collectResponseHeaders(
  responseHeaders: Headers,
  secrets: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  responseHeaders.forEach((value, name) => {
    result[name] = SECRETISH_HEADER_RE.test(name)
      ? "[redacted]"
      : redactSecretsOnly(value, secrets);
  });

  const setCookies =
    typeof responseHeaders.getSetCookie === "function" ? responseHeaders.getSetCookie() : [];
  if (setCookies.length > 0) {
    result["set-cookie"] = setCookies.map((value) => redactSetCookie(value, secrets)).join(", ");
  } else {
    const setCookie = responseHeaders.get("set-cookie");
    if (setCookie) result["set-cookie"] = redactSetCookie(setCookie, secrets);
  }

  return result;
}

/**
 * Executes one instrumented request against the target API: guardrails,
 * env-ref auth injection, verdict, redacted evidence log, budget counter.
 */
export async function executeCall(
  context: ExecutorContext,
  request: CallRequest,
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

  const specLess = context.config.spec === undefined;
  const match = matchOperation(context.operations, request.method, request.path);
  if (!match && !request.allowUndocumented && !specLess) {
    const documentedMethods = context.operations
      .filter((candidate) => matchOperation([candidate], candidate.method, request.path))
      .map((candidate) => candidate.method.toUpperCase());
    const detail =
      documentedMethods.length > 0
        ? ` The path exists for: ${documentedMethods.join(", ")}.`
        : " The path is not present in the loaded spec.";
    throw new ScoutError(
      `Refusing undocumented request ${request.method.toUpperCase()} ${request.path}.${detail}`,
      {
        code: "NOT_FOUND",
        hint: "Use a method and path from `scout endpoints`. Undocumented requests require explicit opt-in.",
      },
    );
  }
  const operation = match?.operation ?? null;
  const authProfileName = request.authProfile ?? context.authProfile;
  const authProfile = authProfileName ? context.config.authProfiles?.[authProfileName] : undefined;
  if (authProfileName && !authProfile) {
    throw new ScoutError(`Unknown auth profile "${authProfileName}".`, {
      code: "VALIDATION_ERROR",
      hint: "Add it to scout.json authProfiles or choose a configured profile.",
    });
  }
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
  assertPathNotNormalized(url, baseUrl, concretePath);
  const secrets: string[] = [];
  let hasCredentialTarget = false;
  const profileQuery = authProfile?.query ?? {};
  for (const [key, template] of Object.entries({ ...profileQuery, ...(request.query ?? {}) })) {
    const credentialLike = isProbeCredentialQuery(key);
    if (credentialLike) hasCredentialTarget = true;
    if (request.noAuth && credentialLike) continue;
    let effectiveValue = request.invalidAuth && credentialLike ? INVALID_CREDENTIAL : template;
    const fromProfile =
      !Object.hasOwn(request.query ?? {}, key) && Object.hasOwn(profileQuery, key);
    if (effectiveValue !== INVALID_CREDENTIAL && fromProfile) {
      const resolved = resolveEnvRefs(effectiveValue);
      effectiveValue = resolved.value;
      secrets.push(...resolved.secrets);
    }
    url.searchParams.append(key, effectiveValue);
    if (isSensitiveQuery(key) && effectiveValue !== INVALID_CREDENTIAL)
      secrets.push(effectiveValue);
  }
  for (const name of authQueryNames) {
    hasCredentialTarget = true;
    if (request.invalidAuth && !url.searchParams.has(name)) {
      url.searchParams.append(name, INVALID_CREDENTIAL);
    }
  }

  assertHostAllowed(url, context.config);
  assertOperationInScope(request.method, operation?.path ?? request.path, context.policy);
  assertMethodAllowed(request.method, context.policy);

  const profileCookies = Object.entries(authProfile?.cookies ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const configuredHeaders = mergeHeadersCaseInsensitive(
    context.config.headers,
    authProfile?.headers,
  );
  if (profileCookies) {
    const cookieName = Object.keys(configuredHeaders).find(
      (name) => name.toLowerCase() === "cookie",
    );
    const mergedCookies = mergeCookieHeaders(
      cookieName ? configuredHeaders[cookieName] : undefined,
      profileCookies,
    );
    if (cookieName) delete configuredHeaders[cookieName];
    if (mergedCookies) configuredHeaders.Cookie = mergedCookies;
  }
  const headers: Record<string, string> = {};
  const syntheticCredentialHeaders = new Set<string>();
  for (const [name, template] of Object.entries(configuredHeaders)) {
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

  if (request.redactBodyEvidence && request.body !== undefined) {
    collectSecretishBodyValues(request.body, secrets);
  }

  const hasBody = request.body !== undefined || request.rawBody !== undefined;
  let serializedBody: string | undefined;
  let bodyContentType = "application/json";
  if (request.rawBody !== undefined) {
    serializedBody = request.rawBody;
  } else if (request.body !== undefined) {
    if (selectRequestContentType(operation) === "application/x-www-form-urlencoded") {
      serializedBody = encodeFormBody(request.body);
      bodyContentType = "application/x-www-form-urlencoded";
    } else {
      serializedBody = JSON.stringify(request.body);
    }
  }
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = bodyContentType;
  }

  const reservedRun = reserveRequest(context.policy.budget, context.cwd);
  const rateLimitWait = reserveRateLimitSlot(context.policy.rateLimit, context.cwd);
  if (rateLimitWait > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, rateLimitWait));
  }

  const startedAt = performance.now();
  const downloadController = new AbortController();
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method.toUpperCase(),
      headers,
      body: serializedBody,
      signal: AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        downloadController.signal,
      ]),
      redirect: "manual",
    });
  } catch (error) {
    throw new Error(
      redactRecordValue(
        `Request to ${url.host} failed: ${error instanceof Error ? error.message : String(error)}`,
        secrets,
      ),
      { cause: error },
    );
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  let downloadedBody: { body: string; truncated: boolean };
  try {
    downloadedBody = await readResponseBody(response, downloadController);
  } catch (error) {
    throw new Error(
      redactRecordValue(
        `Failed to read response from ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
        secrets,
      ),
      { cause: error },
    );
  }
  const rawBody = downloadedBody.body;
  let body: unknown = rawBody;
  let bodyIsJson = false;
  if (!downloadedBody.truncated) {
    try {
      body = JSON.parse(rawBody);
      bodyIsJson = true;
    } catch {
      // keep raw text
    }
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const responseHeaders = collectResponseHeaders(response.headers, secrets);
  const verdict = buildVerdict({
    operation,
    specVersion: context.loadedSpec.specVersion,
    components: context.loadedSpec.spec.components,
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
  const redactedRawBody = redactRecordValue(rawBody, secrets);
  const responseBodyForEvidence =
    request.redactBodyEvidence && bodyIsJson
      ? JSON.stringify(redactJsonSecrets(body, secrets))
      : redactedRawBody;
  let surfacedRequestBody: unknown;
  if (hasBody) {
    if (request.redactBodyEvidence) surfacedRequestBody = "[redacted fuzz body]";
    else if (request.rawBody !== undefined) {
      surfacedRequestBody = redactRecordValue(request.rawBody, secrets);
    } else {
      surfacedRequestBody = redactJsonSecrets(request.body, secrets);
    }
  }

  const record: RequestRecord = {
    id: requestId,
    timestamp: new Date().toISOString(),
    source: request.source,
    testKind:
      request.source === "call" &&
      !request.noAuth &&
      !request.invalidAuth &&
      request.rawBody === undefined
        ? "control"
        : "negative",
    operation: operation ? operationKey(operation) : null,
    method: request.method.toUpperCase(),
    url: redactedUrl,
    status: response.status,
    latencyMs,
    schemaValid: verdict.schemaValid,
    requestHeaders: redactedHeaders,
    ...(hasBody
      ? {
          requestBody: request.redactBodyEvidence
            ? "[redacted fuzz body]"
            : truncateBody(redactRecordValue(serializedBody ?? "", secrets)),
        }
      : {}),
    responseBody: truncateBody(responseBodyForEvidence),
    responseHeaders,
    ...(contentType ? { responseContentType: contentType } : {}),
  };

  appendRequestRecordForRun(
    { ...record, runId: reservedRun.runId },
    reservedRun.runId,
    context.cwd,
  );

  const redactedResponseBody = bodyIsJson ? redactJsonSecrets(body, secrets) : redactedRawBody;
  const serializedResponseBody =
    bodyIsJson && typeof redactedResponseBody !== "string"
      ? JSON.stringify(redactedResponseBody)
      : String(redactedResponseBody);
  const responsePreview = createTextPreview(serializedResponseBody);
  const responseBody =
    bodyIsJson && !responsePreview.truncated ? redactedResponseBody : responsePreview.value;

  const warnings = detectUnredactedSecretWarnings(redactedHeaders, redactedUrl);

  return {
    requestId,
    operation: operation ? operationKey(operation) : null,
    request: {
      method: request.method.toUpperCase(),
      url: redactedUrl,
      headers: redactedHeaders,
      ...(hasBody ? { body: surfacedRequestBody } : {}),
    },
    response: {
      status: response.status,
      ...(contentType ? { contentType } : {}),
      headers: responseHeaders,
      body: responseBody,
      bodyIsJson,
      bodyTruncated: downloadedBody.truncated || responsePreview.truncated,
    },
    verdict,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Flags outbound header or URL values that still look like live credentials
 * after redaction. Scout can only redact secrets it can identify, so a literal
 * token pasted into a non-secret-ish header would leak into output and the
 * `.scout/` evidence log. Warn the operator to move it into an env reference.
 */
function detectUnredactedSecretWarnings(
  redactedHeaders: Record<string, string>,
  redactedUrl: string,
): string[] {
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(redactedHeaders)) {
    if (looksLikeUnredactedSecret(value)) {
      warnings.push(
        `Header "${name}" appears to contain a literal credential that scout cannot redact. Pass secrets as environment references (e.g. --header '${name}: Bearer $TOKEN') so they stay out of output and the .scout/ evidence log.`,
      );
    }
  }
  try {
    const search = new URL(redactedUrl).search;
    if (search && looksLikeUnredactedSecret(decodeURIComponent(search))) {
      warnings.push(
        "The request URL query string appears to contain a literal credential that scout cannot redact. Move it into an env-referenced header or a scout.json authProfile.",
      );
    }
  } catch {
    // non-parseable URL: nothing to inspect
  }
  return warnings;
}
