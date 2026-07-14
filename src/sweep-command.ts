import { captureCliTelemetryEvent, cliAnalyticsEvents } from "./cli-analytics.js";
import { appendFinding } from "./findings.js";
import { createExecutorContext } from "./http-executor.js";
import { filterOperations, type OperationFilter } from "./operation-filter.js";
import { runSweep } from "./sweep-engine.js";
import { isInteractive } from "./utils.js";

export type SweepOptions = OperationFilter & {
  json?: boolean;
  maxRequests?: number;
  /** Commander sets this to false when `--no-auth-probes` is passed (default true). */
  authProbes?: boolean;
  config?: string;
};

/** Runs the deterministic no-LLM pre-pass and records findings. */
export async function runSweepCommand(options: SweepOptions): Promise<void> {
  const context = createExecutorContext({ config: options.config });
  const operations = filterOperations(context.operations, options);

  const summary = await runSweep(context, operations, {
    ...(options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {}),
    ...(options.authProbes === false ? { noAuthProbes: false } : {}),
  });

  for (const finding of summary.findings) {
    appendFinding(finding);
  }

  void captureCliTelemetryEvent({
    event: cliAnalyticsEvents.sweepCompleted,
    properties: {
      probes_run: summary.probesRun,
      findings_created: summary.findingsCreated,
    },
  }).catch(() => {});

  const result = {
    probesPlanned: summary.probesPlanned,
    probesRun: summary.probesRun,
    findingsCreated: summary.findingsCreated,
    findings: summary.findings,
  };

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Sweep complete: ${summary.probesRun} probes run, ${summary.findingsCreated} findings recorded.`,
  );
  for (const finding of summary.findings) {
    console.log(`  [${finding.severity}] ${finding.endpoint} — ${finding.title}`);
  }
  console.log("Next: `scout report` to compile, or `scout coverage` to see gaps.");
}
