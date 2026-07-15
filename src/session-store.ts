import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_DIR } from "./constants.js";
import { ScoutError } from "./errors.js";
import type { LoadedSpec } from "./spec-loader.js";

export type SessionState = {
  runId: string;
  specSource: string;
  specHash: string;
  createdAt: string;
  requestCount: number;
};

export type RequestRecord = {
  id: string;
  runId?: string;
  timestamp: string;
  source: "call" | "sweep" | "fuzz";
  testKind?: "control" | "negative";
  operation: string | null;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  schemaValid: boolean | "unknown";
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  responseContentType?: string;
};

const STATE_FILENAME = "state.json";
const SPEC_FILENAME = "spec.json";
const REQUESTS_FILENAME = "requests.jsonl";
const FINDINGS_FILENAME = "findings.jsonl";
const VARS_FILENAME = "vars.json";
const RATE_LIMIT_FILENAME = "rate-limit.json";
const SWEEP_RUNS_FILENAME = "sweep-runs.jsonl";
const STATE_LOCK_FILENAME = "state.lock";
const RUN_ARTIFACT_FILENAMES = [
  REQUESTS_FILENAME,
  FINDINGS_FILENAME,
  VARS_FILENAME,
  RATE_LIMIT_FILENAME,
  SWEEP_RUNS_FILENAME,
] as const;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

/** Returns the absolute session directory path for a project. */
export function getSessionDirPath(cwd = process.cwd()): string {
  return resolve(cwd, SESSION_DIR);
}

/** Returns true when a scout session exists in the given directory. */
export function sessionExists(cwd = process.cwd()): boolean {
  return existsSync(join(getSessionDirPath(cwd), STATE_FILENAME));
}

function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, path);
}

