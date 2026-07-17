<p align="center">
  <img src="https://github.com/user-attachments/assets/e6fd88c4-8172-4a1c-9dab-ca8e3236d9fe" alt="scout" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@testerarmy/scout"><img src="https://img.shields.io/npm/v/@testerarmy/scout?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@testerarmy/scout"><img src="https://img.shields.io/npm/dm/@testerarmy/scout?logo=npm" alt="npm downloads" /></a>
  <a href="https://github.com/tester-army/scout/actions/workflows/ci.yml"><img src="https://github.com/tester-army/scout/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

Scout is an OpenAPI-driven API testing CLI built for AI agents. It parses your spec, executes instrumented requests, and records structured findings and coverage reports - while limiting requests to a configured host, blocking writes by default, and redacting credentials. It allows your agent to test your API before you deploy it.

## Use Scout with an agent

Install the bundled skill in your project:

```sh
npx @testerarmy/scout@latest agent init
```

Then give your agent the following prompt, replacing the spec and authentication details:

```text
Test my API for bugs with Scout. Exercise it through realistic user flows,
not by reviewing endpoints in isolation.

- Spec: <SPEC_URL_OR_FILE>
- Auth: Authorization: Bearer $API_TOKEN (omit for a public API)

1. Initialize Scout. The base URL comes from the spec:
   npx @testerarmy/scout@latest init <SPEC> --header "Authorization: Bearer $API_TOKEN"
2. Ask before testing POST, PUT, PATCH, or DELETE. Only enable mutations after
   I approve them. Use clearly fake data and remove it when finished.
3. Run a baseline sweep, then test complete user flows. Check the API contract,
   error handling, authentication, tenant isolation, and undocumented behavior.
4. Investigate anomalies with `scout call` and `scout fuzz`.
5. Record verified bugs with `scout finding add`, then run `scout report`.

Only test the API above, which I authorize. Verify that all test data is removed.
```

`agent init` copies the version-matched [Scout skill](./skills/scout/SKILL.md) to `.agents/skills/scout/` and adds a discovery note to `AGENTS.md`. It does not run a remote installer. You can also install the skill with `npx skills add tester-army/scout`.

## Quick start

Scout reads the target base URL from `servers[0].url` in the OpenAPI spec:

```sh
npx @testerarmy/scout init https://api.example.com/openapi.json
npx @testerarmy/scout sweep --dry-run
npx @testerarmy/scout sweep --max-requests 25
npx @testerarmy/scout report --ci --min-coverage 10
```

Use `--base-url` to override the spec. Keep credentials in environment variables rather than `scout.json`:

```sh
npx @testerarmy/scout init openapi.json \
  --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'
```

Without an OpenAPI spec, initialize Scout with a base URL:

```sh
npx @testerarmy/scout init --base-url https://api.example.com \
  --header 'Authorization: Bearer $API_TOKEN'

npx @testerarmy/scout call GET /v1/users --json
```

Spec-less mode keeps the host lock, mutation gate, rate limit, request budget, secret redaction, and 5xx/latency checks. Endpoint discovery, schema validation, and coverage require a spec. Use `--discover` to check well-known spec paths.

## Workflow

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

Use `scout reset` to start a new run while keeping `scout.json` and the cached spec. Running `init` again also starts a new run.

### Request chaining

Capture a value from one response and use it in later requests:

```sh
scout call POST /users --data '{"name":"Ada"}' --capture userId=user.id --json
scout call GET /users/{id} --path-param 'id={{userId}}' --json
scout vars --json
```

`--extract <path>` prints a single value for shell use, for example `ID=$(scout call ... --extract user.id)`. Captured variables only exist for the current run.

### Testing writes

`POST`, `PUT`, `PATCH`, and `DELETE` are blocked by default. Enable them only when you are authorized to change the target API:

```sh
scout init openapi.json --allow-mutations \
  --header 'Authorization: Bearer $API_TOKEN'

scout call POST /users --data '{"name":"scout-test-ada"}' --capture uid=id --json
scout call GET /users/{id} --path-param 'id={{uid}}' --expect 200 --json
scout call DELETE /users/{id} --path-param 'id={{uid}}' --expect 204 --json
scout call GET /users/{id} --path-param 'id={{uid}}' --expect 404 --json
```

