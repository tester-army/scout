import { describe, expect, it } from "vitest";
import {
  evaluateFuzzCase,
  generateBaselineValue,
  planFuzzCases,
  selectJsonRequestSchema,
  type FuzzCase,
} from "./fuzz-engine.js";
import type { CallResult } from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";

const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "age", "tags"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 8 },
    age: { type: "integer", minimum: 18, maximum: 120 },
    tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
    role: { type: "string", enum: ["user", "admin"] },
  },
} as const;

/** Creates one request-body operation for fuzz tests. */
function operation(schema: unknown = requestSchema): SpecOperation {
  return {
    method: "post",
    path: "/users",
    tags: [],
    deprecated: false,
    secured: false,
    authParameters: [],
    parameters: [],
    requestBody: {
      required: true,
      content: { "application/json": { schema } },
    },
    responses: { "400": { description: "invalid" } },
  };
}

/** Creates a minimal call result for fuzz finding evaluation. */
function result(status: number, verdict: Partial<CallResult["verdict"]> = {}): CallResult {
  return {
    requestId: "request-id",
    operation: "POST /users",
    request: { method: "POST", url: "https://api.example.com/users", headers: {} },
    response: { status, headers: {}, body: {}, bodyIsJson: true, bodyTruncated: false },
    verdict: {
      ok: true,
      summary: "PASS",
      status,
      expectedStatuses: ["400"],
      statusExpected: true,
      schemaValid: true,
      schemaErrors: [],
      contentTypeMatch: true,
      latencyMs: 5,
      redacted: false,
      ...verdict,
    },
  };
}

describe("request schema selection", () => {
  it("selects JSON and structured JSON media types", () => {
    expect(selectJsonRequestSchema(operation())).toEqual(requestSchema);
    expect(
      selectJsonRequestSchema({
        ...operation(),
        requestBody: {
          required: true,
          content: { "application/problem+json": { schema: { type: "string" } } },
        },
      }),
    ).toEqual({ type: "string" });
  });

  it("returns null without a JSON request schema", () => {
    expect(
      selectJsonRequestSchema({
        ...operation(),
        requestBody: { required: true, content: { "text/plain": { schema: {} } } },
      }),
    ).toBeNull();
  });

  it("removes readOnly properties from request requirements", () => {
    const schema = selectJsonRequestSchema(
      operation({
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
        },
      }),
    );
    expect(schema?.required).toEqual(["name"]);
    expect(generateBaselineValue(schema ?? {})).toEqual({ name: "s" });
  });

  it("removes cross-branch allOf readOnly requirements", () => {
    const schema = selectJsonRequestSchema(
      operation({
        allOf: [
          { type: "object", required: ["id", "name"] },
          {
            type: "object",
            properties: {
              id: { type: "integer", readOnly: true },
              name: { type: "string" },
            },
          },
        ],
      }),
    );
    expect(generateBaselineValue(schema ?? {})).toEqual({ name: "s" });
  });

  it("supports OpenAPI 3.1 boolean request schemas", () => {
    expect(selectJsonRequestSchema(operation(true))).toBe(true);
    expect(planFuzzCases(true, {}, { maxCases: 10 })).toMatchObject([{ kind: "malformed-json" }]);
    expect(selectJsonRequestSchema(operation(false))).toBe(false);
  });
});

