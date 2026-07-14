const URL_WITH_QUERY_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Redacts exact secrets and strips query strings from surfaced URLs. */
export function redactMessage(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;

  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value) continue;
    redacted = redacted.split(value).join("[redacted]");
  }

  return redacted.replace(URL_WITH_QUERY_RE, (candidate) => {
    try {
      const url = new URL(candidate);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

/** Converts unknown errors to redacted user-facing messages. */
export function toRedactedError(error: unknown, secrets: Array<string | undefined>): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactMessage(message, secrets), { cause: error });
}
