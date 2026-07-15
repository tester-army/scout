import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  incrementRequestCount,
  initSession,
  loadCachedSpec,
  loadSessionState,
  resetSession,
} from "./session-store.js";
import type { LoadedSpec } from "./spec-loader.js";

const loadedSpec: LoadedSpec = {
  spec: { openapi: "3.1.0", info: { title: "Test", version: "1.0.0" }, paths: {} },
  source: "openapi.json",
  hash: "spec-hash",
  title: "Test",
  version: "1.0.0",
  specVersion: "3.1.0",
  converted: false,
  dereferenced: true,
  warnings: [],
};

describe("session runs", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-session-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("starts an isolated run on every init", () => {
    const first = initSession(loadedSpec, cwd);
    incrementRequestCount(cwd);
    for (const filename of ["requests.jsonl", "findings.jsonl", "vars.json"]) {
      writeFileSync(join(cwd, ".scout", filename), "old run\n");
    }

    const second = initSession(loadedSpec, cwd);

    expect(second.runId).not.toBe(first.runId);
    expect(loadSessionState(cwd)).toEqual(second);
    expect(second.requestCount).toBe(0);
    for (const filename of ["requests.jsonl", "findings.jsonl", "vars.json"]) {
      expect(existsSync(join(cwd, ".scout", filename))).toBe(false);
    }
  });

  it("resets artifacts without replacing the cached spec", () => {
    const first = initSession(loadedSpec, cwd);
    const cached = loadCachedSpec(cwd);
    writeFileSync(join(cwd, ".scout", "findings.jsonl"), "old run\n");

    const second = resetSession(cwd);

    expect(second.runId).not.toBe(first.runId);
    expect(second.requestCount).toBe(0);
    expect(loadCachedSpec(cwd)).toEqual(cached);
    expect(existsSync(join(cwd, ".scout", "findings.jsonl"))).toBe(false);
  });
});
