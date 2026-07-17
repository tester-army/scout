import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_DOWNLOAD_BYTES, MAX_RESPONSE_PREVIEW_BYTES } from "./constants.js";
import {
  encodeFormBody,
  executeCall,
  matchOperation,
  RateLimiter,
  resolveEnvRefs,
  selectRequestContentType,
  type ExecutorContext,
} from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";

function op(method: SpecOperation["method"], path: string): SpecOperation {
  return {
    method,
    path,
    tags: [],
    deprecated: false,
    secured: false,
    authParameters: [],
    parameters: [],
    responses: {},
  };
}

const operations = [op("get", "/pets"), op("get", "/pets/{petId}"), op("post", "/pets")];

/** Creates a minimal executor context backed by a temporary session. */
function createTestContext(
  cwd: string,
  headers: Record<string, string> = {},
  operationList: SpecOperation[] = operations,
): ExecutorContext {
  const sessionDir = join(cwd, ".scout");
  mkdirSync(sessionDir);
  writeFileSync(
    join(sessionDir, "state.json"),
    JSON.stringify({
      specSource: "test",
      specHash: "test",
      createdAt: new Date(0).toISOString(),
      requestCount: 0,
    }),
  );

  return {
    cwd,
    config: { spec: "test", baseUrl: "https://api.example.com", headers },
    policy: { allowMutations: true, rateLimit: 5, budget: 20 },
    loadedSpec: {
      spec: { openapi: "3.1.0", paths: {} },
      source: "test",
      hash: "test",
      title: "Test",
      version: "1",
      specVersion: "3.1.0",
      converted: false,
      dereferenced: true,
      warnings: [],
    },
    operations: operationList,
  };
}

describe("matchOperation", () => {
  it("matches an exact template path", () => {
    const match = matchOperation(operations, "get", "/pets/{petId}");
    expect(match?.operation.path).toBe("/pets/{petId}");
    expect(match?.extractedPathParams).toEqual({});
  });

  it("matches a concrete path and extracts params", () => {
    const match = matchOperation(operations, "get", "/pets/42");
    expect(match?.operation.path).toBe("/pets/{petId}");
    expect(match?.extractedPathParams).toEqual({ petId: "42" });
  });

  it("respects method", () => {
    expect(matchOperation(operations, "delete", "/pets")).toBeNull();
  });

  it("returns null for unknown paths", () => {
    expect(matchOperation(operations, "get", "/unknown/thing/deep")).toBeNull();
  });
});

describe("resolveEnvRefs", () => {
  const original = process.env.SCOUT_TEST_TOKEN;

  beforeEach(() => {
    vi.stubEnv("SCOUT_TEST_TOKEN", "s3cr3t");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original !== undefined) process.env.SCOUT_TEST_TOKEN = original;
  });

  it("resolves $VAR and ${VAR} refs and reports secrets", () => {
    expect(resolveEnvRefs("Bearer $SCOUT_TEST_TOKEN")).toEqual({
      value: "Bearer s3cr3t",
      secrets: ["s3cr3t"],
    });
    expect(resolveEnvRefs("Bearer ${SCOUT_TEST_TOKEN}").value).toBe("Bearer s3cr3t");
  });

  it("throws ENV_VAR_MISSING for an unset variable", () => {
    expect(() => resolveEnvRefs("Bearer $SCOUT_MISSING_VAR")).toThrow();
    try {
      resolveEnvRefs("Bearer $SCOUT_MISSING_VAR");
    } catch (error) {
      expect((error as { code: string }).code).toBe("ENV_VAR_MISSING");
    }
  });
});

