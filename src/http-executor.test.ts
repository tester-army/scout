import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchOperation, RateLimiter, resolveEnvRefs } from "./http-executor.js";
import type { SpecOperation } from "./spec-loader.js";

function op(method: SpecOperation["method"], path: string): SpecOperation {
  return {
    method,
    path,
    tags: [],
    deprecated: false,
    secured: false,
    parameters: [],
    responses: {},
  };
}

const operations = [op("get", "/pets"), op("get", "/pets/{petId}"), op("post", "/pets")];

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
