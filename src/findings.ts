import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ScoutError } from "./errors.js";
import { getFindingsFilePath } from "./session-store.js";

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
  source: "sweep" | "agent";
  severity: FindingSeverity;
  category: FindingCategory;
  endpoint: string;
  title: string;
  description?: string;
  evidence?: string[];
  repro?: string;
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

/** Creates a finding with generated id + timestamp. */
export function createFinding(input: Omit<Finding, "id" | "timestamp">): Finding {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  };
}

/** Appends a finding to the session findings log. */
export function appendFinding(finding: Finding, cwd = process.cwd()): void {
  const path = getFindingsFilePath(cwd);
  appendFileSync(path, `${JSON.stringify(finding)}\n`);
}

/** Reads all recorded findings for the session (empty when none). */
export function readFindings(cwd = process.cwd()): Finding[] {
  const path = getFindingsFilePath(cwd);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Finding);
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
