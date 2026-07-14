import { describe, expect, it } from "vitest";
import { isJsonOutputRequested, ScoutError, toJsonErrorEnvelope } from "./errors.js";

describe("CLI error envelopes", () => {
  it("detects JSON mode from argv", () => {
    expect(isJsonOutputRequested(["node", "scout", "status", "--json"])).toBe(true);
    expect(isJsonOutputRequested(["node", "scout", "status"])).toBe(false);
  });

  it("formats missing API key errors", () => {
    expect(
      toJsonErrorEnvelope(
        new Error("Missing API key. Run `scout auth` first or set TESTERARMY_API_KEY."),
        2,
      ),
    ).toEqual({
      success: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "Missing API key. Run `scout auth` first or set TESTERARMY_API_KEY.",
        hint: "Run `scout auth` or set TESTERARMY_API_KEY.",
      },
      exitCode: 2,
    });
  });

  it("formats API status errors", () => {
    const error = new Error("Forbidden") as Error & { statusCode: number };
    error.statusCode = 403;

    expect(toJsonErrorEnvelope(error, 2)).toEqual({
      success: false,
      error: {
        code: "AUTH_FAILED",
        message:
          "Authentication failed. Please run `scout auth` to configure your API key or check that your key is valid.",
        hint: "Run `scout auth` or set TESTERARMY_API_KEY, then retry the command.",
        statusCode: 403,
      },
      exitCode: 2,
    });
  });

  it("carries explicit code and hint from ScoutError", () => {
    const error = new ScoutError("No scout session in this directory.", {
      code: "NO_SESSION",
      hint: "Run `scout init <spec>` first.",
    });

    expect(toJsonErrorEnvelope(error, 2)).toEqual({
      success: false,
      error: {
        code: "NO_SESSION",
        message: "No scout session in this directory.",
        hint: "Run `scout init <spec>` first.",
      },
      exitCode: 2,
    });
  });

  it("extracts status code from nested causes", () => {
    const inner = new Error("upstream") as Error & { statusCode: number };
    inner.statusCode = 429;
    const outer = new Error("wrapped", { cause: inner });

    expect(toJsonErrorEnvelope(outer, 2).error.statusCode).toBe(429);
  });
});
