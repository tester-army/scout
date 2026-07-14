import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeCall,
  matchOperation,
  RateLimiter,
  resolveEnvRefs,
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
  operationList: SpecOperation[] = [],
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
});
