import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverSpecUrl,
  extractOperations,
  hashSpec,
  loadSpec,
  operationKey,
  resolveServerBaseUrl,
  type OpenApiDocument,
} from "./spec-loader.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

/** Starts a test HTTP server on an ephemeral local port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Closes a test HTTP server. */
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("loadSpec", () => {
  it("loads and dereferences an OpenAPI 3.1 spec from a file", async () => {
    const loaded = await loadSpec(join(fixturesDir, "petstore-min.json"));

    expect(loaded.title).toBe("Mini Petstore");
    expect(loaded.version).toBe("1.2.3");
    expect(loaded.specVersion).toBe("3.1.0");
    expect(loaded.converted).toBe(false);
    expect(loaded.dereferenced).toBe(true);
    expect(loaded.warnings).toEqual([]);
  });

  it("converts a Swagger 2 spec to OpenAPI 3", async () => {
    const loaded = await loadSpec(join(fixturesDir, "swagger2.json"));

    expect(loaded.converted).toBe(true);
    expect(loaded.specVersion.startsWith("3.")).toBe(true);
    expect(extractOperations(loaded.spec).map(operationKey)).toContain("GET /widgets");
  });

  it("degrades gracefully on unresolvable refs", async () => {
    const loaded = await loadSpec(join(fixturesDir, "broken-refs.json"));

    expect(loaded.warnings.length).toBeGreaterThan(0);
    expect(extractOperations(loaded.spec).map(operationKey)).toContain("GET /things");
  });

  it("dereferences local file refs", async () => {
    const loaded = await loadSpec(join(fixturesDir, "local-ref.json"));
    const operation = extractOperations(loaded.spec)[0];
    const schema = operation.responses["200"]?.content?.["application/json"]?.schema;

    expect(loaded.dereferenced).toBe(true);
    expect(schema).toMatchObject({ type: "object", required: ["id"] });
  });

  it("does not fetch remote external refs", async () => {
    let remoteRequests = 0;
    const remoteServer = createServer((_request, response) => {
      remoteRequests++;
      response.end(JSON.stringify({ type: "string" }));
    });
    const remotePort = await listen(remoteServer);
    const specServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Remote Ref API", version: "1.0.0" },
          paths: {
            "/things": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          $ref: `http://127.0.0.1:${remotePort}/schema.json`,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
    });
    const specPort = await listen(specServer);

    try {
      const loaded = await loadSpec(`http://127.0.0.1:${specPort}/openapi.json`);

      expect(remoteRequests).toBe(0);
      expect(loaded.dereferenced).toBe(false);
      expect(loaded.warnings.join(" ")).toContain("remote external references are disabled");
    } finally {
      await Promise.all([close(specServer), close(remoteServer)]);
    }
  });

  it("does not follow cross-host redirects", async () => {
    let redirectedRequests = 0;
    const redirectedServer = createServer((_request, response) => {
      redirectedRequests++;
      response.end(JSON.stringify({ openapi: "3.0.3" }));
    });
    const redirectedPort = await listen(redirectedServer);
    const sourceServer = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${redirectedPort}/openapi.json`);
      response.end();
    });
    const sourcePort = await listen(sourceServer);

    try {
      await expect(loadSpec(`http://127.0.0.1:${sourcePort}/openapi.json`)).rejects.toMatchObject({
        code: "SPEC_INVALID",
      });
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([close(sourceServer), close(redirectedServer)]);
    }
  });

  it("throws SPEC_INVALID for a missing file", async () => {
    await expect(loadSpec(join(fixturesDir, "nope.json"))).rejects.toMatchObject({
      code: "SPEC_INVALID",
    });
  });
});

describe("discoverSpecUrl", () => {
  it("does not follow cross-host redirects", async () => {
    let redirectedRequests = 0;
    const redirectedServer = createServer((_request, response) => {
      redirectedRequests++;
      response.end(JSON.stringify({ openapi: "3.0.3" }));
    });
    const redirectedPort = await listen(redirectedServer);
    const sourceServer = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${redirectedPort}/openapi.json`);
      response.end();
    });
    const sourcePort = await listen(sourceServer);

    try {
      await expect(discoverSpecUrl(`http://127.0.0.1:${sourcePort}`)).rejects.toMatchObject({
        code: "SPEC_INVALID",
      });
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([close(sourceServer), close(redirectedServer)]);
    }
  });
});

