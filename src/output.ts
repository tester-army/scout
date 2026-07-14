import { log, type LogMessageOptions } from "@clack/prompts";
import { isInteractive } from "./utils.js";

/** Prints one line in both interactive and non-interactive terminals. */
export function printLine(message: string): void {
  if (isInteractive()) {
    log.info(message);
    return;
  }

  console.log(message);
}

/** Prints a multi-line message block in both interactive and non-interactive terminals. */
export function printMessage(message: string | string[], options?: LogMessageOptions): void {
  if (isInteractive()) {
    log.message(message, options);
    return;
  }

  console.log(Array.isArray(message) ? message.join("\n") : message);
}

/** Prints a warning in both interactive and non-interactive terminals. */
export function printWarning(message: string): void {
  if (isInteractive()) {
    log.warn(message);
    return;
  }

  console.log(`Warning: ${message}`);
}

/** Prints a success line in both interactive and non-interactive terminals. */
export function printSuccess(message: string): void {
  if (isInteractive()) {
    log.success(message);
    return;
  }

  console.log(message);
}
