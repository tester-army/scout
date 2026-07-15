<div align="center">

# scout

**A guarded API testing harness for coding agents.**

[![npm](https://img.shields.io/npm/v/@testerarmy/scout?color=cb3837&logo=npm)](https://www.npmjs.com/package/@testerarmy/scout)
[![CI](https://github.com/tester-army/scout/actions/workflows/ci.yml/badge.svg)](https://github.com/tester-army/scout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

Scout gives agents small OpenAPI views, guarded HTTP execution, deterministic negative probes, structured findings, and honest coverage/reporting. It contains no LLM and sends no telemetry.

## Quick Start

```sh
npx @testerarmy/scout init https://api.example.com/openapi.json
npx @testerarmy/scout sweep --dry-run --json
npx @testerarmy/scout sweep --max-requests 25 --json
npx @testerarmy/scout report --ci --min-coverage 10
```

The base URL defaults to `servers[0].url`. Target credentials stay in environment variables:

```sh
npx @testerarmy/scout init openapi.json \
  --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'
```

## Agent Workflow

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

## Request Chaining

```sh
scout call POST /users --data '{"name":"Ada"}' --capture userId=user.id --json
scout call GET /users/{id} --path-param 'id={{userId}}' --json
scout vars --json
```

`--extract <path>` prints one response value for shell usage. Captured variables are private to the current run.

## Target Identities

Define named target identities in `scout.json`; values may reference environment variables:

```json
{
  "spec": "openapi.json",
  "baseUrl": "https://api.example.com",
  "authProfiles": {
    "admin": {
      "headers": { "Authorization": "Bearer $ADMIN_TOKEN" }
    },
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

Select one with `--auth-profile admin` on `call`, `sweep`, or `fuzz`.

## Findings And CI

Fuzz findings may begin as candidates. Validate them before gating:

```sh
scout finding list --json
scout finding confirm <id> --json
scout finding dismiss <id> --json
scout report --ci --min-coverage 20 --require-probes
```

`report --ci` defaults to 100% operation coverage and fails on confirmed findings at the configured severity, incomplete sweeps, unmet coverage, or missing required probes. Override with `--min-coverage` when a narrower configured scope is intentional. Candidate and dismissed findings do not gate.

## Safety Model

- Requests are restricted to the configured base URL host.
- Undocumented method/path pairs are rejected unless `--allow-undocumented` is explicit.
- Mutations are blocked unless `policy.allowMutations` is enabled.
- Optional method and OpenAPI path scopes constrain every request.
- Every target request shares the configured rate limit and atomic run budget.
- Redirects are not followed by target calls; spec redirects cannot cross hosts.
- Remote external `$ref`s are disabled; spec downloads are time and size limited.
- Response downloads are capped at 1 MiB and surfaced as bounded previews.
- Credential values are redacted while cookie names and security attributes remain inspectable.

Guardrails do not grant authorization. Confirm the environment, host, operations, methods, identities, data, rate, budget, and test window before traffic.

## Commands

| Command                        | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `scout init [spec]`            | Validate/cache OpenAPI and start an isolated run       |
| `scout status`                 | Show local project, policy, and run state              |
| `scout reset`                  | Start a clean run with the current config/spec         |
| `scout endpoints`              | Search a compact endpoint index                        |
| `scout schema <method> <path>` | Show one operation's schema                            |
| `scout call <method> <path>`   | Execute one documented request and return a verdict    |
| `scout vars`                   | List or clear captured run variables                   |
| `scout sweep`                  | Plan or execute a deterministic read-oriented baseline |
| `scout fuzz <method> <path>`   | Plan or execute request-body negative cases            |
| `scout coverage`               | Show operation-level exercised/validated coverage      |
| `scout finding`                | Add, list, confirm, or dismiss findings                |
| `scout report`                 | Produce summary-first JSON/Markdown and CI gates       |
| `scout agent init`             | Install the bundled skill and AGENTS.md hints          |

Run `scout <command> --help` for flags. Machine-readable commands support `--json`; non-interactive output defaults to JSON.

## Install Agent Guidance

```sh
scout agent init
```

This copies the version-matched skill bundled in the npm package to `.agents/skills/scout/SKILL.md`; it does not execute remote installers.

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
