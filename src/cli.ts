#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, log } from "@clack/prompts";
import { Command, Option } from "commander";
import { runAgentInitCommand, type AgentInitOptions } from "./agent-command.js";
import { runCallCommand, type CallOptions } from "./call-command.js";
import { runCoverageCommand, type CoverageOptions } from "./coverage-command.js";
import { runEndpointsCommand, type EndpointsOptions } from "./endpoints-command.js";
import {
  isJsonOutputRequested,
  isUserCancelledError,
  toErrorMessage,
  toJsonErrorEnvelope,
} from "./errors.js";
import {
  runFindingAddCommand,
  runFindingConfirmCommand,
  runFindingDismissCommand,
  runFindingListCommand,
  type FindingAddOptions,
  type FindingLifecycleOptions,
  type FindingListOptions,
} from "./finding-command.js";
import { runFuzzCommand, type FuzzOptions } from "./fuzz-command.js";
import { runInitCommand, type InitOptions } from "./init-command.js";
import { stringifyJson } from "./output.js";
import { runReportCommand, type ReportOptions } from "./report-command.js";
import { runResetCommand, type ResetOptions } from "./reset-command.js";
import { runSchemaCommand, type SchemaOptions } from "./schema-command.js";
import { runStatusCommand, type StatusCommandOptions } from "./status-command.js";
import { runSweepCommand, type SweepOptions } from "./sweep-command.js";
import { runVarsCommand, type VarsOptions } from "./vars-command.js";
import { getCliVersion } from "./version.js";

// Set up global error handlers IMMEDIATELY before any other code runs
process.on("unhandledRejection", (error) => {
  const message = toErrorMessage(error);
  if (isJsonOutputRequested()) {
    console.error(stringifyJson(toJsonErrorEnvelope(error, 2)));
  } else {
    console.error("\nError:", message, "\n");
  }
  process.exit(2);
});

