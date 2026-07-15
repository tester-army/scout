import { log } from "@clack/prompts";
import { resetSession } from "./session-store.js";
import { isInteractive } from "./utils.js";

export type ResetOptions = {
  json?: boolean;
};

/** Starts a clean run while preserving project configuration and the cached spec. */
export function runResetCommand(options: ResetOptions = {}): void {
  const state = resetSession();
  if (options.json || !isInteractive()) {
    console.log(JSON.stringify({ runId: state.runId, createdAt: state.createdAt }, null, 2));
    return;
  }

  log.success(`Started clean run ${state.runId}.`);
}
