#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, log } from "@clack/prompts";
import { Command, Option } from "commander";
import { runAgentInitCommand, type AgentInitOptions } from "./agent-command.js";
import { runAuthCommand, runSignoutCommand, type AuthOptions } from "./auth-command.js";
import { runCallCommand, type CallOptions } from "./call-command.js";
import { runCoverageCommand, type CoverageOptions } from "./coverage-command.js";
import { runDocsCommand, type DocsOptions } from "./docs-command.js";
import { runEndpointsCommand, type EndpointsOptions } from "./endpoints-command.js";
import {
  isJsonOutputRequested,
  isUserCancelledError,
  toErrorMessage,
  toJsonErrorEnvelope,
} from "./errors.js";
import {
  runFindingAddCommand,
  runFindingListCommand,
  type FindingAddOptions,
  type FindingListOptions,
} from "./finding-command.js";
import { runInitCommand, type InitOptions } from "./init-command.js";
import { runReportCommand, type ReportOptions } from "./report-command.js";
import { runSchemaCommand, type SchemaOptions } from "./schema-command.js";
import { runStatusCommand, type StatusCommandOptions } from "./status-command.js";
import { runSweepCommand, type SweepOptions } from "./sweep-command.js";
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

/** Collects repeatable option values into an array. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parses an integer option, throwing on invalid input. */
function parseIntOption(flag: string): (value: string) => number {
  return (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
    return parsed;
  };
}

/** Creates the CLI program. */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("scout")
    .description(
      "Guardrailed API testing harness for coding agents. Scout parses your OpenAPI spec, executes instrumented requests, and compiles structured findings — send a scout ahead of the army.",
    )
    .version(getCliVersion())
    .hook("preAction", (_thisCommand, actionCommand) => {
      activeCommandJsonOutput = Boolean(actionCommand.opts().json);
    })
    .addHelpText(
      "after",
      `
Examples:
  scout init https://api.example.com/openapi.json --base-url https://api.example.com
  scout endpoints --tag users --json
  scout schema GET /users/{id} --json
  scout sweep --tag users --max-requests 25 --json
  scout call GET /users --query limit=10 --json
  scout coverage --json
  scout report --ci --md report.md
  scout agent init
`,
    );

  program
    .command("init")
    .description("generate scout.json and cache the OpenAPI spec")
    .argument("[spec]", "OpenAPI spec URL or file path")
    .option("--base-url <url>", "base URL of the API under test")
    .option(
      "--header <header>",
      "header template, e.g. 'Authorization: Bearer $TOKEN'",
      collect,
      [],
    )
    .option("--allow-mutations", "allow POST/PUT/PATCH/DELETE requests")
    .option("--allow-host <host>", "additional allowlisted host", collect, [])
    .option("--discover", "probe well-known paths for a spec under --base-url")
    .option("--config <path>", "path to scout.json")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  scout init openapi.yaml --base-url https://api.example.com
  scout init openapi.yaml --base-url https://api.example.com --header 'Authorization: Bearer $API_TOKEN'
  scout init --discover --base-url https://api.example.com
  scout init --allow-mutations
