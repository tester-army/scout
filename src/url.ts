/** Normalizes and validates a base URL value. */
export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https protocol");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/$/, "");
}

/** Normalizes and validates a target request URL. */
export function normalizeTargetUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Target URL must use http or https protocol");
  }

  return parsed.toString();
}