describe("RateLimiter", () => {
  it("spaces out requests by the configured interval", async () => {
    const limiter = new RateLimiter(50);
    const start = Date.now();
    await limiter.take();
    await limiter.take();
    await limiter.take();
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});

describe("selectRequestContentType", () => {
  const withContent = (content: Record<string, { schema?: unknown }>): SpecOperation => ({
    ...op("post", "/pets"),
    requestBody: { required: true, content },
  });

  it("defaults to JSON without an operation or request body", () => {
    expect(selectRequestContentType(null)).toBe("application/json");
    expect(selectRequestContentType(op("post", "/pets"))).toBe("application/json");
  });

  it("prefers JSON when the spec declares both", () => {
    expect(
      selectRequestContentType(
        withContent({ "application/json": {}, "application/x-www-form-urlencoded": {} }),
      ),
    ).toBe("application/json");
  });

  it("selects form encoding for form-only operations", () => {
    expect(selectRequestContentType(withContent({ "application/x-www-form-urlencoded": {} }))).toBe(
      "application/x-www-form-urlencoded",
    );
  });
});

describe("encodeFormBody", () => {
  it("encodes flat, nested, and array values with bracket notation", () => {
    expect(
      encodeFormBody({
        name: "a b",
        metadata: { source: "scout" },
        items: [{ price: 5 }],
        nullable: null,
        skipped: undefined,
      }),
    ).toBe("name=a%20b&metadata%5Bsource%5D=scout&items%5B0%5D%5Bprice%5D=5&nullable=");
  });

  it("encodes non-object bodies as an empty string", () => {
    expect(encodeFormBody("scalar")).toBe("");
  });
});

describe("executeCall guardrails", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-executor-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("applies a named header, query, and cookie auth profile", async () => {
    vi.stubEnv("SCOUT_PROFILE_TOKEN", "profile-token");
    vi.stubEnv("SCOUT_PROFILE_KEY", "profile-key");
    vi.stubEnv("SCOUT_PROFILE_SESSION", "profile-session");
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {
      authorization: "Bearer global-token",
      Cookie: "session=global-session; theme=dark",
    });
    context.authProfile = "admin";
    context.config.authProfiles = {
      admin: {
        headers: { Authorization: "Bearer $SCOUT_PROFILE_TOKEN" },
        query: { api_key: "$SCOUT_PROFILE_KEY" },
        cookies: { session: "$SCOUT_PROFILE_SESSION" },
      },
    };

    const result = await executeCall(context, { method: "get", path: "/pets", source: "call" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("api_key")).toBe("profile-key");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer profile-token",
      Cookie: "session=profile-session; theme=dark",
    });
    expect(result.request.headers.Authorization).toBe("[redacted]");
    expect(result.request.headers.Cookie).toBe("[redacted]");
    expect(result.request.url).not.toContain("profile-key");
  });

  it("does not resolve real query credentials for missing-auth probes", async () => {
    const secured = {
      ...op("get", "/pets"),
      secured: true,
      authParameters: [{ name: "api_key", in: "query" as const }],
    };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {}, [secured]);
    context.authProfile = "admin";
    context.config.authProfiles = { admin: { query: { api_key: "$UNSET_PROFILE_KEY" } } };

    await executeCall(context, { method: "get", path: "/pets", source: "call", noAuth: true });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.has("api_key")).toBe(false);
  });

  it("rejects an unknown auth profile before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd);
    context.authProfile = "missing";

    await expect(
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces configured method and path scope before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd);
    context.policy.allowedMethods = ["GET"];
    context.policy.allowedPaths = ["/public/**"];

    await expect(
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
    ).rejects.toMatchObject({ code: "SCOPE_BLOCKED" });
    await expect(
      executeCall(context, { method: "post", path: "/pets", source: "call" }),
    ).rejects.toMatchObject({ code: "SCOPE_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects path parameters that normalize into another path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {}, [op("get", "/users/{id}/profile")]);

    await expect(
      executeCall(context, {
        method: "get",
        path: "/users/{id}/profile",
        pathParams: { id: ".." },
        source: "call",
      }),
    ).rejects.toMatchObject({ code: "SCOPE_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects undocumented method/path pairs unless explicitly allowed", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {}, []);

    await expect(
      executeCall(context, { method: "get", path: "/private", source: "call" }),
    ).rejects.toThrow("Refusing undocumented request GET /private");
    expect(fetchMock).not.toHaveBeenCalled();

    await executeCall(context, {
      method: "get",
      path: "/private",
      source: "call",
      allowUndocumented: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("allows any documented-free path in spec-less mode without an opt-in", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {}, []);
    context.config = { ...context.config, spec: undefined };

    const result = await executeCall(context, {
      method: "get",
      path: "/anything",
      source: "call",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(200);
    expect(result.operation).toBeNull();
  });

  it("still blocks mutations in spec-less mode", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd, {}, []);
    context.config = { ...context.config, spec: undefined };
    context.policy.allowMutations = false;

    await expect(
      executeCall(context, { method: "delete", path: "/anything", source: "call" }),
    ).rejects.toThrow(/mutation/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares policy rate limiting across ordinary concurrent calls", async () => {
    const sentAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        sentAt.push(performance.now());
        return new Response("{}", { status: 200 });
      }),
    );
    const context = createTestContext(cwd);
    context.policy.rateLimit = 100;

    await Promise.all([
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
    ]);

    expect(sentAt).toHaveLength(2);
    expect((sentAt[1] as number) - (sentAt[0] as number)).toBeGreaterThanOrEqual(7);
  });

  it("reserves budget before concurrent requests are sent", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = createTestContext(cwd);
    context.policy.budget = 1;

    const results = await Promise.allSettled([
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
      executeCall(context, { method: "get", path: "/pets", source: "call" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const state = JSON.parse(readFileSync(join(cwd, ".scout", "state.json"), "utf-8"));
    expect(state.requestCount).toBe(1);
  });
});

describe("executeCall request security", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-executor-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sends raw text verbatim and redacts stored and returned evidence", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(
      createTestContext(cwd, { Authorization: "Bearer raw-secret" }),
      {
        method: "post",
        path: "/pets",
        source: "call",
        rawBody: '{"token":"raw-secret"',
      },
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"token":"raw-secret"');
    expect(result.request.body).toBe('{"token":"[redacted]"');
    const record = JSON.parse(readFileSync(join(cwd, ".scout", "requests.jsonl"), "utf-8"));
    expect(record.requestBody).toBe('{"token":"[redacted]"');
  });

  it("form-encodes --data bodies for form-only operations", async () => {
    const formOp: SpecOperation = {
      ...op("post", "/pets"),
      requestBody: {
        required: true,
        content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeCall(createTestContext(cwd, {}, [formOp]), {
      method: "post",
      path: "/pets",
      source: "call",
      body: { name: "rex", metadata: { source: "scout" } },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe("name=rex&metadata%5Bsource%5D=scout");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  it("omits configured and per-call credentials for missing-auth probes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ secret: "literal-secret" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(
      createTestContext(cwd, {
        Authorization: "Bearer $SCOUT_UNSET_AUTH_TOKEN",
        "X-Trace": "trace-id",
      }),
      {
        method: "get",
        path: "/pets",
        source: "call",
        noAuth: true,
        query: { api_key: "query-secret", page: "2" },
        headers: { "X-Api-Key": "literal-secret", Cookie: "session=secret" },
      },
    );

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Api-Key")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("X-Trace")).toBe("trace-id");
    expect(input.toString()).toBe("https://api.example.com/pets?page=2");
    expect(result.response.body).toEqual({ secret: "[redacted]" });
  });

  it("replaces configured and per-call credentials without resolving env refs", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ secret: "literal-secret" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(
      createTestContext(cwd, { Authorization: "Bearer $SCOUT_UNSET_AUTH_TOKEN" }),
      {
        method: "get",
        path: "/pets",
        source: "call",
        invalidAuth: true,
        query: { api_key: "query-secret", page: "2" },
        headers: { "X-Api-Key": "literal-secret", "Proxy-Authorization": "Basic abc123" },
      },
    );

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer scout-invalid-credential");
    expect(headers.get("X-Api-Key")).toBe("scout-invalid-credential");
    expect(headers.get("Proxy-Authorization")).toBe("Basic scout-invalid-credential");
    expect(input.toString()).toBe(
      "https://api.example.com/pets?api_key=scout-invalid-credential&page=2",
    );
    expect(result.response.body).toEqual({ secret: "[redacted]" });
  });

  it("adds a synthetic Authorization header when no credential header exists", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
      invalidAuth: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer scout-invalid-credential");
    expect(result.request.headers.Authorization).toBe("Bearer scout-invalid-credential");
  });

  it("preserves the declared HTTP authentication scheme", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const securedOperation = op("get", "/pets");
    securedOperation.secured = true;
    securedOperation.authParameters = [{ name: "Authorization", in: "header", scheme: "Digest" }];

    await executeCall(createTestContext(cwd, {}, [securedOperation]), {
      method: "get",
      path: "/pets",
      source: "call",
      invalidAuth: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Digest scout-invalid-credential");
  });

  it("uses spec-declared custom header and query credential locations", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const securedOperation = op("get", "/pets");
    securedOperation.secured = true;
    securedOperation.authParameters = [
      { name: "X-Credential", in: "header" },
      { name: "accessCode", in: "query" },
    ];

    await executeCall(
      createTestContext(cwd, { "X-Credential": "$SCOUT_UNSET_CUSTOM_TOKEN" }, [securedOperation]),
      {
        method: "get",
        path: "/pets",
        source: "call",
        invalidAuth: true,
      },
    );

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get("X-Credential")).toBe("scout-invalid-credential");
    expect(input.toString()).toBe(
      "https://api.example.com/pets?accessCode=scout-invalid-credential",
    );
  });

  it("redacts encoded custom query credentials by declared parameter name", async () => {
    const secret = "a+b/=";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ secret }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const securedOperation = op("get", "/pets");
    securedOperation.secured = true;
    securedOperation.authParameters = [{ name: "accessCode", in: "query" }];

    const result = await executeCall(createTestContext(cwd, {}, [securedOperation]), {
      method: "get",
      path: "/pets",
      source: "call",
      query: { accessCode: secret },
    });

    expect(result.request.url).toContain("accessCode=%5Bredacted%5D");
    expect(result.request.url).not.toContain("a%2Bb%2F%3D");
    expect(result.response.body).toEqual({ secret: "[redacted]" });
  });

  it("replaces only declared auth cookies and redacts cookie values", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const cookie = new Headers(init?.headers).get("Cookie") ?? "";
      return new Response(JSON.stringify({ cookie, token: "cookie-secret", theme: "dark" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SCOUT_COOKIE_TOKEN", "cookie-secret");
    const securedOperation = op("get", "/pets");
    securedOperation.secured = true;
    securedOperation.authParameters = [{ name: "session", in: "cookie" }];
    const context = createTestContext(cwd, { Cookie: "session=$SCOUT_COOKIE_TOKEN; theme=dark" }, [
      securedOperation,
    ]);

    const result = await executeCall(context, {
      method: "get",
      path: "/pets",
      source: "call",
      invalidAuth: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Cookie")).toBe(
      "session=scout-invalid-credential; theme=dark",
    );
    expect(result.request.headers.Cookie).toBe("[redacted]");
    expect(result.response.body).toEqual({
      cookie: "session=scout-invalid-credential; theme=[redacted]",
      token: "[redacted]",
      theme: "[redacted]",
    });

    const normalResult = await executeCall(context, {
      method: "get",
      path: "/pets",
      source: "call",
    });
    expect(normalResult.response.body).toEqual({
      cookie: "session=[redacted]; theme=[redacted]",
      token: "[redacted]",
      theme: "[redacted]",
    });
  });

  it("removes only declared auth cookies without resolving their env refs", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const securedOperation = op("get", "/pets");
    securedOperation.secured = true;
    securedOperation.authParameters = [{ name: "session", in: "cookie" }];

    await executeCall(
      createTestContext(cwd, { Cookie: "session=$SCOUT_UNSET_COOKIE_TOKEN; theme=dark" }, [
        securedOperation,
      ]),
      { method: "get", path: "/pets", source: "call", noAuth: true },
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Cookie")).toBe("theme=dark");
  });

  it("does not strip benign names containing key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
      noAuth: true,
      query: { monkey: "banana" },
      headers: { Keyboard: "compact" },
    });

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.toString()).toBe("https://api.example.com/pets?monkey=banana");
    expect(new Headers(init.headers).get("Keyboard")).toBe("compact");
    expect(result.request.headers.Keyboard).toBe("compact");
  });

  it("redacts literal credential values recursively from parsed responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token: "literal-secret", nested: ["Bearer literal-secret", "safe"] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
      headers: { Authorization: "Bearer literal-secret" },
    });

    expect(result.response.body).toEqual({
      token: "[redacted]",
      nested: ["[redacted]", "safe"],
    });
  });

  it("redacts real credentials containing the synthetic marker text", async () => {
    const credential = "Bearer real-scout-invalid-credential-value";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ credential }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
      headers: { Authorization: credential },
    });

    expect(result.request.headers.Authorization).toBe("[redacted]");
    expect(result.response.body).toEqual({ credential: "[redacted]" });
  });

  it("omits fuzz bodies and redacts echoed secret-like fields", async () => {
    const secret = 'super-"secret\\value';
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ password: secret, safe: "visible" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "post",
      path: "/pets",
      source: "fuzz",
      body: { password: secret, name: "scout" },
      redactBodyEvidence: true,
    });

    expect(result.request.body).toBe("[redacted fuzz body]");
    expect(result.response.body).toEqual({ password: "[redacted]", safe: "visible" });
    const record = JSON.parse(readFileSync(join(cwd, ".scout", "requests.jsonl"), "utf-8"));
    expect(record.requestBody).toBe("[redacted fuzz body]");
    expect(record.responseBody).not.toContain("super-");
  });

  it("preserves raw JSON response evidence outside fuzz redaction", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"large":9007199254740993,"exponent":1e3}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    const record = JSON.parse(readFileSync(join(cwd, ".scout", "requests.jsonl"), "utf-8"));
    expect(record.responseBody).toBe('{"large":9007199254740993,"exponent":1e3}');
  });
});

