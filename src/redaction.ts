const URL_WITH_QUERY_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const SECRETISH_QUERY_KEY_RE = /token|key|secret|password|session|auth|signature|sig/i;

/** Replaces exact resolved-secret values with a placeholder. */
export function redactSecretsOnly(text: string, secrets: Array<string | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

/**
 * Redacts a URL for the evidence log: masks resolved secrets and the values
 * of secret-ish query parameters, but preserves the path and non-secret
 * query params so repros stay meaningful.
 */
export function redactUrl(rawUrl: string, secrets: Array<string | undefined>): string {
  const secretRedacted = redactSecretsOnly(rawUrl, secrets);
  try {
    const url = new URL(secretRedacted);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRETISH_QUERY_KEY_RE.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return secretRedacted;
  }
}

/** Redacts exact secrets and strips query strings from surfaced URLs. */
export function redactMessage(message: string, secrets: Array<string | undefined>): string {
  const redacted = redactSecretsOnly(message, secrets);

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
