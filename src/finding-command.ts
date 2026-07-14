import { appendFinding, createFinding, readFindings, validateFindingInput } from "./findings.js";
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

/** Records an agent-authored finding. */
export async function runFindingAddCommand(options: FindingAddOptions): Promise<void> {
  loadSessionState();
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

  appendFinding(finding);

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify({ recorded: true, finding }, null, 2));
    return;
  }

  console.log(`Recorded ${finding.severity} finding: ${finding.title} (${finding.endpoint})`);
}

/** Lists recorded findings. */
export async function runFindingListCommand(options: FindingListOptions): Promise<void> {
  loadSessionState();
  const findings = readFindings();

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log("No findings recorded yet.");
    return;
  }

  for (const finding of findings) {
    console.log(
      `[${finding.severity}] ${finding.category} — ${finding.endpoint}: ${finding.title}`,
    );
  }
}