/** Runs a short synchronous state transaction under a cross-process file lock. */
function withStateLock<T>(cwd: string, operation: () => T): T {
  const dir = getSessionDirPath(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, STATE_LOCK_FILENAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS) unlinkSync(lockPath);
      } catch {}
      if (Date.now() >= deadline) {
        throw new ScoutError("Timed out waiting for the session state lock.", {
          code: "VALIDATION_ERROR",
          hint: "Wait for other scout commands to finish, then retry.",
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }

  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

/** Creates immutable identity and clean counters for a new run. */
function createRunState(specSource: string, specHash: string): SessionState {
  return {
    runId: randomUUID(),
    specSource,
    specHash,
    createdAt: new Date().toISOString(),
    requestCount: 0,
  };
}

/** Removes artifacts that must never cross run boundaries. */
function clearRunArtifacts(cwd: string): void {
  const dir = getSessionDirPath(cwd);
  for (const filename of RUN_ARTIFACT_FILENAMES) {
    rmSync(join(dir, filename), { force: true });
  }
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

/** Caches a spec and starts a fresh isolated run. */
export function initSession(loadedSpec: LoadedSpec, cwd = process.cwd()): SessionState {
  const dir = getSessionDirPath(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withStateLock(cwd, () => {
    const state = createRunState(loadedSpec.source, loadedSpec.hash);
    writeFileAtomic(join(dir, SPEC_FILENAME), JSON.stringify(loadedSpec, null, 2));
    clearRunArtifacts(cwd);
    writeFileAtomic(join(dir, STATE_FILENAME), JSON.stringify(state, null, 2));
    return state;
  });
}

/** Starts a fresh run while preserving the active session's cached spec. */
export function resetSession(cwd = process.cwd()): SessionState {
  return withStateLock(cwd, () => {
    const previous = loadSessionState(cwd);
    const state = createRunState(previous.specSource, previous.specHash);
    clearRunArtifacts(cwd);
    writeFileAtomic(join(getSessionDirPath(cwd), STATE_FILENAME), JSON.stringify(state, null, 2));
    return state;
  });
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
  const specHash = typeof parsed.specHash === "string" ? parsed.specHash : "unknown";
  const createdAt =
    typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString();
  return {
    runId: typeof parsed.runId === "string" ? parsed.runId : `legacy-${specHash}-${createdAt}`,
    specSource: typeof parsed.specSource === "string" ? parsed.specSource : "unknown",
    specHash,
    createdAt,
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
  return withStateLock(cwd, () => {
    const state = loadSessionState(cwd);
    state.requestCount += 1;
    writeFileAtomic(join(getSessionDirPath(cwd), STATE_FILENAME), JSON.stringify(state, null, 2));
    return state.requestCount;
  });
}

/** Atomically reserves one request and returns the run that owns it. */
export function reserveRequest(budget: number, cwd = process.cwd()): SessionState {
  return withStateLock(cwd, () => {
    const state = loadSessionState(cwd);
    if (state.requestCount >= budget) {
      throw new ScoutError(`Session request budget exhausted (${state.requestCount}/${budget}).`, {
        code: "BUDGET_EXCEEDED",
        hint: "Raise policy.budget in scout.json, or run `scout reset` to start fresh.",
      });
    }
    state.requestCount += 1;
    writeFileAtomic(join(getSessionDirPath(cwd), STATE_FILENAME), JSON.stringify(state, null, 2));
    return state;
  });
}

/** Reserves a cross-process rate-limit slot and returns the required wait. */
export function reserveRateLimitSlot(requestsPerSecond: number, cwd = process.cwd()): number {
  return withStateLock(cwd, () => {
    const path = join(getSessionDirPath(cwd), RATE_LIMIT_FILENAME);
    const now = Date.now();
    let nextAvailableAt = now;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as { nextAvailableAt?: unknown };
        if (typeof parsed.nextAvailableAt === "number") nextAvailableAt = parsed.nextAvailableAt;
      } catch {}
    }
    const scheduledAt = Math.max(now, nextAvailableAt);
    const intervalMs = 1000 / Math.max(requestsPerSecond, 0.1);
    writeFileAtomic(path, JSON.stringify({ nextAvailableAt: scheduledAt + intervalMs }));
    return scheduledAt - now;
  });
}

/** Appends one redacted request/response record to requests.jsonl. */
export function appendRequestRecord(record: RequestRecord, cwd = process.cwd()): void {
  appendFileSync(join(getSessionDirPath(cwd), REQUESTS_FILENAME), `${JSON.stringify(record)}\n`);
}

/** Appends a request only while its owning run is still active. */
export function appendRequestRecordForRun(
  record: RequestRecord,
  expectedRunId: string,
  cwd = process.cwd(),
): void {
  appendArtifactForRun(REQUESTS_FILENAME, JSON.stringify(record), expectedRunId, cwd);
}

/** Appends a finding only while its owning run is still active. */
export function appendFindingRecordForRun(
  finding: string,
  expectedRunId: string,
  cwd = process.cwd(),
): void {
  appendArtifactForRun(FINDINGS_FILENAME, finding, expectedRunId, cwd);
}

function appendArtifactForRun(
  filename: typeof REQUESTS_FILENAME | typeof FINDINGS_FILENAME,
  content: string,
  expectedRunId: string,
  cwd: string,
): void {
  withStateLock(cwd, () => {
    if (loadSessionState(cwd).runId !== expectedRunId) {
      throw new ScoutError("The active run changed while work was in flight.", {
        code: "VALIDATION_ERROR",
        hint: "Discard this result and retry it in the current run.",
      });
    }
    appendFileSync(join(getSessionDirPath(cwd), filename), `${content}\n`);
  });
}

/** Runs a session mutation only while the expected run remains active. */
export function runWithActiveRun<T>(
  expectedRunId: string,
  operation: () => T,
  cwd = process.cwd(),
): T {
  return withStateLock(cwd, () => {
    if (loadSessionState(cwd).runId !== expectedRunId) {
      throw new ScoutError("The active run changed while work was in flight.", {
        code: "VALIDATION_ERROR",
        hint: "Discard this result and retry it in the current run.",
      });
    }
    return operation();
  });
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