describe("extractOperations", () => {
  it("extracts operations with tags, params, security, and responses", async () => {
    const loaded = await loadSpec(join(fixturesDir, "petstore-min.json"));
    const operations = extractOperations(loaded.spec);

    const getPet = operations.find((op) => operationKey(op) === "GET /pets/{petId}");
    expect(getPet).toBeDefined();
    expect(getPet?.parameters.some((p) => p.name === "petId" && p.in === "path")).toBe(true);
    expect(getPet?.secured).toBe(false);
    expect(Object.keys(getPet?.responses ?? {})).toContain("404");

    const createPet = operations.find((op) => operationKey(op) === "POST /pets");
    expect(createPet?.secured).toBe(true);
    expect(createPet?.authParameters).toEqual([
      { name: "Authorization", in: "header", scheme: "bearer" },
    ]);
    expect(createPet?.requestBody?.required).toBe(true);
  });

  it("resolves custom credential locations and recognizes optional auth", () => {
    const operations = extractOperations({
      openapi: "3.1.0",
      info: { title: "Auth API", version: "1" },
      components: {
        securitySchemes: {
          headerKey: { type: "apiKey", in: "header", name: "X-Credential" },
          queryKey: { type: "apiKey", in: "query", name: "accessCode" },
        },
      },
      paths: {
        "/required": {
          get: {
            security: [{ headerKey: [], queryKey: [] }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/optional": {
          get: {
            security: [{}, { headerKey: [] }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const required = operations.find((operation) => operation.path === "/required");
    expect(required?.secured).toBe(true);
    expect(required?.authParameters).toEqual([
      { name: "X-Credential", in: "header" },
      { name: "accessCode", in: "query" },
    ]);

    const optional = operations.find((operation) => operation.path === "/optional");
    expect(optional?.secured).toBe(false);
    expect(optional?.authParameters).toEqual([]);
  });

  it("returns an empty list for a spec with no paths", () => {
    const empty: OpenApiDocument = { openapi: "3.0.0", info: { title: "x", version: "1" } };
    expect(extractOperations(empty)).toEqual([]);
  });
});

describe("resolveServerBaseUrl", () => {
  const doc = (servers: OpenApiDocument["servers"]): OpenApiDocument => ({
    openapi: "3.0.0",
    info: { title: "x", version: "1" },
    servers,
  });

  it("uses an absolute server URL directly", () => {
    expect(resolveServerBaseUrl(doc([{ url: "https://api.example.com/api" }]), "spec.json")).toBe(
      "https://api.example.com/api",
    );
  });

  it("resolves a relative server URL against a spec fetched over HTTP", () => {
    expect(
      resolveServerBaseUrl(doc([{ url: "/api" }]), "https://tester.army/api/v1/openapi.json"),
    ).toBe("https://tester.army/api");
  });

  it("substitutes server-variable defaults", () => {
    const server = {
      url: "https://{host}/api",
      variables: { host: { default: "api.example.com" } },
    };
    const spec: OpenApiDocument = {
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      servers: [server],
    };
    expect(resolveServerBaseUrl(spec, "spec.json")).toBe("https://api.example.com/api");
  });

  it("returns undefined for a relative URL with a local spec file", () => {
    expect(resolveServerBaseUrl(doc([{ url: "/api" }]), "/local/spec.json")).toBeUndefined();
  });

  it("returns undefined when no servers are declared", () => {
    expect(resolveServerBaseUrl(doc(undefined), "spec.json")).toBeUndefined();
  });

  it("returns undefined when variables cannot be resolved", () => {
    expect(resolveServerBaseUrl(doc([{ url: "https://{host}/api" }]), "spec.json")).toBeUndefined();
  });
});

describe("hashSpec", () => {
  it("is stable and content-sensitive", () => {
    const a = hashSpec({ a: 1 });
    expect(a).toBe(hashSpec({ a: 1 }));
    expect(a).not.toBe(hashSpec({ a: 2 }));
  });
});
