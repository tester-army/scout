/**
 * Splits a dotted/bracketed access path into ordered tokens.
 * Supports `a.b.c`, `a[0].b`, and `a.0.b` interchangeably.
 */
function tokenizePath(path: string): string[] {
  return path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Reads a value out of a JSON-like structure by a simple dotted path.
 * Returns `undefined` when any segment is missing or the shape does not
 * match. Deliberately supports only literal keys and array indices — no
 * wildcards or filters — to stay deterministic.
 */
export function extractPath(value: unknown, path: string): unknown {
  let current = value;
  for (const token of tokenizePath(path)) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * Renders an extracted value as a shell-friendly string: primitives pass
 * through verbatim, objects and arrays are serialized as compact JSON.
 */
export function stringifyExtracted(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
