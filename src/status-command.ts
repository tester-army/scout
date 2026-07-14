import { captureCliCommandEvent } from "./cli-analytics.js";
import { getConfigFilePath, loadCliConfig } from "./config-store.js";
import { printLine } from "./output.js";
import { isInteractive } from "./utils.js";

type ApiKeySource = "environment" | "config" | "none";

export interface StatusCommandOptions {
  json?: boolean;
}

interface StatusResult {
  authenticated: boolean;
  apiKeySource: ApiKeySource;
  environmentApiKeySet: boolean;
  configApiKeySet: boolean;
  configPath: string;
}

/** Resolves active API key using the same precedence as runtime commands. */
function resolveActiveApiKey(options: { envApiKey?: string; configApiKey?: string }): ApiKeySource {
  if (options.envApiKey?.trim()) {
    return "environment";
  }

  if (options.configApiKey?.trim()) {
    return "config";
  }

  return "none";
}

/**
 * Runs `scout status` command flow. No network calls. Session details
 * (spec info, budget, findings count) land here once session-store exists.
 */
export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<void> {
  const configPath = getConfigFilePath();
  const existingConfig = await loadCliConfig();
  const envApiKey = process.env.TESTERARMY_API_KEY;
  const configApiKey = existingConfig.apiKey;

  const apiKeySource = resolveActiveApiKey({
    envApiKey,
    configApiKey,
  });

  const result: StatusResult = {
    authenticated: apiKeySource !== "none",
    apiKeySource,
    environmentApiKeySet: Boolean(envApiKey?.trim()),
    configApiKeySet: Boolean(configApiKey?.trim()),
    configPath,
  };

  const captureStatusTelemetry = () =>
    captureCliCommandEvent({
      command: "status",
      properties: {
        authenticated: result.authenticated,
        api_key_source: result.apiKeySource,
        output_format: options.json || !isInteractive() ? "json" : "human",
      },
    });

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(result, null, 2));
    await captureStatusTelemetry();
    return;
  }

  printLine(`Authenticated: ${result.authenticated ? "yes" : "no"}`);
  printLine(`API key source: ${result.apiKeySource}`);
  printLine(`TESTERARMY_API_KEY: ${result.environmentApiKeySet ? "set" : "not set"}`);
  printLine(`Stored config API key: ${result.configApiKeySet ? "set" : "not set"}`);
  printLine(`Config file: ${result.configPath}`);

  if (!result.authenticated) {
    printLine(
      "TesterArmy auth is only needed for `scout report --upload`. Run `scout auth` to link.",
    );
  }

  await captureStatusTelemetry();
}
