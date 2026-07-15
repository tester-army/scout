import { readFindings } from "./findings.js";
import { printLine, stringifyJson } from "./output.js";
import { loadProjectConfig, resolvePolicy } from "./project-config.js";
import { loadSessionState, sessionExists } from "./session-store.js";
import { isInteractive } from "./utils.js";

export interface StatusCommandOptions {
  json?: boolean;
}

interface SessionInfo {
  active: boolean;
  runId?: string;
  createdAt?: string;
  specSource?: string;
  specHash?: string;
  baseUrl?: string;
  requestsUsed?: number;
  requestBudget?: number;
  rateLimit?: number;
  allowMutations?: boolean;
  allowedMethods?: string[];
  allowedPaths?: string[];
  findings?: number;
}

/** Gathers local project and run details without network access. */
function resolveSessionInfo(): SessionInfo {
  if (!sessionExists()) return { active: false };

  const state = loadSessionState();
  const projectConfig = loadProjectConfig();
  const policy = resolvePolicy(projectConfig?.config);

  return {
    active: true,
    runId: state.runId,
    createdAt: state.createdAt,
    specSource: state.specSource,
    specHash: state.specHash,
    ...(projectConfig ? { baseUrl: projectConfig.config.baseUrl } : {}),
    requestsUsed: state.requestCount,
    requestBudget: policy.budget,
    rateLimit: policy.rateLimit,
    allowMutations: policy.allowMutations,
    ...(policy.allowedMethods ? { allowedMethods: policy.allowedMethods } : {}),
    ...(policy.allowedPaths ? { allowedPaths: policy.allowedPaths } : {}),
    findings: readFindings().length,
  };
}

/** Prints local project and run status without making network requests. */
export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<void> {
  const result = { session: resolveSessionInfo() };

  if (options.json || !isInteractive()) {
    console.log(stringifyJson(result));
    return;
  }

  if (!result.session.active) {
    printLine("Session: none. Run `scout init <spec>` to start.");
    return;
  }

  printLine(`Run: ${result.session.runId}`);
  printLine(`Spec: ${result.session.specSource}`);
  printLine(`Base URL: ${result.session.baseUrl ?? "unknown"}`);
  printLine(`Requests used: ${result.session.requestsUsed}/${result.session.requestBudget}`);
  printLine(`Rate limit: ${result.session.rateLimit} req/s`);
  printLine(`Mutations: ${result.session.allowMutations ? "allowed" : "blocked"}`);
  if (result.session.allowedMethods) {
    printLine(`Allowed methods: ${result.session.allowedMethods.join(", ")}`);
  }
  if (result.session.allowedPaths) {
    printLine(`Allowed paths: ${result.session.allowedPaths.join(", ")}`);
  }
  printLine(`Findings: ${result.session.findings}`);
}