describe("generateBaselineValue", () => {
  it("generates required fields at valid lower boundaries", () => {
    expect(generateBaselineValue(requestSchema)).toEqual({
      name: "ss",
      age: 18,
      tags: ["s"],
    });
  });

  it("uses deterministic format-safe values", () => {
    expect(generateBaselineValue({ type: "string", format: "email" })).toBe(
      "scout@example.invalid",
    );
    expect(generateBaselineValue({ type: "string", format: "uuid" })).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("planFuzzCases", () => {
  it("generates the negative input matrix", () => {
    const baseline = generateBaselineValue(requestSchema);
    const cases = planFuzzCases(requestSchema, baseline, {
      maxCases: 50,
      oversizedLength: 32,
    });
    const kinds = new Set(cases.map((fuzzCase) => fuzzCase.kind));

    expect(kinds).toEqual(
      new Set([
        "malformed-json",
        "null",
        "wrong-type",
        "missing-required",
        "boundary",
        "oversized",
        "unknown-field",
        "enum",
      ]),
    );
    expect(cases.find((fuzzCase) => fuzzCase.id === "below-minimum-age")?.body).toMatchObject({
      age: 17,
    });
    expect(cases.find((fuzzCase) => fuzzCase.id === "unknown-field-root")?.expectedReject).toBe(
      true,
    );
    expect(cases.find((fuzzCase) => fuzzCase.id === "oversized-name")?.expectedReject).toBe(true);
  });

  it("caps cases and marks unbounded oversized inputs as exploratory", () => {
    const schema = { type: "object", properties: { note: { type: "string" } } };
    expect(planFuzzCases(schema, {}, { maxCases: 3 })).toHaveLength(3);

    const cases = planFuzzCases(schema, {}, { maxCases: 10, oversizedLength: 12 });
    expect(cases.find((fuzzCase) => fuzzCase.kind === "oversized")?.expectedReject).toBe(false);
  });

  it("validates cases against union and nullable schemas", () => {
    const unionCases = planFuzzCases({ type: ["string", "number"] }, "s", { maxCases: 10 });
    expect(unionCases.some((fuzzCase) => fuzzCase.id === "wrong-type-root")).toBe(false);

    const nullableCases = planFuzzCases({ oneOf: [{ type: "string" }, { type: "null" }] }, "s", {
      maxCases: 10,
    });
    expect(nullableCases.some((fuzzCase) => fuzzCase.id === "null-root")).toBe(false);
  });

  it("traverses a representative nested array item", () => {
    const schema = {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    const cases = planFuzzCases(schema, generateBaselineValue(schema), { maxCases: 50 });
    expect(cases.some((fuzzCase) => fuzzCase.id === "missing-required-items-0-name")).toBe(true);
  });

  it("does not mutate prototypes for adversarial property names", () => {
    const schema = JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"object","required":["polluted"],"properties":{"polluted":{"type":"string"}}}}}',
    );
    const baseline = generateBaselineValue(schema) as Record<string, unknown>;
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.prototype.hasOwnProperty.call(baseline, "__proto__")).toBe(true);

    planFuzzCases(schema, baseline, { maxCases: 20 });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("enforces hard case and body-size limits", () => {
    const manyProperties = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`field${index}`, { type: "string" }]),
    );
    const cases = planFuzzCases(
      { type: "object", properties: manyProperties },
      {},
      { maxCases: 10_000 },
    );
    expect(cases.length).toBeLessThanOrEqual(100);
    expect(() => planFuzzCases({ type: "string" }, "x".repeat(256 * 1024 + 1))).toThrow(/exceeds/);
  });
});

describe("evaluateFuzzCase", () => {
  const fuzzCase: FuzzCase = {
    id: "wrong-type-name",
    kind: "wrong-type",
    title: "Wrong type at /name",
    target: "/name",
    expectedReject: true,
    body: { name: 123 },
  };

  it("records accepted schema-invalid input as a candidate", () => {
    const findings = evaluateFuzzCase(operation(), fuzzCase, result(201));
    expect(findings.some((finding) => finding.title.includes("Potential invalid-input"))).toBe(
      true,
    );
    expect(findings[0]?.source).toBe("fuzz");
    expect(findings.find((finding) => finding.title.includes("Potential"))?.status).toBe(
      "candidate",
    );
  });

  it("records 5xx and malformed response contracts", () => {
    const findings = evaluateFuzzCase(
      operation(),
      fuzzCase,
      result(500, { statusExpected: false, schemaValid: false, contentTypeMatch: false }),
    );
    expect(findings.some((finding) => finding.category === "error-handling")).toBe(true);
    expect(findings.some((finding) => finding.title.includes("schema mismatch"))).toBe(true);
    expect(findings.some((finding) => finding.title.includes("content type"))).toBe(true);
  });

  it("does not flag a documented 4xx with a valid response", () => {
    expect(evaluateFuzzCase(operation(), fuzzCase, result(400))).toEqual([]);
  });
});
