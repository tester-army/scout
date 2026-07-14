import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";
import { isInteractive } from "./utils.js";

const execFileAsync = promisify(execFile);

const AGENTS_MD_START = "<!-- TESTERARMY-SCOUT:START -->";
const AGENTS_MD_END = "<!-- TESTERARMY-SCOUT:END -->";
const SKILL_REPO = "tester-army/scout";
const SKILL_NAME = "scout";
const SKILL_INSTALL_TIMEOUT_MS = 60_000;

export type AgentInitOptions = {
  json?: boolean;
  skipSkillInstall?: boolean;
  skipAgentsMd?: boolean;
  cwd?: string;
};

type AgentInitResult = {
  success: boolean;
  skill: {
    repo: string;
    name: string;
    installed: boolean;
    skipped: boolean;
    error?: string;
  };
  agentsMd: {
    path: string;
    written: boolean;
    skipped: boolean;
  };
  nextSteps: string[];
};

/** Installs the public scout skill + AGENTS.md discovery hints into a repo. */
export async function runAgentInitCommand(options: AgentInitOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const install = options.skipSkillInstall ? skippedSkillInstall() : await installPublicSkill(cwd);
  const agentsMd = options.skipAgentsMd ? skippedAgentsMd(cwd) : writeLocalAgentsMd(cwd);
  const result: AgentInitResult = {
    success: install.installed || install.skipped,
    skill: install,
    agentsMd,
    nextSteps: [
      "Run `scout init <spec> --base-url <url>` to cache the spec.",
      "Run `scout sweep --json` for a deterministic baseline.",
      "Explore with `scout endpoints --json` and `scout call ... --json`, then `scout report`.",
    ],
  };

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (install.installed) {
    log.success(`Installed ${SKILL_NAME} from ${SKILL_REPO}.`);
  } else if (install.skipped) {
    log.info("Skipped public skill installation.");
  } else {
    log.warn(`Could not install ${SKILL_NAME}: ${install.error}`);
    log.info(`Run \`npx skills add ${SKILL_REPO}\` once the issue is resolved.`);
  }

  if (agentsMd.written) {
    log.success(`Updated ${agentsMd.path} with scout agent guidance.`);
  } else if (agentsMd.skipped) {
    log.info("Skipped AGENTS.md update.");
  }

  log.info("Next: `scout init <spec> --base-url <url>`, then `scout sweep --json`.");
}

async function installPublicSkill(cwd: string): Promise<AgentInitResult["skill"]> {
  try {
    await execFileAsync("npx", ["-y", "skills", "add", SKILL_REPO, "-y"], {
      cwd,
      timeout: SKILL_INSTALL_TIMEOUT_MS,
    });
    return { repo: SKILL_REPO, name: SKILL_NAME, installed: true, skipped: false };
  } catch (error) {
    return {
      repo: SKILL_REPO,
      name: SKILL_NAME,
      installed: false,
      skipped: false,
      error: describeSkillInstallError(error),
    };
  }
}

function skippedSkillInstall(): AgentInitResult["skill"] {
  return { repo: SKILL_REPO, name: SKILL_NAME, installed: false, skipped: true };
}

function skippedAgentsMd(cwd: string): AgentInitResult["agentsMd"] {
  return { path: join(cwd, "AGENTS.md"), written: false, skipped: true };
}

function writeLocalAgentsMd(cwd: string): AgentInitResult["agentsMd"] {
  const path = join(cwd, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
  const next = mergeScoutAgentsMd(existing);

  if (existing !== next) {
    writeFileSync(path, next);
  }

  return { path, written: existing !== next, skipped: false };
}

/** Merges the scout guidance block into AGENTS.md between stable markers. */
export function mergeScoutAgentsMd(existing: string | null): string {
  const block = buildScoutAgentsBlock();
  if (!existing || existing.trim() === "") {
    return `# AGENTS.md\n\n${block}\n`;
  }

  const startIdx = existing.indexOf(AGENTS_MD_START);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(AGENTS_MD_END, startIdx + AGENTS_MD_START.length);
    let before = existing.slice(0, startIdx);
    if (before.length > 0 && !before.endsWith("\n")) before += "\n";
    const after = endIdx === -1 ? "\n" : existing.slice(endIdx + AGENTS_MD_END.length);
    return `${before}${block}${after}`;
  }

  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

function buildScoutAgentsBlock(): string {
  return [
    AGENTS_MD_START,
    "## Scout — API exploration",
    "",
    "This project can use scout to safely explore and test APIs from an OpenAPI spec.",
    "",
    "- **Skill:** use the public `scout` skill for the full workflow. Install/update with `npx skills add tester-army/scout` or `scout agent init`.",
    "- **Start:** `scout init <spec> --base-url <url>` caches the spec; `scout status --json` shows session state.",
    "- **Baseline:** `scout sweep --json` runs a deterministic no-LLM pass and records findings.",
    "- **Explore:** `scout endpoints --json` / `scout schema <method> <path> --json` to orient; `scout call <method> <path> --json` to execute instrumented requests (every response carries a schema/status verdict).",
    "- **Safety:** mutations are blocked unless the session was initialized with --allow-mutations; requests are restricted to the base-URL host.",
    "- **Record & report:** `scout finding add ...` for anything suspicious; `scout coverage --json` for gaps; always finish with `scout report` (`--ci` for a CI gate).",
    AGENTS_MD_END,
  ].join("\n");
}

function describeSkillInstallError(error: unknown): string {
  const err = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
    message?: string;
  };
  const stderr = typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? "");

  if (err.killed || err.signal === "SIGTERM" || err.signal === "SIGKILL") {
    return `timed out after ${SKILL_INSTALL_TIMEOUT_MS / 1000}s`;
  }
  if (err.code === "ENOENT") {
    return "`npx` is not on PATH; install Node.js and npm first";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(stderr)) {
    return "cannot reach the npm registry or GitHub (DNS lookup failed)";
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i.test(stderr)) {
    return "network timeout while installing the skill";
  }
  if (/CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/i.test(stderr)) {
    return "TLS certificate error while installing the skill";
  }
  if (/EACCES|permission denied/i.test(stderr)) {
    return "permission denied writing skill files";
  }
  if (typeof err.code === "number") {
    return `npx exited with code ${err.code}`;
  }

  return err.message ?? "unknown error";
}
