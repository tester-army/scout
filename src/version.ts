import { readFileSync } from "node:fs";

let cachedCliVersion: string | null = null;

/** Resolves CLI version from package.json. */
export function getCliVersion(): string {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  try {
    const data = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(data) as { version?: string };
    cachedCliVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedCliVersion = "unknown";
  }

  return cachedCliVersion;
}
