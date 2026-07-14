import { describe, expect, it } from "vitest";
import { parseCategory, parseSeverity, severityRank, validateFindingInput } from "./findings.js";

describe("parseSeverity / parseCategory", () => {
  it("accepts valid values", () => {
    expect(parseSeverity("HIGH")).toBe("high");
    expect(parseCategory("Auth")).toBe("auth");
  });

  it("rejects invalid values", () => {
    expect(() => parseSeverity("urgent")).toThrow(/--severity must be one of/);
    expect(() => parseCategory("bug")).toThrow(/--category must be one of/);
  });
});

describe("severityRank", () => {
  it("ranks critical above info", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("info"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
  });
});

describe("validateFindingInput", () => {
  it("requires endpoint and title", () => {
    expect(() => validateFindingInput({ severity: "high", category: "auth", title: "x" })).toThrow(
      /--endpoint/,
    );
    expect(() =>
      validateFindingInput({ severity: "high", category: "auth", endpoint: "GET /a" }),
    ).toThrow(/--title/);
  });

  it("returns normalized values", () => {
    expect(
      validateFindingInput({
        severity: "High",
        category: "AUTH",
        endpoint: " GET /a ",
        title: " boom ",
      }),
    ).toEqual({ severity: "high", category: "auth", endpoint: "GET /a", title: "boom" });
  });
});
