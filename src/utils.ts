import { statSync } from "node:fs";
import { isCancel } from "@clack/prompts";
import { loadCliConfig } from "./config-store.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import { UserCancelledError } from "./errors.js";
import { normalizeBaseUrl } from "./url.js";

/** Check if running in interactive TTY environment. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Assert that prompt value was not cancelled, throwing UserCancelledError if it was. */
export function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new UserCancelledError();
  }

  return value as T;
}

/** Resolves an API key from CLI option, env var, or config file. Throws if missing. */
export function resolveApiKeyOrThrow(options: {
  optionApiKey?: string;
  envApiKey?: string;
  configApiKey?: string;
}): string {
  const candidate =
    options.optionApiKey?.trim() || options.envApiKey?.trim() || options.configApiKey?.trim();

  if (candidate) {
    return candidate;
  }

  throw new Error("Missing API key. Run `scout auth` first or set TESTERARMY_API_KEY.");
}

/**
 * Resolves TesterArmy API key + base URL from options, env, and config.
 *
 * Does NOT round-trip to the API — `scout auth` already validates on key
 * storage. The next real API call surfaces a friendly 401 if the key is
 * invalid. Only `report --upload` and telemetry ever need this.
 */
export async function resolveAuth(options: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<{ baseUrl: string; apiKey: string }> {
  const existingConfig = await loadCliConfig();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? process.env.TESTERARMY_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const apiKey = resolveApiKeyOrThrow({
    optionApiKey: options.apiKey,
    envApiKey: process.env.TESTERARMY_API_KEY,
    configApiKey: existingConfig.apiKey,
  });

  return { baseUrl, apiKey };
}

/** Returns true when a path points to an existing directory. */
export function isExistingDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads a JSON object from stdin and parses it. Throws with a `thingName`-
 * scoped error message when stdin is empty or the payload is not valid JSON.
 */
export async function readJsonStdin<T = unknown>(thingName: string): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) {
    throw new Error(`No input on stdin. Pipe a JSON ${thingName} payload.`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON on stdin");
  }
}
