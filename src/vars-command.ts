import { log } from "@clack/prompts";
import { stringifyJson } from "./output.js";
import { loadVars, saveVars } from "./session-vars.js";
import { isInteractive } from "./utils.js";

export type VarsOptions = {
  json?: boolean;
  clear?: boolean;
};

/** Lists or clears the captured session variables. */
export function runVarsCommand(options: VarsOptions): void {
  if (options.clear) {
    saveVars({});
    if (options.json || !isInteractive()) {
      console.log(stringifyJson({ cleared: true }));
      return;
    }
    log.success("Cleared all session variables.");
    return;
  }

  const vars = loadVars();
  if (options.json || !isInteractive()) {
    console.log(stringifyJson({ vars }));
    return;
  }

  const entries = Object.entries(vars);
  if (entries.length === 0) {
    log.message("No session variables captured. Use `scout call ... --capture name=path`.");
    return;
  }
  log.message(entries.map(([name, value]) => `  ${name} = ${value}`).join("\n"));
}
