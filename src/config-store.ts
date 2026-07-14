import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

/**
 * Credential store shared with the `ta` CLI on purpose: a user who has ever
 * authed `ta` gets `scout report --upload` for free, and vice versa.
 */
export interface TesterArmyCliConfig {
  apiKey?: string;
}

function getConfigDirPath(): string {
  return path.join(homedir(), ".config", "testerarmy");
}

/** Returns the absolute path to CLI config file. */
export function getConfigFilePath(): string {
  return path.join(getConfigDirPath(), "config.json");
}

/** Loads persisted CLI config from disk. */
export async function loadCliConfig(): Promise<TesterArmyCliConfig> {
  const configPath = getConfigFilePath();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const candidate = parsed as Record<string, unknown>;
    const nextConfig: TesterArmyCliConfig = {};

    if (typeof candidate.apiKey === "string" && candidate.apiKey.trim()) {
      nextConfig.apiKey = candidate.apiKey.trim();
    }

    return nextConfig;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }

    throw new Error(`Failed to load config: ${nodeError.message}`, { cause: error });
  }
}

/** Saves CLI config to ~/.config/testerarmy/config.json atomically. */
export async function saveCliConfig(config: TesterArmyCliConfig): Promise<void> {
  const configDir = getConfigDirPath();
  const configPath = getConfigFilePath();
  const tempPath = `${configPath}.tmp-${Date.now()}`;

  await mkdir(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  await chmod(configDir, CONFIG_DIR_MODE).catch(() => {});

  const content = JSON.stringify(config, null, 2);
  await writeFile(tempPath, `${content}\n`, {
    encoding: "utf8",
    mode: CONFIG_FILE_MODE,
  });

  await rename(tempPath, configPath);
  await chmod(configPath, CONFIG_FILE_MODE).catch(() => {});
}

/** Clears CLI config (sign out) by removing the config file. */
export async function clearCliConfig(): Promise<void> {
  const configPath = getConfigFilePath();
  try {
    await unlink(configPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw new Error(`Failed to clear config: ${nodeError.message}`, { cause: error });
    }
  }
}
