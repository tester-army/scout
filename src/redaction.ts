const URL_WITH_QUERY_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const SECRETISH_QUERY_KEY_RE =
  /(^|[-_])(api[-_]?key|key|token|secret|password|session|auth|signature|sig)([-_]|$)/i;

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

/** Recursively redacts exact known secret strings in JSON-compatible values. */
export function redactJsonSecrets(value: unknown, secrets: Array<string | undefined>): unknown {
  if (typeof value === "string") {
    return redactSecretsOnly(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonSecrets(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonSecrets(item, secrets)]),
    );
  }
  return value;
}

/**
 * Redacts a URL for the evidence log: masks resolved secrets and the values
 * of declared or secret-ish query parameters, but preserves the path and
 * non-secret query params so repros stay meaningful.
 */
export function redactUrl(
  rawUrl: string,
  secrets: Array<string | undefined>,
  credentialQueryKeys: Iterable<string> = [],
): string {
  const secretRedacted = redactSecretsOnly(rawUrl, secrets);
  try {
    const url = new URL(secretRedacted);
    const credentialKeys = new Set(credentialQueryKeys);
    for (const key of [...url.searchParams.keys()]) {
      if (credentialKeys.has(key) || SECRETISH_QUERY_KEY_RE.test(key)) {
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

const AUTH_SCHEME_RE = /\b(?:Bearer|Basic|Digest|Negotiate)\s+\S{8,}/i;
const HIGH_ENTROPY_TOKEN_RE = /[A-Za-z0-9+/_.=-]{20,}/g;
const MIN_TOKEN_ENTROPY_BITS = 3.2;

/** Shannon entropy per character of a string, in bits. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Heuristically decides whether an already-redacted value still looks like it
 * carries a live credential. Scout only redacts secrets it can identify (env
 * references and secret-ish header/query/body names), so a literal token pasted
 * into an arbitrary header would otherwise leak into output and artifacts. A
 * surviving auth scheme or high-entropy token is a strong tell.
 */
export function looksLikeUnredactedSecret(value: string): boolean {
  if (value.includes("[redacted]")) return false;
  if (AUTH_SCHEME_RE.test(value)) return true;
  for (const token of value.match(HIGH_ENTROPY_TOKEN_RE) ?? []) {
    if (shannonEntropy(token) >= MIN_TOKEN_ENTROPY_BITS) return true;
  }
  return false;
}
