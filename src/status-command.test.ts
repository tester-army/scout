import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isInteractive: vi.fn(),
  loadProjectConfig: vi.fn(),
  loadSessionState: vi.fn(),
  readFindings: vi.fn(),
  resolvePolicy: vi.fn(),
  sessionExists: vi.fn(),
}));

vi.mock("./utils.js", () => ({ isInteractive: mocks.isInteractive }));
vi.mock("./project-config.js", () => ({
  loadProjectConfig: mocks.loadProjectConfig,
  resolvePolicy: mocks.resolvePolicy,
}));
vi.mock("./session-store.js", () => ({
  loadSessionState: mocks.loadSessionState,
  sessionExists: mocks.sessionExists,
}));
vi.mock("./findings.js", () => ({ readFindings: mocks.readFindings }));

const { runStatusCommand } = await import("./status-command.js");

describe("status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isInteractive.mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reports no local run without account state", async () => {
    mocks.sessionExists.mockReturnValue(false);
    await runStatusCommand({ json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string)).toEqual({
      session: { active: false },
    });
  });

  it("reports local run policy and provenance", async () => {
    mocks.sessionExists.mockReturnValue(true);
    mocks.loadSessionState.mockReturnValue({
      runId: "run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      specSource: "openapi.json",
      specHash: "hash",
      requestCount: 3,
    });
    mocks.loadProjectConfig.mockReturnValue({
      config: { spec: "openapi.json", baseUrl: "https://api.test" },
      path: "scout.json",
    });
    mocks.resolvePolicy.mockReturnValue({ allowMutations: false, rateLimit: 2, budget: 20 });
    mocks.readFindings.mockReturnValue([{}]);

    await runStatusCommand({ json: true });

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string)).toMatchObject({
      session: {
        active: true,
        runId: "run-1",
        baseUrl: "https://api.test",
        requestsUsed: 3,
        requestBudget: 20,
        rateLimit: 2,
        findings: 1,
      },
    });
  });
});
