import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjectConfig } from "./project-config.js";
import { loadSessionState } from "./session-store.js";

/** Creates a minimal OpenAPI spec with a distinct default server. */
const spec = (title: string, server: string) => ({
  openapi: "3.1.0",
  info: { title, version: "1.0.0" },
  servers: [{ url: server }],
  paths: {},
});

describe("init run isolation", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-init-"));
    originalCwd = process.cwd();
    process.chdir(cwd);
    writeFileSync(join(cwd, "first.json"), JSON.stringify(spec("First", "https://first.test")));
    writeFileSync(join(cwd, "second.json"), JSON.stringify(spec("Second", "https://second.test")));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not inherit target or safety config when a new spec is supplied", async () => {
    const { runInitCommand } = await import("./init-command.js");
    await runInitCommand("first.json", {
      baseUrl: "https://override.test",
      header: ["X-Test: old"],
      allowHost: ["uploads.test"],
      allowMutations: true,
      json: true,
    });

    await runInitCommand("second.json", { json: true });

    expect(loadProjectConfig()?.config).toEqual({
      $schema: "https://tester.army/scout.schema.json",
      spec: "second.json",
      baseUrl: "https://second.test",
      policy: { allowMutations: false },
    });
  });

  it("preserves config but starts a clean run during bare hydration", async () => {
    const { runInitCommand } = await import("./init-command.js");
    await runInitCommand("first.json", {
      header: ["X-Test: kept"],
      allowHost: ["uploads.test"],
      json: true,
    });
    const firstRun = loadSessionState();
    writeFileSync(join(cwd, ".scout", "requests.jsonl"), "old run\n");
    const configBefore = readFileSync(join(cwd, "scout.json"), "utf-8");

    await runInitCommand(undefined, { json: true });

    const hydratedResult = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string) as {
      runId: string;
    };
    expect(hydratedResult.runId).not.toBe(firstRun.runId);
    expect(loadSessionState().runId).toBe(hydratedResult.runId);
    expect(loadSessionState().requestCount).toBe(0);
    expect(readFileSync(join(cwd, "scout.json"), "utf-8")).toBe(configBefore);
    expect(() => readFileSync(join(cwd, ".scout", "requests.jsonl"), "utf-8")).toThrow();
  });
});
