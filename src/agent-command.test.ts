import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentInitCommand } from "./agent-command.js";

describe("agent init", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs the bundled skill without remote tooling", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "scout-agent-"));
    directories.push(cwd);
    const source = join(cwd, "source-skill.md");
    writeFileSync(source, "# Scout skill\n");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentInitCommand({ cwd, skillSource: source, json: true });

    expect(readFileSync(join(cwd, ".agents", "skills", "scout", "SKILL.md"), "utf-8")).toBe(
      "# Scout skill\n",
    );
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toContain("scout sweep --dry-run");
  });
});
