import {
  appendFinding,
  createFinding,
  readFindings,
  updateFindingStatus,
  type Finding,
  type FindingStatus,
  validateFindingInput,
} from "./findings.js";
import { stringifyJson } from "./output.js";
import { loadSessionState } from "./session-store.js";
import { isInteractive } from "./utils.js";

export type FindingAddOptions = {
  json?: boolean;
  severity: string;
  category: string;
  endpoint?: string;
  title?: string;
  description?: string;
  repro?: string;
};

export type FindingListOptions = {
  json?: boolean;
};

export type FindingLifecycleOptions = {
  json?: boolean;
};

/** Records an agent-authored finding. */
export async function runFindingAddCommand(options: FindingAddOptions): Promise<void> {
  const state = loadSessionState();
  const validated = validateFindingInput(options);

  const finding = createFinding({
    source: "agent",
    severity: validated.severity,
    category: validated.category,
    endpoint: validated.endpoint,
    title: validated.title,
    ...(options.description ? { description: options.description } : {}),
    ...(options.repro ? { repro: options.repro } : {}),
  });

  const recorded = appendFinding(finding, process.cwd(), state.runId).finding;

  if (options.json || !isInteractive()) {
    console.log(stringifyJson({ recorded: true, finding: recorded }));
    return;
  }

  console.log(`Recorded ${recorded.severity} finding: ${recorded.title} (${recorded.endpoint})`);
}

/** Lists recorded findings. */
export async function runFindingListCommand(options: FindingListOptions): Promise<void> {
  loadSessionState();
  const findings = readFindings();
  const statuses = countFindingStatuses(findings);

  if (options.json || !isInteractive()) {
    console.log(stringifyJson({ count: findings.length, statuses, findings }));
    return;
  }

  if (findings.length === 0) {
    console.log("No findings recorded yet.");
    return;
  }

  for (const finding of findings) {
    console.log(
      `[${finding.status ?? "confirmed"}] [${finding.severity}] ${finding.category} — ${finding.endpoint}: ${finding.title} (${finding.id})`,
    );
  }
}

/** Confirms a candidate finding by id. */
export async function runFindingConfirmCommand(
  id: string,
  options: FindingLifecycleOptions,
): Promise<void> {
  runFindingLifecycleCommand(id, "confirmed", options);
}

/** Dismisses a finding by id so it no longer gates reports. */
export async function runFindingDismissCommand(
  id: string,
  options: FindingLifecycleOptions,
): Promise<void> {
  runFindingLifecycleCommand(id, "dismissed", options);
}

/** Counts effective lifecycle statuses for summary-first output. */
function countFindingStatuses(findings: Finding[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { candidate: 0, confirmed: 0, dismissed: 0 };
  for (const finding of findings) counts[finding.status ?? "confirmed"] += 1;
  return counts;
}

/** Applies and prints one finding lifecycle transition. */
function runFindingLifecycleCommand(
  id: string,
  status: FindingStatus,
  options: FindingLifecycleOptions,
): void {
  const state = loadSessionState();
  const finding = updateFindingStatus(id, status, process.cwd(), state.runId);
  if (options.json || !isInteractive()) {
    console.log(stringifyJson({ updated: true, status, finding }));
    return;
  }
  console.log(
    `${status === "confirmed" ? "Confirmed" : "Dismissed"} finding ${id}: ${finding.title}`,
  );
}
