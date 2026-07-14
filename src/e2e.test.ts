import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const spec = {
  openapi: "3.0.3",
  info: { title: "Broken Local API", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        tags: ["items"],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
    },
    "/secure": {
      get: {
        operationId: "getSecure",
        tags: ["secure"],
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },
    "/boom": {
      get: {
        operationId: "getBoom",
        tags: ["boom"],
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: {} } } },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
};

let server: Server;
let baseUrl: string;
let dir: string;
let originalCwd: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/items") {
      res.statusCode = 200;
      res.end(JSON.stringify({ notAnArray: true }));
      return;
    }
    if (req.url === "/secure") {
      res.statusCode = 200; // returns 200 even without auth — the bug
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/boom") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "kaboom" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  dir = mkdtempSync(join(tmpdir(), "scout-e2e-"));
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(spec));
  originalCwd = process.cwd();
  process.chdir(dir);
});

afterAll(async () => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("end-to-end sweep against a known-bad API", () => {
  it("init → sweep → report surfaces the planted bugs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    const { runInitCommand } = await import("./init-command.js");
    const { runSweepCommand } = await import("./sweep-command.js");
    const { runReportCommand } = await import("./report-command.js");

    await runInitCommand("openapi.json", { baseUrl, json: true });
    const initResult = JSON.parse(logs.at(-1) as string);
    expect(initResult.operations).toBe(3);

    logs.length = 0;
    await runSweepCommand({ json: true });
    const sweep = JSON.parse(logs.at(-1) as string);

    const titles = sweep.findings.map((f: { title: string }) => f.title).join(" | ");
    expect(sweep.findingsCreated).toBeGreaterThanOrEqual(3);
    expect(titles).toMatch(/schema/i); // /items returns wrong shape
    expect(titles).toMatch(/without credentials/i); // /secure 2xx without auth
    expect(titles).toMatch(/500/); // /boom

    const authCandidate = sweep.findings.find(
      (f: { severity: string; category: string }) => f.severity === "high" && f.category === "auth",
    );
    expect(authCandidate).toBeDefined();

    logs.length = 0;
    await runReportCommand({ json: true, severityThreshold: "high" });
    const report = JSON.parse(logs.at(-1) as string);
    expect(report.summary.passed).toBe(false);
    expect(report.coverage.totalOperations).toBe(3);

    vi.restoreAllMocks();
  });
});
