import { captureCliCommandEvent } from "./cli-analytics.js";
import { getConfigFilePath, loadCliConfig } from "./config-store.js";
import { readFindings } from "./findings.js";
import { printLine } from "./output.js";
import { loadProjectConfig, resolvePolicy } from "./project-config.js";
import { loadSessionState, sessionExists } from "./session-store.js";
import { isInteractive } from "./utils.js";

type ApiKeySource = "environment" | "config" | "none";

export interface StatusCommandOptions {
  json?: boolean;
}

interface SessionInfo {
  active: boolean;
  specSource?: string;
  specHash?: string;
  baseUrl?: string;
  requestsUsed?: number;
  requestBudget?: number;
  allowMutations?: boolean;
  findings?: number;
}

interface StatusResult {
  authenticated: boolean;
  apiKeySource: ApiKeySource;
  environmentApiKeySet: boolean;
  configApiKeySet: boolean;
  configPath: string;
  session: SessionInfo;
}

/** Gathers on-disk session details for status output (no network). */
function resolveSessionInfo(): SessionInfo {
  if (!sessionExists()) {
    return { active: false };
  }

  const state = loadSessionState();
  const projectConfig = loadProjectConfig();
  const policy = resolvePolicy(projectConfig?.config);

  return {
    active: true,
    specSource: state.specSource,
    specHash: state.specHash,
    ...(projectConfig ? { baseUrl: projectConfig.config.baseUrl } : {}),
    requestsUsed: state.requestCount,
    requestBudget: policy.budget,
    allowMutations: policy.allowMutations,
    findings: readFindings().length,
  };
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
    session: resolveSessionInfo(),
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

  if (result.session.active) {
    printLine(`Session: active (${result.session.specSource})`);
    printLine(`Base URL: ${result.session.baseUrl ?? "unknown"}`);
    printLine(`Requests used: ${result.session.requestsUsed}/${result.session.requestBudget}`);
    printLine(`Mutations: ${result.session.allowMutations ? "allowed" : "blocked"}`);
    printLine(`Findings: ${result.session.findings}`);
  } else {
    printLine("Session: none. Run `scout init <spec>` to start.");
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