`,
    )
    .action(async (spec: string | undefined, options: InitOptions) => {
      try {
        await runInitCommand(spec, options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("status")
    .description("show session and TesterArmy auth status")
    .option("--json", "output as JSON")
    .addHelpText("after", "\nExamples:\n  scout status\n  scout status --json\n")
    .action(async (options: StatusCommandOptions) => {
      try {
        await runStatusCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("endpoints")
    .description("list a compact endpoint index")
    .option("--tag <tag>", "filter by tag")
    .option("--path <glob>", "filter by path glob")
    .option("--method <method>", "filter by HTTP method")
    .option("--search <query>", "filter by free-text search")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout endpoints --json\n  scout endpoints --tag users --json\n  scout endpoints --path '/admin/**' --json\n",
    )
    .action(async (options: EndpointsOptions) => {
      try {
        await runEndpointsCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("schema")
    .description("show parameters, body, and response schemas for one operation")
    .argument("<method>", "HTTP method")
    .argument("<path>", "operation path, e.g. /users/{id}")
    .option("--json", "output as JSON")
    .addHelpText("after", "\nExamples:\n  scout schema GET /users/{id} --json\n")
    .action(async (method: string, path: string, options: SchemaOptions) => {
      try {
        await runSchemaCommand(method, path, options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("call")
    .description("execute one instrumented request and return a verdict")
    .argument("<method>", "HTTP method")
    .argument("<path>", "operation path, e.g. /users/{id}")
    .option("--path-param <kv>", "path parameter key=value", collect, [])
    .option("--query <kv>", "query parameter key=value", collect, [])
    .addOption(
      new Option("--data <json>", "JSON request body").conflicts([
        "dataStdin",
        "rawData",
        "rawDataStdin",
      ]),
    )
    .addOption(
      new Option("--data-stdin", "read JSON request body from stdin").conflicts([
        "data",
        "rawData",
        "rawDataStdin",
      ]),
    )
    .addOption(
      new Option("--raw-data <text>", "raw request body sent verbatim").conflicts([
        "data",
        "dataStdin",
        "rawDataStdin",
      ]),
    )
    .addOption(
      new Option("--raw-data-stdin", "read raw request body from stdin").conflicts([
        "data",
        "dataStdin",
        "rawData",
      ]),
    )
    .option("--header <kv>", "extra header Name:Value", collect, [])
    .option("--expect <status>", "expected HTTP status", parseIntOption("--expect"))
    .option("--no-auth", "drop secret-like headers to probe auth boundaries")
    .addOption(
      new Option(
        "--invalid-auth",
        "replace credentials with deterministic invalid values",
      ).conflicts("auth"),
    )
    .option("--config <path>", "path to scout.json")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  scout call GET /users --json
  scout call GET /users/{id} --path-param id=123 --json
  scout call GET /users --query limit=10 --expect 200 --json
  echo '{"name":"Ada"}' | scout call POST /users --data-stdin --json
  scout call POST /users --raw-data '{"malformed":' --json
  scout call GET /admin --no-auth --json
  scout call GET /admin --invalid-auth --json
`,
    )
    .action(async (method: string, path: string, options: CallOptions) => {
      try {
        await runCallCommand(method, path, options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("sweep")
    .description("deterministic no-LLM baseline pass; auto-records findings")
    .option("--tag <tag>", "filter by tag")
    .option("--path <glob>", "filter by path glob")
    .option("--method <method>", "filter by HTTP method")
    .option("--max-requests <n>", "cap probes", parseIntOption("--max-requests"))
    .option("--no-auth-probes", "skip missing/invalid credential probes")
    .option("--config <path>", "path to scout.json")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout sweep --json\n  scout sweep --tag users --json\n  scout sweep --max-requests 50 --no-auth-probes --json\n",
    )
    .action(async (options: SweepOptions) => {
      try {
        await runSweepCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("coverage")
    .description("operations exercised vs total, with the untouched list")
    .option("--tag <tag>", "filter by tag")
    .option("--path <glob>", "filter by path glob")
    .option("--method <method>", "filter by HTTP method")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout coverage --json\n  scout coverage --tag billing --json\n",
    )
    .action(async (options: CoverageOptions) => {
      try {
        await runCoverageCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  const findingCommand = program
    .command("finding")
    .description("record and list findings")
    .addHelpText(
      "after",
      `
Examples:
  scout finding add --severity high --category contract-violation --endpoint "GET /users" --title "Missing pagination" --json
  scout finding list --json
`,
    );

  findingCommand
    .command("add")
    .description("record a finding")
    .requiredOption("--severity <severity>", "critical, high, medium, low, or info")
    .requiredOption(
      "--category <category>",
      "contract-violation, auth, error-handling, data-integrity, performance, or spec-quality",
    )
    .requiredOption("--endpoint <endpoint>", "operation, e.g. 'GET /users/{id}'")
    .requiredOption("--title <title>", "short human-readable title")
    .option("--description <description>", "longer description")
    .option("--repro <curl>", "reproduction command")
    .option("--json", "output as JSON")
    .action(async (options: FindingAddOptions) => {
      try {
        await runFindingAddCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  findingCommand
    .command("list")
    .description("list recorded findings")
    .option("--json", "output as JSON")
    .action(async (options: FindingListOptions) => {
      try {
        await runFindingListCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("report")
    .description("compile findings + coverage into a report")
    .option("--md <file>", "write Markdown report to a file")
    .option("--json-file <file>", "write JSON report to a file")
    .option("--ci", "exit non-zero when findings at/above the threshold exist")
    .option("--severity-threshold <severity>", "CI gate threshold (default: high)")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  scout report --json
  scout report --md report.md --json-file report.json
  scout report --ci --severity-threshold high
`,
    )
    .action(async (options: ReportOptions) => {
      try {
        await runReportCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  const agentCommand = program
    .command("agent")
    .description("set up scout guidance for coding agents")
    .addHelpText("after", "\nExamples:\n  scout agent init\n  scout agent init --json\n");

  agentCommand
    .command("init")
    .description("install the public scout skill and write AGENTS.md discovery hints")
    .option("--json", "output as JSON")
    .option("--skip-skill-install", "only write AGENTS.md; do not run npx skills add")
    .option("--skip-agents-md", "only install the public skill; do not write AGENTS.md")
    .action(async (options: AgentInitOptions) => {
      try {
        await runAgentInitCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("docs")
    .description("show agent-friendly scout docs")
    .argument("[topic]", "docs topic")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout docs\n  scout docs workflow\n  scout docs call --json\n",
    )
    .action(async (topic: string | undefined, options: DocsOptions) => {
      try {
        await runDocsCommand(topic, options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  const authCommand = program
    .command("auth")
    .description("save Tester Army API key to local config (optional; enables usage attribution)")
    .option("--api-key <key>", "Tester Army API key")
    .option("--base-url <url>", "Tester Army API base URL")
    .addHelpText(
      "after",
      "\nExamples:\n  scout auth\n  scout auth --api-key <key>\n  scout auth signout\n",
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
