import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createProgram, isMainModule } from "./cli.js";

/** Returns a subcommand by name for help assertions. */
function getCommand(commandName: string) {
  const command = createProgram().commands.find((item) => item.name() === commandName);
  if (!command) {
    throw new Error(`Missing command: ${commandName}`);
  }
  return command;
}

/** Returns rendered help output including custom help text. */
function renderHelp(command: Command): string {
  let output = "";
  command.configureOutput({ writeOut: (value) => (output += value) });
  command.outputHelp();
  return output;
}

/** Returns a nested subcommand by name for help assertions. */
function getNestedCommand(command: Command, commandName: string): Command {
  const nested = command.commands.find((item) => item.name() === commandName);
  if (!nested) {
    throw new Error(`Missing command: ${command.name()} ${commandName}`);
  }
  return nested;
}

describe("CLI help", () => {
  it("documents runnable examples in root help", () => {
    const help = renderHelp(createProgram());

    expect(help).toContain("scout status --json");
    expect(help).toContain("scout auth");
    expect(help).toContain("scout auth signout");
    expect(help).toContain("Safe API exploration harness for coding agents.");
  });

  it("documents status command", () => {
    const help = renderHelp(getCommand("status"));

    expect(help).toContain("show session and TesterArmy auth status");
    expect(help).toContain("scout status --json");
  });

  it("documents auth flow including signout subcommand", () => {
    const auth = getCommand("auth");
    const help = renderHelp(auth);

    expect(help).toContain("--api-key <key>");
    expect(help).toContain("scout auth signout");
    expect(getNestedCommand(auth, "signout").description()).toContain("remove Tester Army API key");
  });

  it("detects CLI execution through a symlinked bin path", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-cli-"));
    try {
      const target = join(dir, "cli.js");
      const link = join(dir, "scout");
      writeFileSync(target, "#!/usr/bin/env node\n");
      symlinkSync(target, link);

      expect(isMainModule(link, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
