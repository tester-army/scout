import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLiteralSecretHeaders,
  loadProjectConfig,
  resolvePolicy,
  writeProjectConfig,
  type ScoutProjectConfig,
} from "./project-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scout-cfg-"));
  vi.unstubAllEnvs();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const base: ScoutProjectConfig = {
  spec: "openapi.json",
  baseUrl: "https://api.example.com",
  policy: { allowMutations: false },
};

describe("detectLiteralSecretHeaders", () => {
  it("flags secret-like headers without env references", () => {
    expect(detectLiteralSecretHeaders({ Authorization: "Bearer abc123", "X-Trace": "on" })).toEqual(
      ["Authorization"],
    );
  });

  it("allows env references", () => {
    expect(detectLiteralSecretHeaders({ Authorization: "Bearer $TOKEN" })).toEqual([]);
  });
});

describe("write + load round trip", () => {
  it("writes and reloads a valid config", () => {
    const { path } = writeProjectConfig(base, { cwd: dir });
    const loaded = loadProjectConfig({ cwd: dir });
    expect(loaded?.path).toBe(path);
    expect(loaded?.config.baseUrl).toBe("https://api.example.com");
  });

  it("returns null when no config exists", () => {
    expect(loadProjectConfig({ cwd: dir })).toBeNull();
  });

  it("rejects unknown keys", () => {
    writeFileSync(join(dir, "scout.json"), JSON.stringify({ ...base, bogus: true }));
    expect(() => loadProjectConfig({ cwd: dir })).toThrow(/Invalid scout.json/);
  });

  it("rejects literal secrets in CI", () => {
    vi.stubEnv("CI", "1");
    writeFileSync(
      join(dir, "scout.json"),
      JSON.stringify({ ...base, headers: { Authorization: "Bearer literal-token" } }),
    );
    expect(() => loadProjectConfig({ cwd: dir })).toThrow(/literal secrets/);
  });

  it("rejects literal auth profile values in CI", () => {
    vi.stubEnv("CI", "1");
    writeFileSync(
      join(dir, "scout.json"),
      JSON.stringify({
        ...base,
        authProfiles: { admin: { cookies: { session: "literal-token" } } },
      }),
    );
    expect(() => loadProjectConfig({ cwd: dir })).toThrow(/authProfiles\.admin\.cookies\.session/);
  });

  it("accepts environment references in auth profiles", () => {
    writeFileSync(
      join(dir, "scout.json"),
      JSON.stringify({
        ...base,
        authProfiles: {
          admin: {
            headers: { Authorization: "Bearer $ADMIN_TOKEN" },
            query: { api_key: "$ADMIN_KEY" },
            cookies: { session: "$ADMIN_SESSION" },
          },
        },
      }),
    );
    expect(loadProjectConfig({ cwd: dir })?.config.authProfiles?.admin).toBeDefined();
  });
});

describe("resolvePolicy", () => {
  it("applies precedence flags > config > defaults", () => {
    expect(resolvePolicy(base)).toMatchObject({ allowMutations: false, rateLimit: 5 });
    expect(resolvePolicy(base, { allowMutations: true }).allowMutations).toBe(true);
    expect(resolvePolicy({ ...base, policy: { allowMutations: true, budget: 10 } }).budget).toBe(
      10,
    );
  });
});
