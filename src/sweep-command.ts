import { appendFinding, type Finding } from "./findings.js";
import { createExecutorContext } from "./http-executor.js";
import {
  resolveOperationsOrThrow,
  scopeOperations,
  type OperationFilter,
} from "./operation-filter.js";
import { stringifyJson } from "./output.js";
import { runSweep } from "./sweep-engine.js";
import { isInteractive } from "./utils.js";

export type SweepOptions = OperationFilter & {
  json?: boolean;
  maxRequests?: number;
  /** Commander sets this to false when `--no-auth-probes` is passed (default true). */
  authProbes?: boolean;
  dryRun?: boolean;
  authProfile?: string;
};

/** Runs the deterministic no-LLM pre-pass and records findings. */
export async function runSweepCommand(options: SweepOptions): Promise<void> {
  const context = createExecutorContext({
    authProfile: options.authProfile,
  });
  const operations = resolveOperationsOrThrow(
    scopeOperations(context.operations, context.policy),
    options,
  );

  const summary = await runSweep(context, operations, {
    ...(options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {}),
    ...(options.authProbes === false ? { noAuthProbes: false } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  });

  let findingsCreated = 0;
  const findings: Finding[] = [];
  const seenFindingIds = new Set<string>();
  for (const finding of summary.findings) {
    const recorded = appendFinding(finding, context.cwd, summary.runId);
    if (recorded.created) findingsCreated += 1;
    if (!seenFindingIds.has(recorded.finding.id)) {
      seenFindingIds.add(recorded.finding.id);
      findings.push(recorded.finding);
    }
  }

  const result = {
    runId: summary.runId,
    probesPlanned: summary.probesPlanned,
    probesRunnable: summary.probesRunnable,
    probesRun: summary.probesRun,
    probesSkipped: summary.probesSkipped,
    probesCapped: summary.probesCapped,
    probesErrored: summary.probesErrored,
    findingsDetected: summary.findingsDetected,
    findingsCreated,
    stopReason: summary.stopReason,
    complete: summary.complete,
    dryRun: options.dryRun === true,
    ...(summary.plan ? { plan: summary.plan } : {}),
    ...(summary.errors ? { errors: summary.errors } : {}),
    findings,
  };

  if (options.json || !isInteractive()) {
    console.log(stringifyJson(result));
    return;
  }

  if (options.dryRun) {
    console.log(
      `Sweep plan: ${summary.probesRunnable}/${summary.probesPlanned} probes runnable, ${summary.probesSkipped} skipped, ${summary.probesCapped} capped.`,
    );
    for (const entry of summary.plan ?? []) {
      console.log(
        `  [${entry.disposition}] ${entry.operation}${entry.kind ? ` — ${entry.kind}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`,
      );
    }
    return;
  }

  console.log(
    `Sweep ${summary.complete ? "complete" : "incomplete"}: ${summary.probesRun}/${summary.probesPlanned} probes run, ${findingsCreated} new findings (${summary.findingsDetected} detected)${summary.probesErrored > 0 ? `, ${summary.probesErrored} errored` : ""}; stop=${summary.stopReason}.`,
  );
  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.endpoint} — ${finding.title}`);
  }
  for (const probeError of summary.errors ?? []) {
    console.log(`  [error] ${probeError.operation} — ${probeError.message}`);
  }
  console.log("Next: `scout report` to compile, or `scout coverage` to see gaps.");
}
