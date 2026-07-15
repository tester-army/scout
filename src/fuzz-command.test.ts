import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFindings } from "./findings.js";
import { runFuzzCommand } from "./fuzz-command.js";
import { runInitCommand } from "./init-command.js";
import { readRequestRecords } from "./session-store.js";

const fixture = fileURLToPath(new URL("./__fixtures__/petstore-min.json", import.meta.url));

describe("fuzz command", () => {
  let cwd: string;
  let originalCwd: string;
  let logs: string[];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "scout-fuzz-"));
    originalCwd = process.cwd();
    process.chdir(cwd);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => logs.push(String(value)));
    await runInitCommand(fixture, {
      baseUrl: "https://api.example.com",
      allowMutations: true,
      json: true,
    });
    logs.length = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("previews generated cases without sending requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runFuzzCommand("POST", "/pets", { dryRun: true, maxCases: 8, json: true });

    const output = JSON.parse(logs.at(-1) as string);
    expect(output.operation).toBe("POST /pets");
    expect(output.baseline).toBe("generated");
    expect(output.generatedBaseline).toEqual({ id: 0, name: "s" });
    expect(output.casesPlanned).toBe(8);
    expect(
      output.cases.some((fuzzCase: { kind: string }) => fuzzCase.kind === "malformed-json"),
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid supplied baseline before requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runFuzzCommand("POST", "/pets", { data: "{}", dryRun: true, json: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects one stable dry-run case for reproduction", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await runFuzzCommand("POST", "/pets", { dryRun: true, maxCases: 8, json: true });
    const first = JSON.parse(logs.at(-1) as string).cases[0] as { id: string };
    logs.length = 0;

    await runFuzzCommand("POST", "/pets", { dryRun: true, case: first.id, json: true });

    const output = JSON.parse(logs.at(-1) as string);
    expect(output.casesPlanned).toBe(1);
    expect(output.cases).toMatchObject([{ id: first.id }]);
  });

  it("executes malformed and schema-invalid cases and records candidates", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.body === '{"__scout_malformed":') {
        return new Response(JSON.stringify({ error: "invalid json" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: 1, name: "created" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runFuzzCommand("POST", "/pets", { maxCases: 2, json: true });

    const output = JSON.parse(logs.at(-1) as string);
    expect(output.casesRun).toBe(2);
    expect(
      output.findings.some((finding: { title: string }) => /invalid-input/.test(finding.title)),
    ).toBe(true);
    expect(readFindings(cwd).some((finding) => finding.source === "fuzz")).toBe(true);
    expect(readRequestRecords(cwd).map((record) => record.source)).toEqual(["fuzz", "fuzz"]);
  });

  it("stops immediately on rate limiting without recording a contract finding", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runFuzzCommand("POST", "/pets", { maxCases: 5, json: true });

    const output = JSON.parse(logs.at(-1) as string);
    expect(output.casesRun).toBe(1);
    expect(output.stoppedReason).toBe("rate-limited");
    expect(output.findings).toEqual([]);
  });

  it("returns a zero-run summary when the session budget is exhausted", async () => {
    const configPath = join(cwd, "scout.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.policy.budget = 1;
    writeFileSync(configPath, JSON.stringify(config));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runFuzzCommand("POST", "/pets", { maxCases: 1, json: true });
    logs.length = 0;
    fetchMock.mockClear();
    await runFuzzCommand("POST", "/pets", { maxCases: 5, json: true });

    const output = JSON.parse(logs.at(-1) as string);
    expect(output.casesRun).toBe(0);
    expect(output.stoppedReason).toBe("budget-limited");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