process.on("uncaughtException", (error) => {
  const message = toErrorMessage(error);
  if (isJsonOutputRequested()) {
    console.error(stringifyJson(toJsonErrorEnvelope(error, 2)));
  } else {
    console.error("\nError:", message, "\n");
  }
  process.exit(2);
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
      console.error(stringifyJson(toJsonErrorEnvelope(error, 1)));
    } else {
      cancel("Cancelled");
    }
    process.exit(1);
  }

  const message = toErrorMessage(error);
  if (json) {
    console.error(stringifyJson(toJsonErrorEnvelope(error, exitCode)));
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
    .option("--allow-method <method>", "scope requests to an HTTP method", collect, [])
    .option("--allow-path <glob>", "scope requests to an OpenAPI path glob", collect, [])
    .option("--discover", "probe well-known paths for a spec under --base-url")
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
    .description("show local project and run status")
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
    .command("reset")
    .alias("new-run")
    .description("start a clean run while preserving config and cached spec")
    .option("--json", "output as JSON")
    .action((options: ResetOptions) => {
      try {
        runResetCommand(options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  program
    .command("endpoints")
    .description("list a compact endpoint index (capped; filter or use --all)")
    .option("--tag <tag>", "filter by tag")
    .option("--path <glob>", "filter by path glob")
    .option("--method <method>", "filter by HTTP method")
    .option("--search <query>", "filter by free-text search")
    .option("--limit <n>", "max operations to show (default 100)", parseIntOption("--limit"))
    .option("--all", "show every operation (no cap)")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout endpoints --json\n  scout endpoints --tag users --json\n  scout endpoints --path '/admin/**' --json\n  scout endpoints --all --json\n",
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
    .option("--depth <n>", "cap schema nesting depth (default 6)", parseIntOption("--depth"))
    .option("--full", "show full schema with no depth cap")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      "\nExamples:\n  scout schema GET /users/{id} --json\n  scout schema GET /users/{id} --full --json\n",
    )
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
    .option("--allow-undocumented", "allow an operation absent from the OpenAPI spec")
    .option("--auth-profile <name>", "target auth profile from scout.json")
    .option(
      "--capture <name=path>",
      "capture a response-body value into a session variable",
      collect,
      [],
    )
    .addOption(
      new Option(
        "--extract <path>",
        "print one response-body value (for shell capture) and nothing else",
      ).conflicts("json"),
    )
    .option("--fail-on-verdict", "exit 1 when the response verdict fails")
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
  scout call POST /users --data '{"name":"Ada"}' --capture userId=user.id --json
  scout call GET /users/{id} --path-param id={{userId}} --json
  ID=$(scout call POST /users --data '{"name":"Ada"}' --extract user.id)
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
    .command("vars")
    .description("list or clear captured session variables")
    .option("--clear", "remove all captured variables")
    .option("--json", "output as JSON")
    .action((options: VarsOptions) => {
      try {
        runVarsCommand(options);
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
    .option("--search <query>", "filter by free-text search")
    .option("--max-requests <n>", "cap probes", parseIntOption("--max-requests"))
    .option("--no-auth-probes", "skip missing/invalid credential probes")
    .option("--dry-run", "show the probe plan without sending requests")
    .option("--auth-profile <name>", "target auth profile from scout.json")
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
    .command("fuzz")
    .description("generate and execute schema-driven negative request-body cases")
    .argument("<method>", "HTTP method")
    .argument("<path>", "operation path, e.g. /users/{id}")
    .option("--path-param <kv>", "path parameter key=value", collect, [])
    .option("--query <kv>", "query parameter key=value", collect, [])
    .option("--header <kv>", "extra header Name:Value", collect, [])
    .addOption(new Option("--data <json>", "known-valid baseline JSON body").conflicts("dataStdin"))
    .addOption(
      new Option("--data-stdin", "read known-valid baseline JSON from stdin").conflicts("data"),
    )
    .option(
      "--max-cases <n>",
      "cap generated cases, hard maximum 100 (default: 25)",
      parseIntOption("--max-cases"),
    )
    .option("--case <id>", "execute one stable case ID from --dry-run")
    .option(
      "--oversized-length <n>",
      "unbounded string size, capped internally at 65536 (default: 4096)",
      parseIntOption("--oversized-length"),
    )
    .option("--dry-run", "show case metadata without sending requests")
    .option("--auth-profile <name>", "target auth profile from scout.json")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  scout fuzz POST /users --dry-run --json
  scout fuzz POST /users --data '{"name":"scout-test"}' --max-cases 20 --json
  cat baseline.json | scout fuzz PATCH /users/{id} --path-param id=123 --data-stdin --json

Fuzzing may create side effects when invalid input is accepted. Mutations must be enabled and explicitly authorized.
`,
    )
    .action(async (method: string, path: string, options: FuzzOptions) => {
      try {
        await runFuzzCommand(method, path, options);
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
    .command("confirm")
    .description("confirm a candidate finding")
    .argument("<id>", "finding id")
    .option("--json", "output as JSON")
    .action(async (id: string, options: FindingLifecycleOptions) => {
      try {
        await runFindingConfirmCommand(id, options);
      } catch (error) {
        handleError(error, 2);
      }
    });

  findingCommand
    .command("dismiss")
    .description("dismiss a finding so it does not gate reports")
    .argument("<id>", "finding id")
    .option("--json", "output as JSON")
    .action(async (id: string, options: FindingLifecycleOptions) => {
      try {
        await runFindingDismissCommand(id, options);
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
    .option("--ci", "exit non-zero when findings or completeness gates fail")
    .option("--severity-threshold <severity>", "CI gate threshold (default: high)")
    .option(
      "--min-coverage <percent>",
      "minimum operation coverage percentage",
      parseIntOption("--min-coverage"),
    )
    .option("--require-probes", "require at least one sweep probe")
    .option("--no-require-probes", "allow a completed run with zero sweep probes")
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
    .description("install the bundled scout skill and write AGENTS.md discovery hints")
    .option("--json", "output as JSON")
    .option("--skip-skill-install", "only write AGENTS.md")
    .option("--skip-agents-md", "only install the public skill; do not write AGENTS.md")
    .action(async (options: AgentInitOptions) => {
      try {
        await runAgentInitCommand(options);
      } catch (error) {
        handleError(error, 2);
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
