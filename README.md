# @testerarmy/scout

> Send a scout ahead of the army.

Scout is a safe API exploration harness for coding agents (Claude Code, Codex, OpenCode, Cursor). It parses your OpenAPI spec once, serves context-window-friendly slices of it, executes instrumented HTTP requests with guardrails and mechanical verdicts (schema validation, status expectations, latency), and compiles structured findings into CI-ready reports.

Scout has **no LLM** and makes no inference calls. Your agent brings the brain; scout is the harness.

## Quickstart

```sh
# Point scout at a spec and the API under test
npx @testerarmy/scout init https://api.example.com/openapi.json --base-url https://api.example.com

# Deterministic baseline pass (no LLM) — records findings
npx @testerarmy/scout sweep --json

# Explore
npx @testerarmy/scout endpoints --tag users --json
npx @testerarmy/scout call GET /users --query limit=10 --json

# Compile a report (CI gate)
npx @testerarmy/scout report --ci --md report.md
```

Teach your coding agent the workflow:

```sh
npx @testerarmy/scout agent init
```

## Command surface

Every command supports `--json`. Non-TTY output is JSON automatically.

| Command                        | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `scout init [<spec>]`          | Generate `scout.json`, fetch/convert/dereference/cache the spec         |
| `scout status`                 | Session summary + TesterArmy auth state (no network)                    |
| `scout endpoints`              | Compact endpoint index (`--tag`/`--path`/`--method`/`--search`)         |
| `scout schema <method> <path>` | Parameters, request body, response schemas for one operation            |
| `scout call <method> <path>`   | Execute an instrumented request; returns response + verdict             |
| `scout sweep`                  | Deterministic no-LLM pre-pass; auto-records findings                    |
| `scout coverage`               | Operations exercised vs total; untouched list                           |
| `scout finding add` / `list`   | Record and list findings                                                |
| `scout report`                 | Compile findings + coverage; `--ci` exit codes; `--upload` (TesterArmy) |
| `scout agent init`             | Install the scout skill + AGENTS.md hints                               |
| `scout docs [topic]`           | Embedded agent-facing docs                                              |

## Safety

Guardrails live in the tool, not the agent:

- Requests only reach the base-URL host (plus `--allow-host` entries).
- GET/HEAD/OPTIONS only unless the session was created with `--allow-mutations`.
- Per-session request budget + built-in rate limit.
- Secrets are **env references** (`Authorization: Bearer $API_TOKEN`) resolved at request time and redacted in every stored artifact. `scout.json` is safe to commit.

## GitHub Actions

Commit `scout.json`, provide secrets via the workflow `env:` block referenced by your `$VAR` headers:

```yaml
- run: npx @testerarmy/scout init # hydrate from committed scout.json
- run: npx @testerarmy/scout sweep --json
- run: npx @testerarmy/scout report --ci --md report.md
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }} # referenced by scout.json headers
```

Partition huge APIs with a job matrix over `--tag` values.

## Development

```sh
pnpm install
pnpm test        # unit + live-server E2E
pnpm lint
pnpm typecheck
pnpm build
```

## License

MIT
