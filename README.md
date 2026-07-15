<div align="center">

# scout

**A guarded API testing harness for coding agents.**

[![npm](https://img.shields.io/npm/v/@testerarmy/scout?color=cb3837&logo=npm)](https://www.npmjs.com/package/@testerarmy/scout)
[![CI](https://github.com/tester-army/scout/actions/workflows/ci.yml/badge.svg)](https://github.com/tester-army/scout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

Scout is the layer between a coding agent and a live API. It gives agents small OpenAPI views, guarded HTTP execution, deterministic negative probes, request chaining, structured findings, and honest coverage/reporting. It contains no LLM and sends no telemetry.

## Why not just give your agent `curl`?

An agent with raw `curl` can hit any host, fire destructive requests, leak secrets into logs, and has to eyeball every response by hand. Scout keeps the agent's autonomy but puts guardrails and structure around it.

| With raw `curl`                                   | With scout                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Hits any host the agent types                     | Locked to the configured base URL host                                                                                      |
| Mutations (POST/PUT/PATCH/DELETE) fire freely     | Blocked unless you opt in with `allowMutations`                                                                             |
| No rate limit, no ceiling on volume               | Shared rate limit + atomic per-run request **budget**                                                                       |
| Secrets end up in argv, shell history, and output | `$VAR` references resolved at request time, redacted everywhere                                                             |
| Agent reads a raw dump and guesses if it's OK     | Mechanical **verdict**: status vs. documented codes, JSON-schema validation, content-type, latency                          |
| Full body + headers, or nothing                   | **Full response body and every header** returned, so leaks and undocumented fields are visible — with your secrets stripped |
| Stateless — re-parse IDs with shell glue          | **Capture** response values and reuse them with `{{interpolation}}`                                                         |
| Findings live in the chat and vanish              | Structured findings, coverage, and a CI-gating report                                                                       |

Guardrails are not authorization. You still decide what the agent is allowed to touch.

## Quick start

```sh
npx @testerarmy/scout init https://api.example.com/openapi.json
npx @testerarmy/scout sweep --dry-run
npx @testerarmy/scout sweep --max-requests 25
npx @testerarmy/scout report --ci --min-coverage 10
```

The base URL defaults to `servers[0].url`. Keep target credentials in environment variables — never in `scout.json`:

```sh
npx @testerarmy/scout init openapi.json \
  --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'
```

## No OpenAPI spec? Explore any base URL

No spec is required. Point scout at a base URL and it runs in **spec-less mode** — every request is treated as undocumented, but the host lock, mutation gate, rate limit, budget, secret redaction, and 5xx/latency verdicts all still apply. It's a safer, structured `curl`.

```sh
# no spec argument — just a base URL
npx @testerarmy/scout init --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'

npx @testerarmy/scout call GET /v1/users --json
npx @testerarmy/scout call GET /v1/users/42 --extract email
```

If you later get a spec, re-run `init` with it (or `--discover --base-url <url>` to probe well-known paths) and you gain endpoint/schema views, coverage, and schema-aware verdicts. If you have a spec but need to hit a path outside it, use `scout call ... --allow-undocumented`.

## Give this to your coding agent

Paste this to an agent that has shell access. It installs the CLI, sets up the bundled skill, and explores your API:

```text
Test my API at https://api.example.com. Use scout, a guarded API testing harness for agents.

1. Install the scout skill so you learn the workflow:
     npx @testerarmy/scout@latest agent init
2. Initialize a project (I have no OpenAPI spec, so go spec-less):
     npx @testerarmy/scout@latest init --base-url https://api.example.com \
       --header "Authorization: Bearer $API_TOKEN"
   (If I give you an OpenAPI URL or file, pass it as the first argument instead.)
3. Explore (the installed skill describes the full workflow):
     npx @testerarmy/scout@latest endpoints --json        # if a spec is loaded
     npx @testerarmy/scout@latest call GET /path --json
4. Chain requests with --capture name=path and {{name}}; inspect full responses
   and headers for leaks or undocumented fields.
5. Probe write endpoints with `scout fuzz`, and run `scout sweep` for a baseline.
6. Record issues with `scout finding add`, then produce `scout report`.

Rules: only test what I authorized above. Do NOT enable or send mutations
(POST/PUT/PATCH/DELETE) without asking me first. Clean up any resources you create.
```

`scout agent init` only copies the version-matched skill into `.agents/skills/scout/` and adds a discovery note to `AGENTS.md`. It runs no remote installers.

## Agent workflow

```text
init -> endpoints/schema -> sweep --dry-run -> sweep/call/fuzz -> findings -> coverage/report
```

```sh
scout endpoints --tag users --json
scout schema GET /users/{id} --json
scout call GET /users/{id} --path-param id=42 --expect 200 --json
scout fuzz POST /users --dry-run --json
scout coverage --json
scout report --ci --severity-threshold high
```

Use `scout reset` to start an isolated run while preserving `scout.json` and the cached spec. Explicit `init` also starts a fresh run and clears requests, findings, variables, and budget usage.

## Request chaining

No shell glue needed to thread values between calls:

```sh
scout call POST /users --data '{"name":"Ada"}' --capture userId=user.id --json
scout call GET /users/{id} --path-param 'id={{userId}}' --json
scout vars --json
```

`--extract <path>` prints one response value for shell capture (`ID=$(scout call … --extract user.id)`). Captured variables are private to the current run.

## Target identities

Define named identities in `scout.json`; values may reference environment variables:

```json
{
  "spec": "openapi.json",
  "baseUrl": "https://api.example.com",
  "authProfiles": {
    "admin": { "headers": { "Authorization": "Bearer $ADMIN_TOKEN" } },
    "tenant-b": {
      "query": { "api_key": "$TENANT_B_KEY" },
      "cookies": { "session": "$TENANT_B_SESSION" }
    }
  },
  "policy": {
    "allowMutations": false,
    "allowedMethods": ["GET"],
    "allowedPaths": ["/users/**"],
    "rateLimit": 2,
    "budget": 100
  }
}
```

Select one with `--auth-profile admin` on `call`, `sweep`, or `fuzz`. (`spec` may be omitted for spec-less mode.)

## Findings and CI

Fuzz findings may begin as candidates. Validate them before gating:

```sh
scout finding list --json
scout finding confirm <id> --json
scout finding dismiss <id> --json
scout report --ci --min-coverage 20 --require-probes
```

`report --ci` defaults to 100% operation coverage and fails on confirmed findings at the configured severity, incomplete sweeps, unmet coverage, or missing required probes. Override with `--min-coverage` when a narrower scope is intentional. Candidate and dismissed findings do not gate.

## Safety model

- Requests are restricted to the configured base URL host.
- Undocumented method/path pairs are rejected unless `--allow-undocumented` is set — or the project is spec-less, where every path is treated as undocumented but all other guardrails remain.
- Mutations are blocked unless `policy.allowMutations` is enabled.
- Optional method and path scopes constrain every request.
- Every target request shares the configured rate limit and atomic run budget.
- Redirects are not followed by target calls; spec redirects cannot cross hosts.
- Remote external `$ref`s are disabled; spec downloads are time and size limited.
- Response downloads are capped at 1 MiB and surfaced as bounded previews.
- Credential values are redacted while cookie names and security attributes remain inspectable.

Guardrails do not grant authorization. Confirm the environment, host, operations, methods, identities, data, rate, budget, and test window before sending traffic.

## Commands

| Command                        | Purpose                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `scout init [spec]`            | Cache OpenAPI (or go spec-less with `--base-url`) and start an isolated run |
| `scout status`                 | Show local project, policy, and run state                                   |
| `scout reset`                  | Start a clean run with the current config/spec                              |
| `scout endpoints`              | Search a compact endpoint index                                             |
| `scout schema <method> <path>` | Show one operation's schema                                                 |
| `scout call <method> <path>`   | Execute one request; return full response, headers, and a verdict           |
| `scout vars`                   | List or clear captured run variables                                        |
| `scout sweep`                  | Plan or execute a deterministic read-oriented baseline                      |
| `scout fuzz <method> <path>`   | Plan or execute request-body negative cases                                 |
| `scout coverage`               | Show operation-level exercised/validated coverage                           |
| `scout finding`                | Add, list, confirm, or dismiss findings                                     |
| `scout report`                 | Produce summary-first JSON/Markdown and CI gates                            |
| `scout agent init`             | Install the bundled skill and AGENTS.md hints                               |

Run `scout <command> --help` for flags. Machine-readable commands support `--json`; non-interactive output defaults to JSON automatically.

## Development

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Requires Node >=22.12.0.

## License

[MIT](./LICENSE) (c) Tester Army
