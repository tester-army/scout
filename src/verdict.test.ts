import { describe, expect, it } from "vitest";
import type { SpecOperation } from "./spec-loader.js";
import { buildVerdict, selectResponseSpec } from "./verdict.js";

function operation(overrides: Partial<SpecOperation> = {}): SpecOperation {
  return {
    method: "get",
    path: "/pets",
    tags: [],
    deprecated: false,
    secured: false,
    parameters: [],
    responses: {
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer" }, name: { type: "string" } },
            },
          },
        },
      },
      "404": { description: "missing" },
    },
    ...overrides,
  };
}

describe("selectResponseSpec", () => {
  it("prefers exact, then wildcard, then default", () => {
    const responses = {
      "200": { description: "ok" },
      "4XX": { description: "client" },
      default: { description: "fallback" },
    };
    expect(selectResponseSpec(responses, 200)?.matchedBy).toBe("exact");
    expect(selectResponseSpec(responses, 404)?.matchedBy).toBe("wildcard");
    expect(selectResponseSpec(responses, 500)?.matchedBy).toBe("default");
  });
});

describe("buildVerdict", () => {
  const base = { specVersion: "3.1.0", latencyMs: 12, redacted: false };

  it("passes a valid response body against the schema", () => {
    const verdict = buildVerdict({
      ...base,
      operation: operation(),
      status: 200,
      contentType: "application/json",
      body: { id: 1, name: "Rex" },
      bodyIsJson: true,
    });

    expect(verdict.statusExpected).toBe(true);
    expect(verdict.schemaValid).toBe(true);
    expect(verdict.schemaErrors).toEqual([]);
    expect(verdict.contentTypeMatch).toBe(true);
  });

  it("flags a response body that violates the schema", () => {
    const verdict = buildVerdict({
      ...base,
      operation: operation(),
      status: 200,
      contentType: "application/json",
      body: { name: "no id" },
      bodyIsJson: true,
    });

    expect(verdict.schemaValid).toBe(false);
    expect(verdict.schemaErrors.length).toBeGreaterThan(0);
  });

  it("marks undocumented statuses as not expected", () => {
    const verdict = buildVerdict({
      ...base,
      operation: operation(),
      status: 418,
      contentType: "application/json",
      body: {},
      bodyIsJson: true,
    });

    expect(verdict.statusExpected).toBe(false);
    expect(verdict.schemaValid).toBe("unknown");
  });

  it("returns unknown when the operation is not in the spec", () => {
    const verdict = buildVerdict({
      ...base,
      operation: null,
      status: 200,
      body: {},
      bodyIsJson: true,
    });

    expect(verdict.statusExpected).toBe("unknown");
    expect(verdict.schemaValid).toBe("unknown");
    expect(verdict.schemaNote).toContain("not found");
  });

  it("honors OpenAPI 3.0 nullable via the transform", () => {
    const op = operation({
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string", nullable: true } },
              },
            },
          },
        },
      },
    });
    const verdict = buildVerdict({
      ...base,
      specVersion: "3.0.3",
      operation: op,
      status: 200,
      contentType: "application/json",
      body: { name: null },
      bodyIsJson: true,
    });

    expect(verdict.schemaValid).toBe(true);
  });

  it("records expect matching", () => {
    const verdict = buildVerdict({
      ...base,
      operation: operation(),
      status: 200,
      contentType: "application/json",
      body: { id: 1 },
      bodyIsJson: true,
      expect: 201,
    });

    expect(verdict.expectMatched).toBe(false);
  });
});
