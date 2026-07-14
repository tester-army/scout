import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureCliCommandEvent: vi.fn(),
  getConfigFilePath: vi.fn(),
  isInteractive: vi.fn(),
  loadCliConfig: vi.fn(),
}));

vi.mock("./cli-analytics.js", () => ({
  captureCliCommandEvent: mocks.captureCliCommandEvent,
}));

vi.mock("./config-store.js", () => ({
  getConfigFilePath: mocks.getConfigFilePath,
  loadCliConfig: mocks.loadCliConfig,
}));

vi.mock("./utils.js", () => ({
  isInteractive: mocks.isInteractive,
}));

const { runStatusCommand } = await import("./status-command.js");

describe("status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.captureCliCommandEvent.mockResolvedValue(undefined);
    mocks.getConfigFilePath.mockReturnValue("/home/user/.config/testerarmy/config.json");
    mocks.isInteractive.mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reports unauthenticated state as JSON in non-TTY", async () => {
    vi.stubEnv("TESTERARMY_API_KEY", "");
    mocks.loadCliConfig.mockResolvedValue({});

    await runStatusCommand({});

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string)).toEqual({
      authenticated: false,
      apiKeySource: "none",
      environmentApiKeySet: false,
      configApiKeySet: false,
      configPath: "/home/user/.config/testerarmy/config.json",
    });
  });

  it("prefers environment API key over stored config", async () => {
    vi.stubEnv("TESTERARMY_API_KEY", "ta_env_key");
    mocks.loadCliConfig.mockResolvedValue({ apiKey: "ta_config_key" });

    await runStatusCommand({ json: true });

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string)).toMatchObject({
      authenticated: true,
      apiKeySource: "environment",
      environmentApiKeySet: true,
      configApiKeySet: true,
    });
    expect(mocks.captureCliCommandEvent).toHaveBeenCalledWith({
      command: "status",
      properties: {
        authenticated: true,
        api_key_source: "environment",
        output_format: "json",
      },
    });
  });
});
