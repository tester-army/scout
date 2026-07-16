import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_RATE_LIMIT_RPS,
  DEFAULT_REQUEST_BUDGET,
  MAX_SPEC_BYTES_CEILING,
  PROJECT_CONFIG_FILENAME,
} from "./constants.js";
import { ScoutError } from "./errors.js";

const policySchema = z.strictObject({
  allowMutations: z.boolean().optional(),
  allowedMethods: z.array(z.string().min(1)).min(1).optional(),
  allowedPaths: z.array(z.string().min(1)).min(1).optional(),
  rateLimit: z.number().positive().optional(),
  budget: z.number().int().positive().optional(),
});

const authProfileSchema = z.strictObject({
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  cookies: z.record(z.string(), z.string()).optional(),
});

const projectConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  // Optional: omitting `spec` enables spec-less exploratory mode, where every
  // request is treated as undocumented but all other guardrails still apply.
  spec: z.string().min(1).optional(),
  baseUrl: z.string().min(1),
  // Max bytes to download for a remote spec. Omitted uses DEFAULT_MAX_SPEC_BYTES.
  maxSpecBytes: z.number().int().positive().max(MAX_SPEC_BYTES_CEILING).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authProfiles: z.record(z.string(), authProfileSchema).optional(),
  policy: policySchema.optional(),
});

export type ScoutProjectConfig = z.infer<typeof projectConfigSchema>;

export type ResolvedPolicy = {
  allowMutations: boolean;
  allowedMethods?: string[];
  allowedPaths?: string[];
  rateLimit: number;
  budget: number;
};

const ENV_REF_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
const SECRETISH_HEADER_RE = /auth|token|key|secret|cookie|session|password/i;

/** Returns the absolute path to scout.json for a project. */
export function getProjectConfigPath(options?: { config?: string; cwd?: string }): string {
  const cwd = options?.cwd ?? process.cwd();
  return resolve(cwd, options?.config ?? PROJECT_CONFIG_FILENAME);
}

/**
 * Detects header values that look like literal secrets instead of `$VAR`
 * env references. Committing real tokens should be hard.
 */
export function detectLiteralSecretHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.entries(headers)
    .filter(([name, value]) => SECRETISH_HEADER_RE.test(name) && !ENV_REF_RE.test(value))
    .map(([name]) => name);
}

/** Detects literal credentials in named target auth profiles. */
function detectLiteralAuthProfileValues(profiles: ScoutProjectConfig["authProfiles"]): string[] {
  if (!profiles) return [];
  return Object.entries(profiles).flatMap(([profileName, profile]) =>
    Object.entries(profile).flatMap(([location, values]) =>
      Object.entries(values ?? {})
        .filter(([, value]) => !ENV_REF_RE.test(value))
        .map(([name]) => `authProfiles.${profileName}.${location}.${name}`),
    ),
  );
}

/** Loads and validates scout.json. Returns null when the file does not exist. */
export function loadProjectConfig(options?: {
  config?: string;
  cwd?: string;
}): { config: ScoutProjectConfig; path: string } | null {
  const path = getProjectConfigPath(options);
  if (!existsSync(path)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ScoutError(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "VALIDATION_ERROR",
        hint: "Fix the JSON syntax in scout.json, or delete it and re-run `scout init <spec>`.",
        cause: error,
      },
    );
  }

  const result = projectConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ScoutError(`Invalid scout.json at ${path}: ${issues}`, {
      code: "VALIDATION_ERROR",
      hint: "Allowed keys: spec, baseUrl, maxSpecBytes, headers, authProfiles, policy { allowMutations, allowedMethods, allowedPaths, rateLimit, budget }. Re-run `scout init` to regenerate.",
    });
  }

  const literalSecrets = [
    ...detectLiteralSecretHeaders(result.data.headers),
    ...detectLiteralAuthProfileValues(result.data.authProfiles),
  ];
  if (literalSecrets.length > 0 && process.env.CI) {
    throw new ScoutError(
      `scout.json headers contain literal secrets (${literalSecrets.join(", ")}). Refusing to run in CI.`,
      {
        code: "VALIDATION_ERROR",
        hint: 'Use env references instead, e.g. "Authorization": "Bearer $API_TOKEN", and provide the variable via the workflow `env:` block.',
      },
    );
  }

  return { config: result.data, path };
}

/** Loads scout.json or throws NO_SESSION-style guidance when missing. */
export function loadProjectConfigOrThrow(options?: { config?: string; cwd?: string }): {
  config: ScoutProjectConfig;
  path: string;
} {
  const loaded = loadProjectConfig(options);
  if (!loaded) {
    throw new ScoutError(
      `No ${PROJECT_CONFIG_FILENAME} found at ${getProjectConfigPath(options)}.`,
      {
        code: "NO_SESSION",
        hint: "Run `scout init <spec> --base-url <url>` first.",
      },
    );
  }
  return loaded;
}

/** Writes scout.json to disk, returning literal-secret warnings if any. */
export function writeProjectConfig(
  config: ScoutProjectConfig,
  options?: { config?: string; cwd?: string },
): { path: string; literalSecretHeaders: string[] } {
  const path = getProjectConfigPath(options);
  const validated = projectConfigSchema.parse(config);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
  return {
    path,
    literalSecretHeaders: [
      ...detectLiteralSecretHeaders(validated.headers),
      ...detectLiteralAuthProfileValues(validated.authProfiles),
    ],
  };
}

/** Resolves effective safety policy: flags > scout.json > defaults. */
export function resolvePolicy(
  config: ScoutProjectConfig | undefined,
  overrides?: Partial<ResolvedPolicy>,
): ResolvedPolicy {
  return {
    allowMutations: overrides?.allowMutations ?? config?.policy?.allowMutations ?? false,
    ...((overrides?.allowedMethods ?? config?.policy?.allowedMethods)
      ? { allowedMethods: overrides?.allowedMethods ?? config?.policy?.allowedMethods }
      : {}),
    ...((overrides?.allowedPaths ?? config?.policy?.allowedPaths)
      ? { allowedPaths: overrides?.allowedPaths ?? config?.policy?.allowedPaths }
      : {}),
    rateLimit: overrides?.rateLimit ?? config?.policy?.rateLimit ?? DEFAULT_RATE_LIMIT_RPS,
    budget: overrides?.budget ?? config?.policy?.budget ?? DEFAULT_REQUEST_BUDGET,
  };
}