describe("executeCall response surface", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-executor-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("captures all response headers and masks credential-like ones", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Server: "Vercel",
            "X-Powered-By": "Next.js",
            "Set-Cookie": "session=supersecret; HttpOnly",
            Authorization: "Bearer leaked-token",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    expect(result.response.headers.server).toBe("Vercel");
    expect(result.response.headers["x-powered-by"]).toBe("Next.js");
    expect(result.response.headers["set-cookie"]).toBe("session=[redacted]; HttpOnly");
    expect(result.response.headers.authorization).toBe("[redacted]");

    const record = JSON.parse(readFileSync(join(cwd, ".scout", "requests.jsonl"), "utf-8"));
    expect(record.responseHeaders.server).toBe("Vercel");
    expect(record.responseHeaders["set-cookie"]).toBe("session=[redacted]; HttpOnly");
  });

  it("redacts the tester's own secret when echoed in a benign response header", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Echo": "raw-secret" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(
      createTestContext(cwd, { Authorization: "Bearer raw-secret" }),
      { method: "get", path: "/pets", source: "call" },
    );

    expect(result.response.headers["x-echo"]).toBe("[redacted]");
  });

  it("returns the full response body without truncation and flags it complete", async () => {
    const big = "x".repeat(50_000);
    const fetchMock = vi.fn(async () => new Response(big, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    expect(typeof result.response.body).toBe("string");
    expect((result.response.body as string).length).toBe(50_000);
    expect(result.response.body).not.toContain("[truncated]");
    expect(result.response.bodyTruncated).toBe(false);
  });

  it("surfaces undocumented response fields in full so leaks stay visible", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "1", internalDebugToken: "should-not-be-here", ssn: "123-45-6789" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    expect(result.response.body).toEqual({
      id: "1",
      internalDebugToken: "should-not-be-here",
      ssn: "123-45-6789",
    });
    expect(result.response.bodyTruncated).toBe(false);
  });

  it("cancels response streaming beyond the download byte limit", async () => {
    let chunk = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(
          chunk === 1 ? new Uint8Array(MAX_RESPONSE_DOWNLOAD_BYTES) : new Uint8Array([120]),
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.response.bodyTruncated).toBe(true);
    expect(new TextEncoder().encode(result.response.body as string).byteLength).toBe(
      MAX_RESPONSE_PREVIEW_BYTES,
    );
  });

  it("returns a bounded preview instead of a large parsed JSON value", async () => {
    const raw = JSON.stringify({ values: ["x".repeat(MAX_RESPONSE_PREVIEW_BYTES)] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(raw, { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );

    const result = await executeCall(createTestContext(cwd), {
      method: "get",
      path: "/pets",
      source: "call",
    });

    expect(result.response.bodyIsJson).toBe(true);
    expect(typeof result.response.body).toBe("string");
    expect(result.response.bodyTruncated).toBe(true);
    expect(new TextEncoder().encode(result.response.body as string).byteLength).toBeLessThanOrEqual(
      MAX_RESPONSE_PREVIEW_BYTES,
    );
  });
});
