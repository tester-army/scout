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
  it("documents the full command surface in root help", () => {
    const program = createProgram();
    const help = renderHelp(program);

    expect(help).toContain("Guardrailed API testing harness for coding agents.");
    const commandNames = program.commands.map((command) => command.name());
    for (const expected of [
      "init",
      "status",
      "endpoints",
      "schema",
      "call",
      "sweep",
      "coverage",
      "finding",
      "report",
      "agent",
      "docs",
      "auth",
    ]) {
      expect(commandNames).toContain(expected);
    }
  });

  it("documents the init workflow", () => {
    const help = renderHelp(getCommand("init"));
    expect(help).toContain("--base-url <url>");
    expect(help).toContain("--allow-mutations");
    expect(help).toContain("Authorization: Bearer $API_TOKEN");
  });

  it("documents call flags for exploration", () => {
    const help = renderHelp(getCommand("call"));
    expect(help).toContain("--path-param");
    expect(help).toContain("--data-stdin");
    expect(help).toContain("--raw-data <text>");
    expect(help).toContain("--raw-data-stdin");
    expect(help).toContain("--no-auth");
    expect(help).toContain("--invalid-auth");
    expect(help).toContain("--expect");
  });

  it.each([
    ["--data", "{}", "--data-stdin"],
    ["--data", "{}", "--raw-data", "{"],
    ["--data-stdin", "--raw-data-stdin"],
    ["--raw-data", "x", "--raw-data-stdin"],
    ["--no-auth", "--invalid-auth"],
  ])("rejects conflicting call options: %s", async (...flags) => {
    const command = getCommand("call");
    command.exitOverride();
    command.configureOutput({ writeErr: () => {} });

    await expect(
      command.parseAsync(["GET", "/pets", ...flags], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("documents sweep and report gates", () => {
    expect(renderHelp(getCommand("sweep"))).toContain("--no-auth-probes");
    const report = renderHelp(getCommand("report"));
    expect(report).toContain("--ci");
    expect(report).toContain("--severity-threshold");
  });

  it("documents finding subcommands", () => {
    const finding = getCommand("finding");
    expect(getNestedCommand(finding, "add").description()).toContain("record a finding");
    expect(getNestedCommand(finding, "list").description()).toContain("list recorded findings");
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
