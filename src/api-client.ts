import { buildCliRequestHeaders } from "./cli-analytics.js";

/**
 * Client for the TesterArmy API (report upload, key validation, telemetry).
 * Requests to the user's target API never go through this module — see the
 * future http-executor.
 */
export type ApiClientOptions = {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
};

const MAX_ERROR_BODY_LENGTH = 500;

/**
 * Formats an API error response into a single-line CLI message. Parses
 * JSON `{error, message}` first so structured server errors render
 * cleanly; falls back to a truncated raw body for non-JSON responses.
 */
export function formatApiError(status: number, rawBody: string): string {
  if (status === 401) {
    return "Invalid or revoked API key. Run `scout auth` to update it.";
  }
  if (status === 429) {
    return "API rate limit exceeded. Retry shortly.";
  }

  const trimmed = rawBody.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      const code = typeof parsed?.error === "string" ? parsed.error : null;
      const message = typeof parsed?.message === "string" ? parsed.message : null;
      if (code && message) return `API error (${status}) ${code}: ${message}`;
      if (message) return `API error (${status}): ${message}`;
      if (code) return `API error (${status}): ${code}`;
    } catch {
      // fall through to raw-body truncation
    }
  }

  const truncated = trimmed.slice(0, MAX_ERROR_BODY_LENGTH);
  return truncated ? `API error (${status}): ${truncated}` : `API error (${status})`;
}

/** Verifies API key against Tester Army API. */
export async function validateTesterArmyApiKey(options: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}): Promise<void> {
  let response: Response;

  try {
    response = await fetch(`${options.baseUrl}/api/v1/runs?limit=1`, {
      headers: {
        ...buildCliRequestHeaders(),
        Authorization: `Bearer ${options.apiKey}`,
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to reach Tester Army API at ${options.baseUrl}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { cause: error },
    );
  }

  if (response.ok) {
    return;
  }

  const rawBody = await response.text().catch(() => "");
  const error = new Error(formatApiError(response.status, rawBody)) as Error & {
    statusCode: number;
  };
  error.statusCode = response.status;
  throw error;
}
