import { describe, expect, it } from "vitest";
import {
  looksLikeUnredactedSecret,
  redactJsonSecrets,
  redactMessage,
  redactSecretsOnly,
  redactUrl,
} from "./redaction.js";

describe("redactSecretsOnly", () => {
  it("masks exact resolved secrets without touching structure", () => {
    expect(redactSecretsOnly("Bearer s3cr3t and more", ["s3cr3t"])).toBe(
      "Bearer [redacted] and more",
    );
  });

  it("ignores empty secrets", () => {
    expect(redactSecretsOnly("unchanged", [undefined, ""])).toBe("unchanged");
  });
});

describe("redactJsonSecrets", () => {
  it("recursively masks secrets without mutating the input", () => {
    const input = {
      token: "s3cr3t",
      nested: ["Bearer s3cr3t", 42, null, { value: "safe" }],
    };

    expect(redactJsonSecrets(input, ["s3cr3t"])).toEqual({
      token: "[redacted]",
      nested: ["Bearer [redacted]", 42, null, { value: "safe" }],
    });
    expect(input.token).toBe("s3cr3t");
  });
});

describe("redactUrl", () => {
  it("preserves path and non-secret query params", () => {
    expect(redactUrl("https://api.example.com/v1/tests?projectId=abc&limit=10", [])).toBe(
      "https://api.example.com/v1/tests?projectId=abc&limit=10",
    );
  });

  it("masks secret-ish query param values but keeps the keys", () => {
    const out = redactUrl("https://api.example.com/v1/x?api_key=abc123&page=2", []);
    expect(out).toContain("api_key=%5Bredacted%5D");
    expect(out).toContain("page=2");
    expect(out).not.toContain("abc123");
  });

  it("masks exact resolved secrets anywhere in the URL", () => {
    expect(redactUrl("https://api.example.com/v1/x?token2=zzz", ["zzz"])).not.toContain("zzz");
  });

  it("masks declared custom query credentials after URL encoding", () => {
    const out = redactUrl(
      "https://api.example.com/v1/x?accessCode=a%2Bb%2F%3D",
      [],
      ["accessCode"],
    );
    expect(out).toContain("accessCode=%5Bredacted%5D");
    expect(out).not.toContain("a%2Bb%2F%3D");
  });

  it("preserves benign query names containing key", () => {
    expect(redactUrl("https://api.example.com/v1/x?monkey=banana", [])).toBe(
      "https://api.example.com/v1/x?monkey=banana",
    );
  });
});

describe("redactMessage", () => {
  it("still strips query strings for surfaced error messages", () => {
    expect(redactMessage("failed https://api.example.com/x?secret=1", [])).toBe(
      "failed https://api.example.com/x",
    );
  });
});

describe("looksLikeUnredactedSecret", () => {
  it("flags a surviving auth scheme value", () => {
    expect(looksLikeUnredactedSecret("Bearer supersecrettoken123")).toBe(true);
    expect(looksLikeUnredactedSecret("token supersecrettoken1234567890")).toBe(true);
  });

  it("flags a long high-entropy token", () => {
    expect(looksLikeUnredactedSecret("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7")).toBe(true);
  });

  it("does not flag already-redacted values", () => {
    expect(looksLikeUnredactedSecret("[redacted]")).toBe(false);
    expect(looksLikeUnredactedSecret("Bearer [redacted]")).toBe(false);
  });

  it("does not flag benign low-entropy header values", () => {
    expect(looksLikeUnredactedSecret("application/json")).toBe(false);
    expect(looksLikeUnredactedSecret("gzip, deflate, br")).toBe(false);
    expect(looksLikeUnredactedSecret("no-cache")).toBe(false);
    expect(looksLikeUnredactedSecret("en-US,en;q=0.9")).toBe(false);
  });
});
