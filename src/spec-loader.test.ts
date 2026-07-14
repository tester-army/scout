import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractOperations,
  hashSpec,
  loadSpec,
  operationKey,
  type OpenApiDocument,
} from "./spec-loader.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

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

  it("throws SPEC_INVALID for a missing file", async () => {
    await expect(loadSpec(join(fixturesDir, "nope.json"))).rejects.toMatchObject({
      code: "SPEC_INVALID",
    });
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
    expect(createPet?.requestBody?.required).toBe(true);
  });

  it("returns an empty list for a spec with no paths", () => {
    const empty: OpenApiDocument = { openapi: "3.0.0", info: { title: "x", version: "1" } };
    expect(extractOperations(empty)).toEqual([]);
  });
});

describe("hashSpec", () => {
  it("is stable and content-sensitive", () => {
    const a = hashSpec({ a: 1 });
    expect(a).toBe(hashSpec({ a: 1 }));
    expect(a).not.toBe(hashSpec({ a: 2 }));
  });
});
