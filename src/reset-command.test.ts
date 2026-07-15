import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSession } from "./session-store.js";

describe("reset command", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "scout-reset-"));
    originalCwd = process.cwd();
    process.chdir(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("prints the new run ID as JSON", async () => {
    const first = initSession(
      {
        spec: { openapi: "3.1.0", info: { title: "Test", version: "1" }, paths: {} },
        source: "test",
        hash: "hash",
        title: "Test",
        version: "1",
        specVersion: "3.1.0",
        converted: false,
        dereferenced: true,
        warnings: [],
      },
      cwd,
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runResetCommand } = await import("./reset-command.js");

    runResetCommand({ json: true });

    expect(JSON.parse(output.mock.calls[0]?.[0] as string).runId).not.toBe(first.runId);
  });
});
