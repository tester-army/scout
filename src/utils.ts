import { statSync } from "node:fs";
import { isCancel } from "@clack/prompts";
import { UserCancelledError } from "./errors.js";

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
