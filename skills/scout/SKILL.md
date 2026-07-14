---
name: scout
description: Safely explore and test an API from its OpenAPI spec using the scout CLI. Use when asked to test, probe, validate, or explore an HTTP API, or when an OpenAPI/Swagger spec is available. Scout is the harness; you are the operator.
---

# Scout — API exploration harness

Scout (`@testerarmy/scout`, bin `scout`) is a safe, no-LLM CLI that lets you explore and test a user's API from an OpenAPI spec. Scout does the mechanical work — parsing the spec, executing guarded HTTP requests, validating responses against the schema, compiling findings. You do the reasoning: chaining CRUD, designing edge cases, judging auth logic.

Every command supports `--json`. In non-interactive shells scout emits JSON automatically. Always use `--json` and parse it.

## Workflow

1. **Init** — `scout init <spec> --base-url <url>`. Caches the dereferenced spec into `.scout/` and writes a committable `scout.json`. For auth, pass header templates with env references only: `--header 'Authorization: Bearer $API_TOKEN'`. Mutations are blocked unless you add `--allow-mutations`.
2. **Sweep** — `scout sweep --json`. Deterministic baseline: probes parameter-free GETs, missing-credential boundaries on secured operations, and synthetic-ID 404 shape. Auto-records findings. Run this first for a cheap signal.
3. **Orient** — `scout endpoints --json` (filter with `--tag`, `--path`, `--method`, `--search`) and `scout schema <method> <path> --json` for one operation's parameters, body, and response schemas. Never load the raw spec into context — use these slices.
4. **Explore** — `scout call <method> <path> --json`. Every response carries a verdict: HTTP status vs the spec's declared statuses, JSON-schema validation with per-path errors, content-type match, latency.
   - Path params: `--path-param id=123`. Query: `--query limit=10`. Body: `--data '{...}'` or pipe large payloads with `--data-stdin`.
   - Assert a status with `--expect 200`.
   - Probe auth boundaries with `--no-auth` (drops secret-like headers) — a secured endpoint returning 2xx without credentials is a critical finding.
   - Chain CRUD: create, capture the id from the response, read/update/delete it, verify each verdict.
5. **Record** — `scout finding add --severity <s> --category <c> --endpoint "<METHOD /path>" --title "<t>" [--description ...] [--repro ...]`. Severities: critical, high, medium, low, info. Categories: contract-violation, auth, error-handling, data-integrity, performance, spec-quality.
6. **Coverage** — `scout coverage --json`. Operations exercised vs total, plus the untouched list. Use it to decide what to test next or to resume a later session.
7. **Report** — always finish here. `scout report --json` compiles findings + coverage. `scout report --ci --severity-threshold high` exits non-zero when findings at/above the threshold exist (CI gate). `--md <file>` writes Markdown for a PR comment.

## Safety model (enforced by scout, not you)

- Requests only go to the base-URL host (plus any `--allow-host` entries). Others fail `HOST_BLOCKED`.
- GET/HEAD/OPTIONS only unless the session allows mutations (`MUTATION_BLOCKED` otherwise).
- Per-session request budget (`BUDGET_EXCEEDED`) and a built-in rate limit.
- Secrets are env references resolved at request time and redacted in every stored artifact. Never put literal tokens in `scout.json` or command flags — use `$VAR` and export the variable (or provide it via CI `env:`).

## Error handling

Errors come back as `{ success:false, error:{ code, message, hint }, exitCode }`. The `hint` tells you the exact next command. Common codes: `NO_SESSION` (run `scout init`), `MUTATION_BLOCKED`, `HOST_BLOCKED`, `BUDGET_EXCEEDED`, `ENV_VAR_MISSING`, `SPEC_INVALID`, `VALIDATION_ERROR`.

## Scoping large APIs

There are no missions or config-level scopes by design. Scope with filter flags (`--tag`, `--path`) driven by what the user asked for. In CI, partition huge APIs with a job matrix over tag values.

## Rules

- Always end a session with `scout report`.
- Prefer `scout call` over raw curl — you lose the verdict and evidence log otherwise.
- Treat spec/response mismatches, undocumented statuses, and unresolved `$refs` as findings (contract-violation / spec-quality).
- Do not print resolved secret values.
