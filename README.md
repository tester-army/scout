<div align="center">

# 🔭 scout

**A safe API testing harness for coding agents.**
Point it at an OpenAPI spec; it explores, validates every response against the schema, and reports what's broken — with guardrails so nothing dangerous slips through.

[![npm](https://img.shields.io/npm/v/@testerarmy/scout?color=cb3837&logo=npm)](https://www.npmjs.com/package/@testerarmy/scout)
[![CI](https://github.com/tester-army/scout/actions/workflows/ci.yml/badge.svg)](https://github.com/tester-army/scout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

_Send a scout ahead of the army._

</div>

---

Coding agents already test APIs with raw `curl` — badly. No schema validation, no safety rails, no structured findings, and a 2 MB spec dumped into the context window. **scout** is the harness that fixes that. It has **no LLM and makes no inference calls**: your agent brings the reasoning, scout does the mechanical work — parsing the spec, executing guarded requests, judging every response, and compiling findings.

It works standalone too: the deterministic `sweep` gives humans and CI an instant baseline with zero configuration.

```console
$ scout call GET /users/42 --expect 200
✔ GET https://api.example.com/users/42
  PASS · expect: matched · status: expected · schema: valid · 48ms

$ scout sweep
Sweep complete: 17 probes run, 2 findings recorded.
  [critical] GET /admin/stats      — Secured endpoint returned 2xx without credentials
  [high]     GET /orders/{orderId} — Malformed path param returns 500 instead of 400/404
```

## Quick start

```sh
# 1. Cache the spec (base URL is read from the spec's servers[] if omitted)
npx @testerarmy/scout init https://api.example.com/openapi.json

# 2. Instant deterministic baseline — no LLM, no config
npx @testerarmy/scout sweep

# 3. Compile a report (non-zero exit gates CI)
npx @testerarmy/scout report --ci
```

That's it. Add auth with an environment reference that stays out of your committed config:

```sh
npx @testerarmy/scout init https://api.example.com/openapi.json \
  --header 'Authorization: Bearer $API_TOKEN'
```

## Why scout

|                               |                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🔎 **Mechanical verdicts**    | Every response is checked against the spec: status vs. documented codes, JSON-schema validation with per-field errors, content-type, latency — distilled to one `PASS`/`FAIL`. |
| 🛡️ **Guardrails in the tool** | Host allowlist, mutations blocked by default, per-session request budget, rate limiting, and automatic secret redaction. Safe to hand to an autonomous agent.                  |
| ⚡ **Zero-config baseline**   | `sweep` probes auth boundaries, malformed input, and 404 shape across your API and records findings — no LLM, deterministic, CI-ready.                                         |
| 🧠 **Context-friendly**       | Serves sliced, filterable views of the spec instead of dumping it. A 1,200-operation API stays browsable in a few thousand tokens.                                             |
| 🤖 **Agent-native**           | Every command speaks `--json`, with actionable error hints. Ships a skill so agents learn the workflow instantly.                                                              |
| 🔒 **Secrets never stored**   | Auth is `$VAR` references resolved at request time and redacted everywhere. `scout.json` is safe to commit.                                                                    |

## How it works

Scout keeps a committable `scout.json` (spec source, base URL, header templates, safety policy) and a gitignored `.scout/` session (cached dereferenced spec, request log, findings). The workflow an agent follows:

```
init ─▶ sweep ─▶ endpoints / schema ─▶ call ─▶ finding add ─▶ coverage ─▶ report
        │                                                                    │
        └── deterministic baseline                          CI gate + markdown┘
```

Every `call` and `sweep` request comes back with a **verdict**:

```jsonc
{
  "ok": false,
  "summary": "FAIL · status: UNEXPECTED · SERVER ERROR · schema: n/a · 512ms",
  "status": 500,
  "expectedStatuses": ["200", "404"],
  "serverError": true,
  "schemaValid": "unknown",
}
```

## Security probing

Scout doubles as a lightweight security harness. These are first-class:

```sh
scout call GET /admin --no-auth          # drop credentials — expect a 401, not a 200
scout call GET /admin --invalid-auth     # bogus token, real scheme — auth must reject it
scout call GET /users/'; DROP TABLE--'   # injection / malformed ids should 4xx, never 500
scout call POST /users --raw-data '{bad' # malformed body should 400, not crash
```

`sweep` runs the auth-boundary and malformed-input probes automatically and flags any secured endpoint that answers without credentials, any 5xx on client input, and any response that drifts from its schema.

## For coding agents

```sh
scout agent init          # installs the scout skill + AGENTS.md hints
scout docs                # browsable, copy-pasteable command docs
scout docs security       # per-topic deep dives
```

Non-interactive shells emit JSON automatically, and every error is a stable envelope with an actionable `hint`:

```jsonc
{
  "success": false,
  "error": {
    "code": "MUTATION_BLOCKED",
    "hint": "Re-run `scout init` with --allow-mutations, or set policy.allowMutations in scout.json.",
  },
}
```

## Continuous integration

Commit `scout.json`; provide secrets via the workflow `env:` block referenced by your `$VAR` headers — no scout-specific secret handling:

```yaml
- run: npx @testerarmy/scout init # hydrate from committed scout.json
- run: npx @testerarmy/scout sweep
- run: npx @testerarmy/scout report --ci --md report.md
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }} # referenced by scout.json headers
```

`report --ci` exits non-zero when findings meet the severity threshold (default `high`). Partition large APIs with a job matrix over `--tag` values.

## Command reference

Every command supports `--json`.

| Command                        | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `scout init [<spec>]`          | Fetch, convert (Swagger 2 → 3), dereference, and cache the spec; write `scout.json` |
| `scout status`                 | Session summary + auth state (no network)                                           |
| `scout endpoints`              | Compact, filterable endpoint index (`--tag` `--path` `--method` `--search` `--all`) |
| `scout schema <method> <path>` | Parameters, request body, and response schemas for one operation (`--full`)         |
| `scout call <method> <path>`   | Execute one instrumented request; return response + verdict                         |
| `scout sweep`                  | Deterministic no-LLM baseline; auto-records findings                                |
| `scout coverage`               | Operations exercised vs. total, with the untouched list                             |
| `scout finding add` / `list`   | Record and review findings                                                          |
| `scout report`                 | Compile findings + coverage to Markdown/JSON; `--ci` exit codes                     |
| `scout agent init`             | Install the scout skill + AGENTS.md discovery hints                                 |
| `scout docs [topic]`           | Embedded, agent-facing docs                                                         |

Run `scout <command> --help` for the full flag set.

## Safety model

- **Host allowlist** — requests only reach the base-URL host (plus explicit `--allow-host` entries).
- **Read-only by default** — `POST/PUT/PATCH/DELETE` are blocked unless the session was created with `--allow-mutations`.
- **Budget + rate limit** — a per-session request cap and a built-in throttle.
- **Secret redaction** — resolved credentials and secret-ish query values are masked in the request log, findings, and repros.

## Development

```sh
pnpm install
pnpm test        # unit + live-server end-to-end
pnpm lint
pnpm typecheck
pnpm build
```

Requires Node ≥ 20. Built with TypeScript, [commander](https://github.com/tj/commander.js), [ajv](https://ajv.js.org), and [@apidevtools/swagger-parser](https://github.com/APIDevTools/swagger-parser).

## License

[MIT](./LICENSE) © Tester Army
