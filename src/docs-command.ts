import { ScoutError } from "./errors.js";
import { isInteractive } from "./utils.js";

export type DocsOptions = {
  json?: boolean;
};

type DocsTopic = {
  name: string;
  summary: string;
  commands: string[];
  notes: string[];
};

const DOCS_TOPICS: DocsTopic[] = [
  {
    name: "workflow",
    summary: "The end-to-end scout loop a coding agent should follow.",
    commands: [
      "scout init <spec> --base-url <url>",
      "scout sweep --json",
      "scout endpoints --json",
      "scout call GET /users --json",
      "scout coverage --json",
      "scout report --json",
    ],
    notes: [
      "1. init  2. sweep (baseline)  3. explore with endpoints/schema/call  4. record findings  5. coverage  6. report.",
      "Always finish with `scout report` so results are captured.",
    ],
  },
  {
    name: "init",
    summary: "Generate scout.json and cache the dereferenced spec.",
    commands: [
      "scout init https://api.example.com/openapi.json --base-url https://api.example.com",
      "scout init openapi.yaml --base-url https://api.example.com --header 'Authorization: Bearer $API_TOKEN'",
      "scout init --discover --base-url https://api.example.com",
      "scout init --allow-mutations",
    ],
    notes: [
      "scout.json is committable — headers must use $VAR references, never literal secrets.",
      "Mutations (POST/PUT/PATCH/DELETE) are blocked unless --allow-mutations is set.",
    ],
  },
  {
    name: "call",
    summary: "Execute one instrumented request; every response carries a verdict.",
    commands: [
      "scout call GET /users --json",
      "scout call GET /users/{id} --path-param id=123 --json",
      "scout call GET /users --query limit=10 --expect 200 --json",
      'echo \'{"name":"Ada"}\' | scout call POST /users --data-stdin --json',
      "scout call GET /admin --no-auth --json",
    ],
    notes: [
      "--no-auth drops secret-like headers to probe auth boundaries.",
      "Verdict includes schema validation, expected statuses, content-type, and latency.",
    ],
  },
  {
    name: "sweep",
    summary: "Deterministic no-LLM baseline pass over the API surface.",
    commands: [
      "scout sweep --json",
      "scout sweep --tag users --json",
      "scout sweep --max-requests 50 --no-auth-probes --json",
    ],
    notes: [
      "Probes parameter-free GETs, missing-credential boundaries, and synthetic-ID 404 shape.",
      "Auto-records findings in the same model agents use.",
    ],
  },
  {
    name: "coverage",
    summary: "See which operations are exercised vs untouched.",
    commands: ["scout coverage --json", "scout coverage --tag billing --json"],
    notes: ["Operation-level: GET /users/123 marks GET /users/{id} exercised."],
  },
  {
    name: "findings",
    summary: "Record and list findings.",
    commands: [
      'scout finding add --severity high --category contract-violation --endpoint "GET /users" --title "Missing pagination" --json',
      "scout finding list --json",
    ],
    notes: [
      "Severities: critical, high, medium, low, info.",
      "Categories: contract-violation, auth, error-handling, data-integrity, performance, spec-quality.",
    ],
  },
  {
    name: "report",
    summary: "Compile findings + coverage into markdown/JSON with CI exit codes.",
    commands: [
      "scout report --json",
      "scout report --md report.md --json report.json",
      "scout report --ci --severity-threshold high",
    ],
    notes: ["--ci exits non-zero when findings at/above the threshold exist (default: high)."],
  },
  {
    name: "auth",
    summary: "Optional TesterArmy key — only needed for report --upload.",
    commands: ["scout status --json", "scout auth", "scout auth signout"],
    notes: ["Shares credentials with the `ta` CLI (~/.config/testerarmy/config.json)."],
  },
  {
    name: "ci",
    summary: "Run scout as a CI gate.",
    commands: [
      "scout init --config scout.json",
      "scout sweep --json",
      "scout report --ci --md report.md",
    ],
    notes: [
      "Commit scout.json; provide secrets via the workflow env block referenced by $VAR headers.",
      "Partition huge APIs with a matrix over --tag values.",
    ],
  },
  {
    name: "agent",
    summary: "Install the public scout skill and write AGENTS.md discovery hints.",
    commands: ["scout agent init", "scout agent init --json"],
    notes: ["Run once per repo so coding agents discover the scout workflow."],
  },
];

/** Prints agent-facing docs, a single topic, or a topic index. */
export async function runDocsCommand(
  topic: string | undefined,
  options: DocsOptions,
): Promise<void> {
  if (!topic) {
    if (options.json || !isInteractive()) {
      console.log(
        JSON.stringify(
          {
            topics: DOCS_TOPICS.map((entry) => ({ name: entry.name, summary: entry.summary })),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("Scout docs topics:\n");
    for (const entry of DOCS_TOPICS) {
      console.log(`  ${entry.name.padEnd(10)} ${entry.summary}`);
    }
    console.log("\nRun `scout docs <topic>` for commands and notes.");
    return;
  }

  const match = DOCS_TOPICS.find((entry) => entry.name === topic.trim().toLowerCase());
  if (!match) {
    throw new ScoutError(`Unknown docs topic: ${topic}`, {
      code: "VALIDATION_ERROR",
      hint: `Run \`scout docs --json\` to list topics. Available: ${DOCS_TOPICS.map((t) => t.name).join(", ")}.`,
    });
  }

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(match, null, 2));
    return;
  }

  console.log(`# ${match.name}\n`);
  console.log(`${match.summary}\n`);
  console.log("Commands:");
  for (const command of match.commands) {
    console.log(`  ${command}`);
  }
  console.log("\nNotes:");
  for (const note of match.notes) {
    console.log(`  - ${note}`);
  }
}
