import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_DIR } from "./constants.js";
import { ScoutError } from "./errors.js";
import type { LoadedSpec } from "./spec-loader.js";

export type SessionState = {
  specSource: string;
  specHash: string;
  createdAt: string;
  requestCount: number;
};

export type RequestRecord = {
  id: string;
  timestamp: string;
  source: "call" | "sweep";
  operation: string | null;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  schemaValid: boolean | "unknown";
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseContentType?: string;
};

const STATE_FILENAME = "state.json";
const SPEC_FILENAME = "spec.json";
const REQUESTS_FILENAME = "requests.jsonl";
const FINDINGS_FILENAME = "findings.jsonl";

/** Returns the absolute session directory path for a project. */
export function getSessionDirPath(cwd = process.cwd()): string {
  return resolve(cwd, SESSION_DIR);
}

/** Returns true when a scout session exists in the given directory. */
export function sessionExists(cwd = process.cwd()): boolean {
  return existsSync(join(getSessionDirPath(cwd), STATE_FILENAME));
}

function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.tmp-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, path);
}

/** Appends the session dir to .gitignore once (idempotent). */
export function ensureSessionDirGitignored(cwd = process.cwd()): boolean {
  const gitignorePath = resolve(cwd, ".gitignore");
  const entry = `${SESSION_DIR}/`;
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";

  const alreadyListed = existing
    .split("\n")
    .some((line) => line.trim() === entry || line.trim() === SESSION_DIR);
  if (alreadyListed) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  return true;
}

/** Creates (or refreshes) the on-disk session: state + cached deref'd spec. */
export function initSession(loadedSpec: LoadedSpec, cwd = process.cwd()): SessionState {
  const dir = getSessionDirPath(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const previous = sessionExists(cwd) ? loadSessionState(cwd) : null;
  const sameSpec = previous?.specHash === loadedSpec.hash;

  const state: SessionState = {
    specSource: loadedSpec.source,
    specHash: loadedSpec.hash,
    createdAt: sameSpec && previous ? previous.createdAt : new Date().toISOString(),
    requestCount: sameSpec && previous ? previous.requestCount : 0,
  };

  writeFileAtomic(join(dir, SPEC_FILENAME), JSON.stringify(loadedSpec, null, 2));
  writeFileAtomic(join(dir, STATE_FILENAME), JSON.stringify(state, null, 2));
  return state;
}

/** Loads session state, throwing NO_SESSION when the session is missing. */
export function loadSessionState(cwd = process.cwd()): SessionState {
  const statePath = join(getSessionDirPath(cwd), STATE_FILENAME);
  if (!existsSync(statePath)) {
    throw new ScoutError("No scout session in this directory.", {
      code: "NO_SESSION",
      hint: "Run `scout init <spec>` first.",
    });
  }

  const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<SessionState>;
  return {
    specSource: typeof parsed.specSource === "string" ? parsed.specSource : "unknown",
    specHash: typeof parsed.specHash === "string" ? parsed.specHash : "unknown",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    requestCount: typeof parsed.requestCount === "number" ? parsed.requestCount : 0,
  };
}

/** Loads the cached dereferenced spec, throwing NO_SESSION when missing. */
export function loadCachedSpec(cwd = process.cwd()): LoadedSpec {
  const specPath = join(getSessionDirPath(cwd), SPEC_FILENAME);
  if (!existsSync(specPath)) {
    throw new ScoutError("No cached spec in this scout session.", {
      code: "NO_SESSION",
      hint: "Run `scout init <spec>` first.",
    });
  }

  return JSON.parse(readFileSync(specPath, "utf-8")) as LoadedSpec;
}

/** Increments and persists the session request budget counter. */
export function incrementRequestCount(cwd = process.cwd()): number {
  const state = loadSessionState(cwd);
  state.requestCount += 1;
  writeFileAtomic(join(getSessionDirPath(cwd), STATE_FILENAME), JSON.stringify(state, null, 2));
  return state.requestCount;
}

/** Appends one redacted request/response record to requests.jsonl. */
export function appendRequestRecord(record: RequestRecord, cwd = process.cwd()): void {
  appendFileSync(join(getSessionDirPath(cwd), REQUESTS_FILENAME), `${JSON.stringify(record)}\n`);
}

/** Reads all request records from requests.jsonl (empty when none). */
export function readRequestRecords(cwd = process.cwd()): RequestRecord[] {
  const path = join(getSessionDirPath(cwd), REQUESTS_FILENAME);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RequestRecord);
}

/** Returns the absolute path to findings.jsonl for the session. */
export function getFindingsFilePath(cwd = process.cwd()): string {
  return join(getSessionDirPath(cwd), FINDINGS_FILENAME);
}
