/** Error used when the user cancels an interactive prompt. */
export class UserCancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "UserCancelledError";
  }
}

/** Stable scout-specific error codes carried explicitly by ScoutError. */
export type ScoutErrorCode =
  | "NO_SESSION"
  | "MUTATION_BLOCKED"
  | "HOST_BLOCKED"
  | "SCOPE_BLOCKED"
  | "BUDGET_EXCEEDED"
  | "SPEC_INVALID"
  | "ENV_VAR_MISSING"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "NOT_FOUND";

/**
 * Error with an explicit machine-readable code and an agent-actionable hint.
 * Prefer this over message-regex derivation for scout-specific failures.
 */
export class ScoutError extends Error {
  readonly code: ScoutErrorCode;
  readonly hint?: string;

  constructor(message: string, options: { code: ScoutErrorCode; hint?: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ScoutError";
    this.code = options.code;
    this.hint = options.hint;
  }
}

export type CliErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    statusCode?: number;
  };
  exitCode: number;
};

/** Returns true when error came from user cancellation. */
export function isUserCancelledError(error: unknown): boolean {
  return error instanceof UserCancelledError;
}

/** Returns true when argv requests machine-readable JSON output. */
export function isJsonOutputRequested(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}

/** Extracts status code from API error (walks nested causes). */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const visited = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const err = current as Record<string, unknown>;

    if (typeof err.statusCode === "number") {
      return err.statusCode;
    }

    current = err.cause;
  }

  return undefined;
}

/** Converts unknown errors into a user-friendly message. */
export function toErrorMessage(error: unknown): string {
  const statusCode = getErrorStatusCode(error);

  if (statusCode !== undefined) {
    if (statusCode === 404) {
      return "API endpoint not found. Check the operation path and configured base URL.";
    }

    if (statusCode === 401 || statusCode === 403) {
      return "Target API authentication failed. Check the selected auth profile or configured headers.";
    }

    if (statusCode >= 500) {
      return `Target API is unavailable (${statusCode}). Stop testing and check service health.`;
    }

    return `API request failed (${statusCode}). Please check your connection and try again.`;
  }

  if (error instanceof Error) {
    const message = error.message || "";

    if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
      return "Could not connect. Please check your internet connection and base URL.";
    }

    return message;
  }

  return `Unexpected error: ${String(error)}`;
}

/** Converts unknown errors into a stable JSON envelope for agents and scripts. */
export function toJsonErrorEnvelope(error: unknown, exitCode: number): CliErrorEnvelope {
  const statusCode = getErrorStatusCode(error);
  const hint = getErrorHint(error, statusCode);
  return {
    success: false,
    error: {
      code: getErrorCode(error, statusCode),
      message: toErrorMessage(error),
      ...(hint ? { hint } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
    },
    exitCode,
  };
}

function getErrorCode(error: unknown, statusCode: number | undefined): string {
  if (isUserCancelledError(error)) return "USER_CANCELLED";
  if (error instanceof ScoutError) return error.code;

  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) return "AUTH_FAILED";
    if (statusCode === 404) return "NOT_FOUND";
    if (statusCode >= 500) return "SERVICE_UNAVAILABLE";
    return "API_ERROR";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/invalid json/i.test(message)) return "INVALID_JSON";
  if (/no input on stdin/i.test(message)) return "STDIN_REQUIRED";
  if (/econnrefused|enotfound|network|could not connect/i.test(message)) return "NETWORK_ERROR";
  if (/missing required|nothing to update|must be/i.test(message)) {
    return "VALIDATION_ERROR";
  }

  return "CLI_ERROR";
}

function getErrorHint(error: unknown, statusCode: number | undefined): string | undefined {
  if (error instanceof ScoutError && error.hint) {
    return error.hint;
  }

  if (statusCode === 401 || statusCode === 403) {
    return "Check the target API credentials configured in scout.json and retry.";
  }
  if (statusCode === 404) {
    return "Check the resource ID, operation path, and configured base URL.";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "Retry later. If this persists, capture the command and JSON error output for support.";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/invalid json/i.test(message)) {
    return "Validate the JSON payload being piped to stdin.";
  }
  if (/no input on stdin/i.test(message)) {
    return "Pipe a JSON object into the command, for example `cat payload.json | scout call POST /users --data-stdin --json`.";
  }
  return undefined;
}
