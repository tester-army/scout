import { describe, expect, it } from "vitest";
import { redactMessage, redactSecretsOnly, redactUrl } from "./redaction.js";

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
});

describe("redactMessage", () => {
  it("still strips query strings for surfaced error messages", () => {
    expect(redactMessage("failed https://api.example.com/x?secret=1", [])).toBe(
      "failed https://api.example.com/x",
    );
  });
});
