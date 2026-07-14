import { loadCliConfig } from "./config-store.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import { normalizeBaseUrl } from "./url.js";
import { getCliVersion } from "./version.js";

export const CLI_CLIENT_NAME = "scout";

export const cliAnalyticsEvents = {
  commandCompleted: "scout_command_completed",
  init: "scout_init",
  sweepCompleted: "scout_sweep_completed",
  auth: "scout_auth",
} as const;

export type CliCommandName = "auth" | "status" | "signout" | "init" | "sweep" | "report";

type CliTelemetryProperties = Record<string, boolean | number | string | null | undefined>;

type CliTelemetryDestination = {
  apiKey: string;
  baseUrl: string;
};

/**
 * Builds CLI metadata headers that the API can use for analytics attribution.
 */
export function buildCliRequestHeaders(): Record<string, string> {
  return {
    "x-testerarmy-client": CLI_CLIENT_NAME,
    "x-testerarmy-cli-version": getCliVersion(),
    "x-testerarmy-os-platform": process.platform,
    "x-testerarmy-os-arch": process.arch,
    "x-testerarmy-node-version": process.version.replace(/^v/, ""),
    "x-testerarmy-ci": process.env.CI ? "1" : "0",
  };
}

/**
 * Resolves where telemetry should go. Returns null when no API key is
 * resolvable — anonymous unauthenticated usage is never phoned home.
 */
async function resolveCliTelemetryDestination(options?: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<CliTelemetryDestination | null> {
  const existingConfig = await loadCliConfig();
  const apiKey =
    options?.apiKey?.trim() ||
    process.env.TESTERARMY_API_KEY?.trim() ||
    existingConfig.apiKey?.trim();

  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      options?.baseUrl ?? process.env.TESTERARMY_BASE_URL ?? DEFAULT_BASE_URL,
    ),
  };
}

/**
 * Sends a best-effort authenticated CLI analytics event to the Tester Army API.
 */
export async function captureCliTelemetryEvent(options: {
  apiKey?: string;
  baseUrl?: string;
  event: string;
  properties?: CliTelemetryProperties;
}): Promise<void> {
  const destination = await resolveCliTelemetryDestination({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  if (!destination) {
    return;
  }

  const timeout = AbortSignal.timeout(2000);

  try {
    await fetch(`${destination.baseUrl}/api/v1/cli/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${destination.apiKey}`,
        ...buildCliRequestHeaders(),
      },
      body: JSON.stringify({
        event: options.event,
        properties: options.properties ?? {},
      }),
      signal: timeout,
    });
  } catch {}
}

/**
 * Sends a best-effort command usage event for a CLI subcommand.
 */
export async function captureCliCommandEvent(options: {
  apiKey?: string;
  baseUrl?: string;
  command: CliCommandName;
  properties?: CliTelemetryProperties;
}): Promise<void> {
  await captureCliTelemetryEvent({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    event: cliAnalyticsEvents.commandCompleted,
    properties: {
      command: options.command,
      ...(options.properties ?? {}),
    },
  });
}
