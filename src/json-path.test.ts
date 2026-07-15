import { describe, expect, it } from "vitest";
import { extractPath, stringifyExtracted } from "./json-path.js";

describe("extractPath", () => {
  const body = {
    project: { id: "p1", name: "demo" },
    items: [{ id: "a" }, { id: "b" }],
    count: 2,
    nested: { list: [{ tags: ["x", "y"] }] },
  };

  it("reads dotted object paths", () => {
    expect(extractPath(body, "project.id")).toBe("p1");
  });

  it("reads array indices with bracket and dot notation", () => {
    expect(extractPath(body, "items[0].id")).toBe("a");
    expect(extractPath(body, "items.1.id")).toBe("b");
  });

  it("reads deeply nested array values", () => {
    expect(extractPath(body, "nested.list[0].tags[1]")).toBe("y");
  });

  it("returns undefined for missing keys or out-of-range indices", () => {
    expect(extractPath(body, "project.missing")).toBeUndefined();
    expect(extractPath(body, "items[9].id")).toBeUndefined();
    expect(extractPath(body, "count.nope")).toBeUndefined();
  });

  it("returns undefined when descending into null", () => {
    expect(extractPath({ a: null }, "a.b")).toBeUndefined();
  });
});

describe("stringifyExtracted", () => {
  it("passes primitives through", () => {
    expect(stringifyExtracted("abc")).toBe("abc");
    expect(stringifyExtracted(42)).toBe("42");
    expect(stringifyExtracted(true)).toBe("true");
  });

  it("serializes objects and arrays as JSON", () => {
    expect(stringifyExtracted({ a: 1 })).toBe('{"a":1}');
    expect(stringifyExtracted([1, 2])).toBe("[1,2]");
  });

  it("renders null and undefined as an empty string", () => {
    expect(stringifyExtracted(null)).toBe("");
    expect(stringifyExtracted(undefined)).toBe("");
  });
});
