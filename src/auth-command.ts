import { intro, log, outro, password } from "@clack/prompts";
import { validateTesterArmyApiKey } from "./api-client.js";
import { captureCliCommandEvent } from "./cli-analytics.js";
import { clearCliConfig, getConfigFilePath, loadCliConfig, saveCliConfig } from "./config-store.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import { normalizeBaseUrl } from "./url.js";
import { ensureNotCancelled, isInteractive } from "./utils.js";

export type AuthOptions = {
  apiKey?: string;
  baseUrl?: string;
};

/** Runs `scout auth signout` command flow to clear API key from local config. */
export async function runSignoutCommand(): Promise<void> {
  const configPath = getConfigFilePath();
  const existingConfig = await loadCliConfig();

  if (!existingConfig.apiKey) {
    if (isInteractive()) {
      log.info("No credentials stored. You're already signed out.");
      return;
    }

    console.log("No credentials stored.");
    return;
  }

  const telemetryApiKey = process.env.TESTERARMY_API_KEY?.trim() || existingConfig.apiKey?.trim();

  await clearCliConfig();

  void captureCliCommandEvent({
    apiKey: telemetryApiKey,
    command: "signout",
    properties: {
      had_stored_credentials: true,
    },
  }).catch(() => {});

  if (isInteractive()) {
    log.success(`Signed out. Credentials cleared from ${configPath}`);
    return;
  }

  console.log(`Signed out. Credentials cleared from ${configPath}`);
}

/** Runs `scout auth` command flow and persists key to local config. */
export async function runAuthCommand(options?: AuthOptions): Promise<void> {
  if (isInteractive()) {
    intro("Tester Army auth");
  }

  const baseUrl = normalizeBaseUrl(
    options?.baseUrl ?? process.env.TESTERARMY_BASE_URL ?? DEFAULT_BASE_URL,
  );

  const apiKey = await resolveApiKeyInput(options?.apiKey);
  await validateTesterArmyApiKey({ baseUrl, apiKey });

  await saveCliConfig({ apiKey });
  await captureCliCommandEvent({
    apiKey,
    baseUrl,
    command: "auth",
    properties: {
      api_key_source: options?.apiKey?.trim() ? "option" : "prompt",
    },
  });

  const configPath = getConfigFilePath();
  if (isInteractive()) {
    log.success(`API key saved to ${configPath}`);
    outro("Auth complete");
    return;
  }

  console.log(`API key saved to ${configPath}`);
}

async function resolveApiKeyInput(apiKeyFlag?: string): Promise<string> {
  if (apiKeyFlag?.trim()) {
    return apiKeyFlag.trim();
  }

  if (!isInteractive()) {
    throw new Error("Missing API key. Use `scout auth --api-key <key>` in non-interactive mode.");
  }

  const promptResult = ensureNotCancelled(
    await password({
      message:
        "Paste Tester Army API key from dashboard. Get your key here: https://tester.army/dashboard/profile/api-keys?source=scout",
      mask: "*",
      validate: (value?: string) => {
        if (!value?.trim()) {
          return "API key is required";
        }

        return undefined;
      },
    }),
  );

  const value = promptResult.trim();
  if (!value) {
    throw new Error("API key is required");
  }

  return value;
}
