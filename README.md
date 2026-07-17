<p align="center">
  <img src="https://github.com/user-attachments/assets/e6fd88c4-8172-4a1c-9dab-ca8e3236d9fe" alt="scout" />
</p>

<p align="center">
  <a href="#quick-start"><strong>Quickstart</strong></a> |
  <a href="#skill"><strong>Skill</strong></a> |
  <a href="#why-not-just-give-your-agent-curl"><strong>Why scout</strong></a> |
  <a href="#agent-workflow"><strong>Workflow</strong></a> |
  <a href="#commands"><strong>Commands</strong></a> |
  <a href="#findings-and-ci"><strong>Findings &amp; CI</strong></a> |
  <a href="#safety-model"><strong>Safety</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@testerarmy/scout"><img src="https://img.shields.io/npm/v/@testerarmy/scout?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@testerarmy/scout"><img src="https://img.shields.io/npm/dm/@testerarmy/scout?logo=npm" alt="npm downloads" /></a>
  <a href="https://github.com/tester-army/scout/actions/workflows/ci.yml"><img src="https://github.com/tester-army/scout/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

Scout is the layer between a coding agent and a live API. It gives agents small OpenAPI views, guarded HTTP execution, deterministic negative probes, request chaining, structured findings, and honest coverage/reporting. It contains no LLM and sends no telemetry.

## Get started - hand this to your agent

Paste this to any coding agent with shell access, fill in the three values, and let it run. Works **with or without** an OpenAPI spec:

```text
Do a deep scan of my API for bugs using scout, a guarded API testing harness.

- Base URL:  <YOUR_BASE_URL>          e.g. https://api.example.com
- Spec:      <YOUR_SPEC_URL_OR_FILE>  or "none"
- Auth:      Authorization: Bearer $API_TOKEN   (token stays in that env var)

1. Install the skill, then init:
     npx @testerarmy/scout@latest agent init
     npx @testerarmy/scout@latest init <SPEC or omit> --base-url <BASE_URL> --header "Authorization: Bearer $API_TOKEN"
2. Follow the scout skill to hunt for bugs: sweep for a baseline, then probe
   every reachable endpoint for contract violations, broken error handling,
   auth/tenant leaks, and undocumented behavior. Chase anomalies deeper with
   `scout call` and `scout fuzz`.
3. Record each real bug with `scout finding add`, then `scout report`.

Rules: only scan the API above, which I authorize. No mutations
(POST/PUT/PATCH/DELETE) unless I say so. Clean up anything you create.
```

