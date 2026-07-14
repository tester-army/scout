# @testerarmy/scout

> Send a scout ahead of the army.

Scout is a safe API exploration harness for coding agents (Claude Code, Codex, OpenCode, Cursor). It parses your OpenAPI spec once, serves context-window-friendly slices of it, executes instrumented HTTP requests with guardrails and mechanical verdicts (schema validation, status expectations, latency), and compiles structured findings into CI-ready reports.

Scout has **no LLM** and makes no inference calls. Your agent brings the brain; scout is the harness.

## Quickstart

```sh
npx @testerarmy/scout status
```

## Status

Early scaffold. Command surface landing incrementally:

- [x] `scout status` — session + TesterArmy auth state
- [x] `scout auth` / `scout auth signout` — optional TesterArmy key (only for `report --upload`)
- [ ] `scout init <spec>` — generate `scout.json`, cache spec
- [ ] `scout endpoints` / `scout schema` — context-friendly spec slices
- [ ] `scout call` — instrumented requests with verdicts
- [ ] `scout sweep` — deterministic no-LLM baseline pass
- [ ] `scout finding add` / `scout finding list`
- [ ] `scout coverage` — operations exercised vs total
- [ ] `scout report` — markdown/JSON report, CI exit codes
- [ ] `scout agent init` / `scout docs`

## Development

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## License

MIT
