import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScoutError } from "./errors.js";
import { hasInterpolation, interpolateVars, loadVars, saveVars, setVar } from "./session-vars.js";

describe("session vars store", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-vars-"));
    mkdirSync(join(cwd, ".scout"));
    writeFileSync(
      join(cwd, ".scout", "state.json"),
      JSON.stringify({
        runId: "test-run",
        specSource: "test",
        specHash: "test",
        createdAt: new Date(0).toISOString(),
        requestCount: 0,
      }),
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns an empty map when nothing is captured", () => {
    expect(loadVars(cwd)).toEqual({});
  });

  it("persists and reloads variables", () => {
    saveVars({ projectId: "p1" }, cwd);
    expect(loadVars(cwd)).toEqual({ projectId: "p1" });
    expect(statSync(join(cwd, ".scout", "vars.json")).mode & 0o777).toBe(0o600);
  });

  it("sets a single variable while preserving existing ones", () => {
    setVar("a", "1", cwd);
    setVar("b", "2", cwd);
    expect(loadVars(cwd)).toEqual({ a: "1", b: "2" });
  });

  it("throws a useful error for a corrupt vars file", () => {
    writeFileSync(join(cwd, ".scout", "vars.json"), "{broken");
    expect(() => loadVars(cwd)).toThrowError(/Failed to parse session variables/);
  });

  it("rejects non-string variable values", () => {
    writeFileSync(join(cwd, ".scout", "vars.json"), JSON.stringify({ id: 123 }));
    expect(() => loadVars(cwd)).toThrowError(/expected string values/);
  });

  it("requires an active session before writing", () => {
    rmSync(join(cwd, ".scout", "state.json"));
    expect(() => saveVars({ projectId: "p1" }, cwd)).toThrowError(/No scout session/);
    expect(() => setVar("projectId", "p1", cwd)).toThrowError(/No scout session/);
  });
});

describe("interpolateVars", () => {
  it("replaces known references", () => {
    expect(interpolateVars("/v1/projects/{{id}}", { id: "p1" })).toBe("/v1/projects/p1");
  });

  it("replaces multiple references and tolerates whitespace", () => {
    expect(interpolateVars("{{a}}-{{ b }}", { a: "x", b: "y" })).toBe("x-y");
  });

  it("leaves text without references untouched", () => {
    expect(interpolateVars("/v1/projects", {})).toBe("/v1/projects");
  });

  it("throws a helpful error for unknown references", () => {
    expect(() => interpolateVars("{{missing}}", {})).toThrow(ScoutError);
  });
});

describe("hasInterpolation", () => {
  it("detects references regardless of prior regex state", () => {
    expect(hasInterpolation("{{a}}")).toBe(true);
    expect(hasInterpolation("{{a}}")).toBe(true);
    expect(hasInterpolation("plain")).toBe(false);
  });
});
