#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, log } from "@clack/prompts";
import { Command } from "commander";
import { runAuthCommand, runSignoutCommand, type AuthOptions } from "./auth-command.js";
import {
  isJsonOutputRequested,
  isUserCancelledError,
  toErrorMessage,
  toJsonErrorEnvelope,
} from "./errors.js";
import { runStatusCommand, type StatusCommandOptions } from "./status-command.js";
import { getCliVersion } from "./version.js";

// Set up global error handlers IMMEDIATELY before any other code runs
process.on("unhandledRejection", (error) => {
  const message = toErrorMessage(error);
  if (isJsonOutputRequested()) {
    console.error(JSON.stringify(toJsonErrorEnvelope(error, 2), null, 2));
  } else {
    console.error("\nError:", message, "\n");
  }
  process.exit(2);
});

process.on("uncaughtException", (error) => {
  const message = toErrorMessage(error);
  if (isJsonOutputRequested()) {
    console.error(JSON.stringify(toJsonErrorEnvelope(error, 2), null, 2));
  } else {
    console.error("\nError:", message, "\n");
  }
  process.exit(2);
});

// Ignore SIGHUP to allow running in background with `&`
process.on("SIGHUP", () => {
  console.log("Received SIGHUP, continuing in background...");
});

let activeCommandJsonOutput = false;

/** Returns true when either argv or the active Commander action requested JSON. */
function shouldOutputJsonError(): boolean {
  return activeCommandJsonOutput || isJsonOutputRequested();
}

/** Handles command failures and maps to process exit code. */
function handleError(error: unknown, exitCode = 2): never {
  const json = shouldOutputJsonError();
  if (isUserCancelledError(error) || isCancel(error)) {
    if (json) {
      console.error(JSON.stringify(toJsonErrorEnvelope(error, 1), null, 2));
    } else {
      cancel("Cancelled");
    }
    process.exit(1);
  }

  const message = toErrorMessage(error);
  if (json) {
    console.error(JSON.stringify(toJsonErrorEnvelope(error, exitCode), null, 2));
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    log.error(message);
  } else {
    console.error(message);
  }

  process.exit(exitCode);
}

/** Creates the CLI program. */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("scout")
    .description(
      "Safe API exploration harness for coding agents. Scout parses your OpenAPI spec, executes instrumented requests with guardrails, and compiles structured findings — send a scout ahead of the army.",
    )
    .version(getCliVersion())
    .hook("preAction", (_thisCommand, actionCommand) => {
      activeCommandJsonOutput = Boolean(actionCommand.opts().json);
    })
    .addHelpText(
      "after",
      "\nExamples:\n  scout status --json\n  scout auth\n  scout auth signout\n",
    );

  program
    .command("status")
    .description("show session and TesterArmy auth status")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  scout status
  scout status --json
`,
    )
    .action(async (options: StatusCommandOptions) => {
      try {
        await runStatusCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  const authCommand = program
    .command("auth")
    .description("save Tester Army API key to local config (only needed for report --upload)")
    .option("--api-key <key>", "Tester Army API key")
    .option("--base-url <url>", "Tester Army API base URL")
    .addHelpText(
      "after",
      `
Examples:
  scout auth
  scout auth --api-key <key>
  scout auth signout
`,
    )
    .action(async (options: AuthOptions) => {
      try {
        await runAuthCommand(options);
      } catch (error) {
        handleError(error, 1);
      }
    });

  authCommand
    .command("signout")
    .description("remove Tester Army API key from local config")
    .action(async () => {
      try {
        await runSignoutCommand();
      } catch (error) {
        handleError(error, 1);
      }
    });

  return program;
}

/** CLI entrypoint. */
export function run(argv = process.argv): void {
  createProgram().parse(argv);
}

/** Returns true when this module was invoked as the CLI entrypoint. */
export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === argvPath;
  }
}

if (isMainModule()) {
  run();
}
