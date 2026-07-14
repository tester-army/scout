import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = fileURLToPath(new URL("./__fixtures__/petstore-min.json", import.meta.url));

let dir: string;
let originalCwd: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "scout-endpoints-"));
  originalCwd = process.cwd();
  process.chdir(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runInitCommand } = await import("./init-command.js");
  await runInitCommand(fixture, { baseUrl: "https://api.example.com", json: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((v: unknown) => {
    logs.push(String(v));
  });
});

async function runEndpoints(options: Record<string, unknown>) {
  const { runEndpointsCommand } = await import("./endpoints-command.js");
  await runEndpointsCommand(options);
  vi.restoreAllMocks();
  return JSON.parse(logs.at(-1) as string);
}

describe("endpoints command", () => {
  it("lists all operations compactly when under the cap", async () => {
    const out = await runEndpoints({ json: true });
    expect(out.total).toBe(4);
    expect(out.shown).toBe(4);
    expect(out.truncated).toBe(false);
    // Compact rows omit empty fields.
    const getPet = out.operations.find((o: { path: string }) => o.path === "/pets/{petId}");
    expect(getPet.method).toBe("GET");
    expect(getPet).not.toHaveProperty("deprecated");
  });

  it("caps output and surfaces a tag overview + hint when truncated", async () => {
    const out = await runEndpoints({ json: true, limit: 2 });
    expect(out.total).toBe(4);
    expect(out.shown).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.tags).toBeDefined();
    expect(out.hint).toContain("--tag");
  });

  it("does not include a tag overview once narrowed by tag", async () => {
    const out = await runEndpoints({ json: true, limit: 1, tag: "pets" });
    expect(out.truncated).toBe(true);
    expect(out.tags).toBeUndefined();
  });

  it("shows everything with --all", async () => {
    const out = await runEndpoints({ json: true, limit: 1, all: true });
    expect(out.shown).toBe(4);
    expect(out.truncated).toBe(false);
  });
});
