import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScoutError } from "./errors.js";
import { getSessionDirPath, loadSessionState } from "./session-store.js";

const VARS_FILE = "vars.json";
const INTERPOLATION_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Captured session variables, persisted between `scout` invocations. */
export type SessionVars = Record<string, string>;

/** Absolute path to the session variables file. */
function varsFilePath(cwd: string): string {
  return join(getSessionDirPath(cwd), VARS_FILE);
}

/** Loads captured variables, returning an empty map when none exist. */
export function loadVars(cwd = process.cwd()): SessionVars {
  const path = varsFilePath(cwd);
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    throw new ScoutError(`Failed to parse session variables at ${path}.`, {
      code: "VALIDATION_ERROR",
      hint: "Fix or remove .scout/vars.json, then capture the variables again.",
      cause: error,
    });
  }

  const valid =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((value) => typeof value === "string");
  if (!valid) {
    throw new ScoutError(`Invalid session variables at ${path}: expected string values.`, {
      code: "VALIDATION_ERROR",
      hint: "Fix or remove .scout/vars.json, then capture the variables again.",
    });
  }

  return parsed as SessionVars;
}

/** Atomically persists the full variables map for an active session. */
export function saveVars(vars: SessionVars, cwd = process.cwd()): void {
  loadSessionState(cwd);
  const path = varsFilePath(cwd);
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, `${JSON.stringify(vars, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

/** Sets one variable and persists the result, returning the updated map. */
export function setVar(name: string, value: string, cwd = process.cwd()): SessionVars {
  const vars = loadVars(cwd);
  vars[name] = value;
  saveVars(vars, cwd);
  return vars;
}

/**
 * Replaces every `{{name}}` reference in `text` with its captured value.
 * Throws a helpful error when a referenced variable was never captured.
 */
export function interpolateVars(text: string, vars: SessionVars): string {
  return text.replace(INTERPOLATION_RE, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new ScoutError(`Unknown variable {{${name}}}.`, {
        code: "VALIDATION_ERROR",
        hint: `Capture it first, e.g. \`scout call ... --capture ${name}=<path>\`, or run \`scout vars\` to see what is set.`,
      });
    }
    return vars[name] ?? "";
  });
}

/** Returns true when the text contains at least one `{{name}}` reference. */
export function hasInterpolation(text: string): boolean {
  INTERPOLATION_RE.lastIndex = 0;
  return INTERPOLATION_RE.test(text);
}
