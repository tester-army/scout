import { describe, expect, it } from "vitest";
import type { SpecOperation } from "./spec-loader.js";
import {
  buildVerdict,
  countUncompilableSchemaOperations,
  mediaTypeMatches,
  selectResponseSpec,
  validateSchemaValue,
} from "./verdict.js";

function operation(overrides: Partial<SpecOperation> = {}): SpecOperation {
  return {
    method: "get",
    path: "/pets",
    tags: [],
    deprecated: false,
    secured: false,
    authParameters: [],
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

describe("countUncompilableSchemaOperations", () => {
  it("counts operations whose JSON response schema cannot compile", () => {
    const good = operation({ path: "/ok" });
    const bad = operation({
      path: "/bad",
      responses: {
        "200": {
          description: "bad",
          content: {
            // Invalid: `type` must be a string/array, not a number.
            "application/json": { schema: { type: 42 } as unknown as object },
          },
        },
      },
    });

    const result = countUncompilableSchemaOperations([good, bad], "3.0.0");
    expect(result.count).toBe(1);
    expect(result.operations).toEqual(["GET /bad"]);
  });

  it("ignores non-JSON and schema-less responses", () => {
    const op = operation({
      path: "/text",
      responses: { "200": { description: "ok", content: { "text/plain": {} } } },
    });
    expect(countUncompilableSchemaOperations([op], "3.0.0").count).toBe(0);
  });
});

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

describe("mediaTypeMatches", () => {
  it("matches exact and wildcard media ranges without treating all JSON types as equal", () => {
    expect(mediaTypeMatches("application/json", "application/json; charset=utf-8")).toBe(true);
    expect(mediaTypeMatches("application/json", "application/problem+json")).toBe(false);
    expect(mediaTypeMatches("application/*+json", "application/problem+json")).toBe(true);
    expect(mediaTypeMatches("application/*", "application/json")).toBe(true);
  });
});

describe("validateSchemaValue", () => {
  it("validates request values with OpenAPI 3.0 nullable support", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", nullable: true } },
    };
    expect(validateSchemaValue(schema, "3.0.3", { name: null })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateSchemaValue(schema, "3.0.3", {})).toMatchObject({ valid: false });
  });

  it("supports JSON Schema boolean schemas", () => {
    expect(validateSchemaValue(true, "3.1.0", { anything: true })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateSchemaValue(false, "3.1.0", null)).toMatchObject({ valid: false });
  });

  it("names the offending property for additionalProperties errors", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
    };
    expect(validateSchemaValue(schema, "3.1.0", { name: "ok", extra: 1 })).toEqual({
      valid: false,
      errors: ["(root) must NOT have additional properties (found: extra)"],
    });
  });

  it("lists allowed values for enum errors", () => {
    const schema = { type: "string", enum: ["a", "b"] };
    expect(validateSchemaValue(schema, "3.1.0", "c")).toEqual({
      valid: false,
      errors: ["(root) must be equal to one of the allowed values (allowed: a, b)"],
    });
  });

  it("resolves circular $refs via spec components", () => {
    const components = {
      schemas: {
        node: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", nullable: true },
            parent: { $ref: "#/components/schemas/node" },
          },
        },
      },
    };
    const schema = { $ref: "#/components/schemas/node" };
    expect(validateSchemaValue(schema, "3.0.3", { name: null }, components)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateSchemaValue(schema, "3.0.3", { name: "a", parent: { name: "b" } }, components),
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateSchemaValue(schema, "3.0.3", { name: "a", parent: {} }, components),
    ).toMatchObject({
      valid: false,
      errors: ["/parent must have required property 'name'"],
    });
    expect(validateSchemaValue(schema, "3.0.3", {}, components)).toMatchObject({ valid: false });
  });

  it("honors nullable beside anyOf (OpenAPI 3.0 without type)", () => {
    const schema = {
      type: "object",
      properties: {
        address: { nullable: true, anyOf: [{ type: "object" }] },
      },
    };
    expect(validateSchemaValue(schema, "3.0.3", { address: null })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateSchemaValue(schema, "3.0.3", { address: {} })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateSchemaValue(schema, "3.0.3", { address: 5 })).toMatchObject({ valid: false });
  });

  it("admits null for nullable enums (OpenAPI 3.0)", () => {
    const schema = {
      type: "object",
      properties: {
        business_type: { type: "string", nullable: true, enum: ["company", "individual"] },
      },
    };
    expect(validateSchemaValue(schema, "3.0.3", { business_type: null })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateSchemaValue(schema, "3.0.3", { business_type: "other" })).toMatchObject({
      valid: false,
    });
  });

  it("returns null for unresolvable $refs without components", () => {
    expect(validateSchemaValue({ $ref: "#/components/schemas/missing" }, "3.0.3", {})).toBeNull();
  });

  it("annotates oneOf errors with matching branch info", () => {
    const schema = {
      oneOf: [{ type: "object" }, { type: "object", properties: { x: { type: "number" } } }],
    };
    const result = validateSchemaValue(schema, "3.1.0", {});
    expect(result?.valid).toBe(false);
    expect(result?.errors).toContain(
      "(root) must match exactly one schema in oneOf (matched schemas at indexes: 0, 1)",
    );
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
    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toContain("PASS");
    expect(verdict.summary).toContain("schema: valid");
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
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("FAIL");
    expect(verdict.summary).toContain("schema: INVALID");
  });

  it("fails and summarizes a response content-type mismatch", () => {
    const verdict = buildVerdict({
      ...base,
      operation: operation(),
      status: 200,
      contentType: "application/problem+json",
      body: { id: 1 },
      bodyIsJson: true,
    });

    expect(verdict.contentTypeMatch).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("content-type: MISMATCH");
  });

  it("stays ok on unknown checks (nothing definitive to fail)", () => {
    const verdict = buildVerdict({
      ...base,
      operation: null,
      status: 200,
      body: {},
      bodyIsJson: true,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toContain("PASS");
    expect(verdict.summary).toContain("status: undocumented");
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

  it("treats a matched --expect as PASS even for an undocumented status", () => {
    // Operation documents only 200/404; user asserts 404 and gets 404.
    const op = operation({ responses: { "200": { description: "ok" } } });
    const verdict = buildVerdict({
      ...base,
      operation: op,
      status: 404,
      body: {},
      bodyIsJson: false,
      expect: 404,
    });

    expect(verdict.expectMatched).toBe(true);
    expect(verdict.statusExpected).toBe(false);
    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toContain("PASS");
    expect(verdict.summary).toContain("status: not-in-spec");
  });

  it("fails an unrequested server error even when the spec documents 500", () => {
    const op = operation({
      responses: {
        "200": { description: "ok" },
        "500": { description: "server error" },
      },
    });
    const verdict = buildVerdict({
      ...base,
      operation: op,
      status: 500,
      contentType: "application/json",
      body: {},
      bodyIsJson: true,
    });

    expect(verdict.serverError).toBe(true);
    expect(verdict.statusExpected).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("SERVER ERROR");
  });

  it("passes a 5xx only when explicitly asserted via --expect", () => {
    const op = operation({ responses: { "500": { description: "server error" } } });
    const verdict = buildVerdict({
      ...base,
      operation: op,
      status: 500,
      body: {},
      bodyIsJson: false,
      expect: 500,
    });

    expect(verdict.serverError).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it("records expect matching and fails the verdict on a mismatch", () => {
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
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("expect: MISMATCH");
  });
});