`scout agent init` only copies the version-matched skill into `.agents/skills/scout/` and adds a discovery note to `AGENTS.md` - no remote installers. Prefer to drive it yourself? See [Quick start](#quick-start) below.

## Skill

Scout ships an [agent skill](./skills/scout/SKILL.md) that teaches your coding agent the authorization-first workflow: obtain scope, orient with `endpoints`/`schema`, build valid controls, run negative probes and fuzzing, validate findings, and report. Install it either way:

```sh
# bundled, version-matched with the CLI (also writes AGENTS.md discovery hints)
npx @testerarmy/scout@latest agent init

# or from the open agent skills ecosystem
npx skills add tester-army/scout
```

Both drop the skill into `.agents/skills/scout/` so agents discover it automatically. The skill is the harness manual; you stay the operator who grants scope.

## Why not just give your agent `curl`?

An agent with raw `curl` can hit any host, fire destructive requests, leak secrets into logs, and has to eyeball every response by hand. Scout keeps the agent's autonomy but puts guardrails and structure around it.

| With raw `curl`                                   | With scout                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Hits any host the agent types                     | Locked to the configured base URL host                                                                                      |
| Mutations (POST/PUT/PATCH/DELETE) fire freely     | Blocked unless you opt in with `allowMutations`                                                                             |
| No rate limit, no ceiling on volume               | Shared rate limit + atomic per-run request **budget**                                                                       |
| Secrets end up in argv, shell history, and output | `$VAR` references resolved at request time, redacted everywhere                                                             |
| Agent reads a raw dump and guesses if it's OK     | Mechanical **verdict**: status vs. documented codes, JSON-schema validation, content-type, latency                          |
| Full body + headers, or nothing                   | **Full response body and every header** returned, so leaks and undocumented fields are visible - with your secrets stripped |
| Stateless - re-parse IDs with shell glue          | **Capture** response values and reuse them with `{{interpolation}}`                                                         |
| Findings live in the chat and vanish              | Structured findings, coverage, and a CI-gating report                                                                       |

Guardrails are not authorization. You still decide what the agent is allowed to touch.

## Quick start

```sh
npx @testerarmy/scout init https://api.example.com/openapi.json
npx @testerarmy/scout sweep --dry-run
npx @testerarmy/scout sweep --max-requests 25
npx @testerarmy/scout report --ci --min-coverage 10
```

The base URL defaults to `servers[0].url`. Keep target credentials in environment variables - never in `scout.json`:

```sh
npx @testerarmy/scout init openapi.json \
  --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'
```

## No OpenAPI spec? Explore any base URL

No spec is required. Point scout at a base URL and it runs in **spec-less mode** - every request is treated as undocumented, but the host lock, mutation gate, rate limit, budget, secret redaction, and 5xx/latency verdicts all still apply. It's a safer, structured `curl`.

```sh
# no spec argument - just a base URL
npx @testerarmy/scout init --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'

npx @testerarmy/scout call GET /v1/users --json
npx @testerarmy/scout call GET /v1/users/42 --extract email
```

If you later get a spec, re-run `init` with it (or `--discover --base-url <url>` to probe well-known paths) and you gain endpoint/schema views, coverage, and schema-aware verdicts. If you have a spec but need to hit a path outside it, use `scout call ... --allow-undocumented`.

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

### Exit codes and gating

`--expect <status>` only changes the **verdict**; a mismatch does **not** set a non-zero exit code, so a bare `scout call --expect 200` in a shell loop will still exit `0`. To fail on a bad verdict, add `--fail-on-verdict` (exit `1` when the verdict fails), or gate a whole run with `scout report --ci` (exit `1` on confirmed findings, incomplete sweeps, or unmet coverage). Reserve exit `2` for tool/usage errors.

```sh
scout call GET /users/{id} --path-param id=42 --expect 200 --fail-on-verdict --json
scout report --ci --severity-threshold high
```

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

Policy knobs (all optional; shown with their defaults):

| Key                               | Default | Meaning                                                                                                                                               |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rateLimit`                       | `5`     | Max **requests per second** to the target, shared across every command in a run.                                                                      |
| `budget`                          | `300`   | Max **total requests per run** (cumulative across every `call`/`sweep`/`fuzz`, not per command). Resets on `scout reset` or an explicit `scout init`. |
| `allowMutations`                  | `false` | Permit `POST/PUT/PATCH/DELETE`.                                                                                                                       |
| `allowedMethods` / `allowedPaths` | unset   | Restrict every request to these methods / path globs.                                                                                                 |

Because `budget` is per-run and cumulative, a `sweep` after some manual `call`s draws from the same ceiling — check `scout status` to see remaining budget.

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
- Undocumented method/path pairs are rejected unless `--allow-undocumented` is set - or the project is spec-less, where every path is treated as undocumented but all other guardrails remain.
- Mutations are blocked unless `policy.allowMutations` is enabled.
- Optional method and path scopes constrain every request.
- Every target request shares the configured rate limit and atomic run budget.
- Redirects are not followed by target calls; spec redirects cannot cross hosts.
- Remote external `$ref`s are disabled; spec downloads are time and size limited (25 MiB default; raise with `scout init --max-spec-mb <n>`, hard ceiling 100 MiB).
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
