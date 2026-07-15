import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@clack/prompts";
import { stringifyJson } from "./output.js";
import { isInteractive } from "./utils.js";

const AGENTS_MD_START = "<!-- TESTERARMY-SCOUT:START -->";
const AGENTS_MD_END = "<!-- TESTERARMY-SCOUT:END -->";
const SKILL_NAME = "scout";
const BUNDLED_SKILL_PATH = fileURLToPath(new URL("../skills/scout/SKILL.md", import.meta.url));

export type AgentInitOptions = {
  json?: boolean;
  skipSkillInstall?: boolean;
  skipAgentsMd?: boolean;
  cwd?: string;
  skillSource?: string;
};

type AgentInitResult = {
  success: boolean;
  skill: {
    name: string;
    path: string;
    installed: boolean;
    skipped: boolean;
  };
  agentsMd: {
    path: string;
    written: boolean;
    skipped: boolean;
  };
  nextSteps: string[];
};

/** Installs the bundled scout skill and AGENTS.md discovery hints into a repo. */
export async function runAgentInitCommand(options: AgentInitOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const install = options.skipSkillInstall
    ? skippedSkillInstall(cwd)
    : installBundledSkill(cwd, options.skillSource ?? BUNDLED_SKILL_PATH);
  const agentsMd = options.skipAgentsMd ? skippedAgentsMd(cwd) : writeLocalAgentsMd(cwd);
  const result: AgentInitResult = {
    success: true,
    skill: install,
    agentsMd,
    nextSteps: [
      "Confirm authorized hosts, endpoints, methods, identities, rate, budget, and test window.",
      "Run `scout init <spec> --base-url <url>`, then orient with `scout endpoints --json` and `scout schema ... --json`.",
      "Preview a filtered `scout sweep --dry-run`, execute it, then use `scout call`/`scout fuzz` and `scout report`.",
    ],
  };

  if (options.json || !isInteractive()) {
    console.log(stringifyJson(result));
    return;
  }

  if (install.installed) log.success(`Installed bundled ${SKILL_NAME} skill at ${install.path}.`);
  else log.info("Skipped skill installation.");
  if (agentsMd.written) log.success(`Updated ${agentsMd.path} with scout agent guidance.`);
  else if (agentsMd.skipped) log.info("Skipped AGENTS.md update.");
  log.info("Next: confirm authorized scope, then run `scout init <spec> --base-url <url>`.");
}

function installBundledSkill(cwd: string, source: string): AgentInitResult["skill"] {
  const path = join(cwd, ".agents", "skills", SKILL_NAME, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(source, path);
  return { name: SKILL_NAME, path, installed: true, skipped: false };
}

function skippedSkillInstall(cwd: string): AgentInitResult["skill"] {
  return {
    name: SKILL_NAME,
    path: join(cwd, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    installed: false,
    skipped: true,
  };
}

function skippedAgentsMd(cwd: string): AgentInitResult["agentsMd"] {
  return { path: join(cwd, "AGENTS.md"), written: false, skipped: true };
}

function writeLocalAgentsMd(cwd: string): AgentInitResult["agentsMd"] {
  const path = join(cwd, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
  const next = mergeScoutAgentsMd(existing);
  if (existing !== next) writeFileSync(path, next);
  return { path, written: existing !== next, skipped: false };
}

/** Merges the scout guidance block into AGENTS.md between stable markers. */
export function mergeScoutAgentsMd(existing: string | null): string {
  const block = buildScoutAgentsBlock();
  if (!existing || existing.trim() === "") return `# AGENTS.md\n\n${block}\n`;

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
    "## Scout - API exploration",
    "",
    "This project can use scout to explore and test authorized APIs from an OpenAPI spec.",
    "",
    "- **Skill:** use the local `scout` skill for the full workflow; refresh it with `scout agent init`.",
    "- **Authorize:** confirm host, endpoints, methods, identities/tenants, test data, rate, budget, and test window before requests.",
    "- **Start:** `scout init <spec> --base-url <url>` starts an isolated run; `scout status --json` shows local state.",
    "- **Orient:** use `scout endpoints --json` and `scout schema <method> <path> --json`.",
    "- **Plan:** preview traffic with a filtered `scout sweep --dry-run --json`.",
    "- **Explore:** `scout call <method> <path> --json` only executes documented operations by default.",
    "- **Fuzz:** preview with `scout fuzz <method> <path> --dry-run --json`; execute only with mutation authorization and cleanup.",
    "- **Report:** validate candidate findings, then finish with `scout report --ci`.",
    AGENTS_MD_END,
  ].join("\n");
}
