export const SESSION_DIR = ".scout";
export const PROJECT_CONFIG_FILENAME = "scout.json";
export const DEFAULT_RATE_LIMIT_RPS = 5;
export const DEFAULT_REQUEST_BUDGET = 300;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_DOWNLOAD_BYTES = 1_048_576;
export const MAX_RESPONSE_PREVIEW_BYTES = 65_536;
/** Default ceiling for a downloaded OpenAPI spec. Real-world specs are large
 * (e.g. Vercel's is ~9.5 MiB), so this is generous while still bounding an
 * untrusted download. Override per-project with `--max-spec-mb`. */
export const DEFAULT_MAX_SPEC_BYTES = 25 * 1024 * 1024;
/** Hard ceiling for the configurable spec download size, to preserve the
 * bounded-download safety property even when overridden. */
export const MAX_SPEC_BYTES_CEILING = 100 * 1024 * 1024;
