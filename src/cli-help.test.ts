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
      "reset",
      "endpoints",
      "schema",
      "call",
      "vars",
      "sweep",
      "fuzz",
      "coverage",
      "finding",
      "report",
      "agent",
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
    expect(help).toContain("--allow-undocumented");
    expect(help).toContain("--auth-profile");
    expect(help).toContain("--fail-on-verdict");
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
    const sweep = renderHelp(getCommand("sweep"));
    expect(sweep).toContain("--no-auth-probes");
    expect(sweep).toContain("--dry-run");
    const report = renderHelp(getCommand("report"));
    expect(report).toContain("--ci");
    expect(report).toContain("--severity-threshold");
    expect(report).toContain("--min-coverage");
  });

  it("documents schema-driven fuzzing controls", () => {
    const help = renderHelp(getCommand("fuzz"));
    expect(help).toContain("--dry-run");
    expect(help).toContain("--data-stdin");
    expect(help).toContain("--max-cases");
    expect(help).toContain("--case");
    expect(help).toContain("--oversized-length");
    expect(help).toContain("may create side effects");
  });

  it("documents finding subcommands", () => {
    const finding = getCommand("finding");
    expect(getNestedCommand(finding, "add").description()).toContain("record a finding");
    expect(getNestedCommand(finding, "list").description()).toContain("list recorded findings");
    expect(getNestedCommand(finding, "confirm").description()).toContain("confirm a candidate");
    expect(getNestedCommand(finding, "dismiss").description()).toContain("dismiss a finding");
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
