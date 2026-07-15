import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ScoutError } from "./errors.js";
import {
  appendFindingRecordForRun,
  getFindingsFilePath,
  runWithActiveRun,
} from "./session-store.js";

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  "contract-violation",
  "auth",
  "error-handling",
  "data-integrity",
  "performance",
  "spec-quality",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type Finding = {
  id: string;
  timestamp: string;
  source: "sweep" | "fuzz" | "agent";
  severity: FindingSeverity;
  category: FindingCategory;
  endpoint: string;
  title: string;
  status?: "candidate" | "confirmed" | "dismissed";
  description?: string;
  evidence?: string[];
  repro?: string;
};

export type FindingStatus = NonNullable<Finding["status"]>;

export type FindingWriteResult = {
  finding: Finding;
  created: boolean;
};

/** Numeric rank for severity comparisons (critical is highest). */
export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.length - FINDING_SEVERITIES.indexOf(severity);
}

/** Parses a --severity flag value. */
export function parseSeverity(value: string): FindingSeverity {
  const normalized = value.trim().toLowerCase();
  if ((FINDING_SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as FindingSeverity;
  }

  throw new Error(`--severity must be one of: ${FINDING_SEVERITIES.join(", ")}`);
}

/** Parses a --category flag value. */
export function parseCategory(value: string): FindingCategory {
  const normalized = value.trim().toLowerCase();
  if ((FINDING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as FindingCategory;
  }

  throw new Error(`--category must be one of: ${FINDING_CATEGORIES.join(", ")}`);
}

/** Returns the stable identity used to collapse repeated mechanical findings. */
export function findingDeduplicationKey(
  finding: Pick<Finding, "source" | "category" | "endpoint" | "title" | "repro">,
): string {
  return [
    finding.source,
    finding.category,
    finding.endpoint,
    finding.title,
    finding.repro ?? "",
  ].join("\u0000");
}

/** Creates a finding with a stable mechanical id or a random agent-authored id. */
export function createFinding(input: Omit<Finding, "id" | "timestamp">): Finding {
  const id =
    input.source === "agent"
      ? randomUUID()
      : `finding_${createHash("sha256").update(findingDeduplicationKey(input)).digest("hex").slice(0, 24)}`;
  return {
    id,
    timestamp: new Date().toISOString(),
    ...input,
  };
}

/** Appends a finding unless the same deterministic finding is already recorded. */
export function appendFinding(
  finding: Finding,
  cwd = process.cwd(),
  expectedRunId?: string,
): FindingWriteResult {
  if (finding.source !== "agent") {
    const key = findingDeduplicationKey(finding);
    const existing = readFindings(cwd).find(
      (candidate) => candidate.source !== "agent" && findingDeduplicationKey(candidate) === key,
    );
    if (existing) return { finding: existing, created: false };
  }

  if (expectedRunId) {
    appendFindingRecordForRun(JSON.stringify(finding), expectedRunId, cwd);
  } else {
    writeFileSync(getFindingsFilePath(cwd), `${JSON.stringify(finding)}\n`, { flag: "a" });
  }
  return { finding, created: true };
}

/** Reads all recorded findings for the session (empty when none). */
export function readFindings(cwd = process.cwd()): Finding[] {
  const path = getFindingsFilePath(cwd);
  if (!existsSync(path)) return [];

  const findings = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Finding);

  const seenMechanical = new Set<string>();
  return findings.filter((finding) => {
    if (finding.source === "agent") return true;
    const key = findingDeduplicationKey(finding);
    if (seenMechanical.has(key)) return false;
    seenMechanical.add(key);
    return true;
  });
}

/** Updates one finding's lifecycle status by id and persists the compacted log. */
export function updateFindingStatus(
  id: string,
  status: FindingStatus,
  cwd = process.cwd(),
  expectedRunId?: string,
): Finding {
  const update = () => {
    const findings = readFindings(cwd);
    const index = findings.findIndex((finding) => finding.id === id);
    if (index === -1) {
      throw new ScoutError(`Finding ${id} was not found.`, {
        code: "NOT_FOUND",
        hint: "Run `scout finding list --json` to copy a current finding id.",
      });
    }

    const updated = { ...findings[index], status } as Finding;
    findings[index] = updated;
    const path = getFindingsFilePath(cwd);
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(
      temporaryPath,
      findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n",
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );
    renameSync(temporaryPath, path);
    return updated;
  };

  return expectedRunId ? runWithActiveRun(expectedRunId, update, cwd) : update();
}

/** Validates finding input coming from CLI flags. */
export function validateFindingInput(input: {
  severity: string;
  category: string;
  endpoint?: string;
  title?: string;
}): { severity: FindingSeverity; category: FindingCategory; endpoint: string; title: string } {
  if (!input.endpoint?.trim()) {
    throw new ScoutError("Missing required --endpoint.", {
      code: "VALIDATION_ERROR",
      hint: 'Pass the operation, e.g. --endpoint "GET /users/{id}".',
    });
  }
  if (!input.title?.trim()) {
    throw new ScoutError("Missing required --title.", {
      code: "VALIDATION_ERROR",
      hint: "Pass a short human-readable title for the finding.",
    });
  }

  return {
    severity: parseSeverity(input.severity),
    category: parseCategory(input.category),
    endpoint: input.endpoint.trim(),
    title: input.title.trim(),
  };
}