Create only clearly named test data. Track every created resource, delete it in reverse dependency order, and verify removal. Restrict mutation tests further with `allowedMethods`, `allowedPaths`, and a low request budget.

### Multiple identities

Define authentication profiles in `scout.json` when testing roles or tenant isolation:

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

Pass `--auth-profile admin` to `call`, `sweep`, or `fuzz`.

## Configuration

| Policy           | Default | Description                                                       |
| ---------------- | ------- | ----------------------------------------------------------------- |
| `rateLimit`      | `5`     | Maximum requests per second, shared by all commands in a run      |
| `budget`         | `300`   | Maximum requests in a run; reset by `scout reset` or `scout init` |
| `allowMutations` | `false` | Allows `POST`, `PUT`, `PATCH`, and `DELETE`                       |
| `allowedMethods` | unset   | Restricts requests to selected HTTP methods                       |
| `allowedPaths`   | unset   | Restricts requests to selected path globs                         |

Run `scout status` to inspect the active policy and remaining request budget.

## Findings and CI

Fuzzing can produce candidate findings. Confirm or dismiss each candidate before using it as a CI gate:

```sh
scout finding list --json
scout finding confirm <id> --json
scout finding dismiss <id> --json
scout report --ci --min-coverage 20 --require-probes
```

`report --ci` fails for confirmed findings at the configured severity, incomplete sweeps, insufficient coverage, or missing required probes. Its default operation coverage threshold is 100%; use `--min-coverage` when you intentionally test a narrower scope. Candidate and dismissed findings do not fail CI.

`--expect <status>` affects the request verdict but not the process exit code. Add `--fail-on-verdict` to exit with code `1` when the verdict fails:

```sh
scout call GET /users/{id} \
  --path-param id=42 \
  --expect 200 \
  --fail-on-verdict \
  --json
```

Exit code `2` is reserved for usage and tool errors.

## Guardrails

- Requests are limited to the configured base URL host.
- Undocumented operations require `--allow-undocumented`, except in spec-less mode.
- Mutations require explicit opt-in.
- Method and path scopes can restrict every request.
- Rate limits and request budgets apply across the whole run.
- Target requests do not follow redirects; spec redirects cannot change hosts.
- Remote external `$ref` values are disabled.
- Spec downloads default to a 25 MiB limit and cannot exceed 100 MiB.
- Response downloads are capped at 1 MiB and returned as bounded previews.
- Credentials are resolved from environment variables at request time and redacted from output.

These guardrails do not replace authorization. Confirm the environment, host, methods, identities, test data, rate, budget, and testing window before sending traffic.

## Commands

| Command                        | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `scout init [spec]`            | Cache an OpenAPI spec and start a run, or use `--base-url` for spec-less mode |
| `scout status`                 | Show the project, policy, and run state                                       |
| `scout reset`                  | Start a run with the current configuration and spec                           |
| `scout endpoints`              | Search the endpoint index                                                     |
| `scout schema <method> <path>` | Show one operation's schema                                                   |
| `scout call <method> <path>`   | Send one request and return its response and verdict                          |
| `scout vars`                   | List or clear captured variables                                              |
| `scout sweep`                  | Plan or run a read-oriented baseline                                          |
| `scout fuzz <method> <path>`   | Plan or run request-body negative cases                                       |
| `scout coverage`               | Show operation coverage                                                       |
| `scout finding`                | Add, list, confirm, or dismiss findings                                       |
| `scout report`                 | Create JSON or Markdown reports and CI gates                                  |
| `scout agent init`             | Install the bundled agent skill                                               |

Run `scout <command> --help` for all options. Commands support `--json`; non-interactive output uses JSON by default.

## Development

Requires Node.js 22.12.0 or newer and pnpm.

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## License

[MIT](./LICENSE) (c) TesterArmy, Inc.
