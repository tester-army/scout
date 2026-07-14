import { describe, expect, it } from "vitest";
import { filterOperations, parseMethod, resolveOperationsOrThrow } from "./operation-filter.js";
import type { SpecOperation } from "./spec-loader.js";

function op(overrides: Partial<SpecOperation>): SpecOperation {
  return {
    method: "get",
    path: "/",
    tags: [],
    deprecated: false,
    secured: false,
    parameters: [],
    responses: {},
    ...overrides,
  };
}

const operations: SpecOperation[] = [
  op({ method: "get", path: "/pets", tags: ["pets"], summary: "list pets" }),
  op({ method: "post", path: "/pets", tags: ["pets"], summary: "create pet" }),
  op({ method: "get", path: "/admin/stats", tags: ["admin"], summary: "stats" }),
];

describe("filterOperations", () => {
  it("filters by tag", () => {
    expect(filterOperations(operations, { tag: "admin" })).toHaveLength(1);
  });

  it("filters by method", () => {
    expect(filterOperations(operations, { method: "post" })).toHaveLength(1);
  });

  it("filters by path glob", () => {
    expect(filterOperations(operations, { path: "/admin/**" })).toHaveLength(1);
  });

  it("filters by free-text search", () => {
    expect(filterOperations(operations, { search: "create" })).toHaveLength(1);
  });

  it("combines filters", () => {
    expect(filterOperations(operations, { tag: "pets", method: "get" })).toHaveLength(1);
  });
});

describe("parseMethod", () => {
  it("accepts known methods case-insensitively", () => {
    expect(parseMethod("POST")).toBe("post");
  });

  it("rejects unknown methods", () => {
    expect(() => parseMethod("connectx")).toThrow(/--method must be one of/);
  });
});

describe("resolveOperationsOrThrow", () => {
  it("throws VALIDATION_ERROR when explicit filters match nothing", () => {
    expect(() => resolveOperationsOrThrow(operations, { tag: "ghost" })).toThrow();
  });

  it("does not throw on empty result without filters", () => {
    expect(resolveOperationsOrThrow([], {})).toEqual([]);
  });
});
