import { isCancel, confirm, intro, log, outro, text } from "@clack/prompts";
import { MAX_SPEC_BYTES_CEILING } from "./constants.js";
import { ScoutError } from "./errors.js";
import { printWarning, stringifyJson } from "./output.js";
import {
  loadProjectConfig,
  writeProjectConfig,
  type ScoutProjectConfig,
} from "./project-config.js";
import { ensureSessionDirGitignored, initSession } from "./session-store.js";
import { discoverSpecUrl, emptyLoadedSpec, extractOperations, loadSpec } from "./spec-loader.js";
import { normalizeApiBaseUrl } from "./url.js";
import { ensureNotCancelled, isInteractive } from "./utils.js";

export type InitOptions = {
  json?: boolean;
  baseUrl?: string;
  header?: string[];
  allowMutations?: boolean;
  allowMethod?: string[];
  allowPath?: string[];
  discover?: boolean;
  /** Max spec download size in MiB (converted to bytes and persisted). */
  maxSpecMb?: number;
};

type InitResult = {
  runId: string;
  configPath: string;
  spec: { source: string; title: string; version: string; specVersion: string };
  specLess: boolean;
  operations: number;
  baseUrl: string;
  baseUrlSource: "flag" | "config" | "spec" | "prompt";
  policy: { allowMutations: boolean; allowedMethods?: string[]; allowedPaths?: string[] };
  converted: boolean;
  dereferenced: boolean;
  warnings: string[];
  gitignoreUpdated: boolean;
  hydratedOnly: boolean;
};

/** Determines where the resolved base URL came from, for reporting. */
function resolveBaseUrlSource(input: {
  flag?: string;
  existing?: string;
  specDefault?: string;
  resolved: string;
}): InitResult["baseUrlSource"] {
  if (input.flag) return "flag";
  if (input.existing) return "config";
  if (input.specDefault && input.resolved === normalizeApiBaseUrl(input.specDefault)) {
    return "spec";
  }
  return "prompt";
}

/**
 * Resolves the effective spec download cap in bytes: `--max-spec-mb` flag
 * (validated against the hard ceiling) takes precedence over the persisted
 * `maxSpecBytes`. Returns undefined to let the loader use its default.
 */
export function resolveMaxSpecBytes(
  options: InitOptions,
  existing?: ScoutProjectConfig,
): number | undefined {
  if (options.maxSpecMb !== undefined) {
    const bytes = options.maxSpecMb * 1024 * 1024;
    if (bytes < 1 || bytes > MAX_SPEC_BYTES_CEILING) {
      throw new ScoutError(
        `--max-spec-mb must be between 1 and ${Math.floor(MAX_SPEC_BYTES_CEILING / (1024 * 1024))}.`,
        { code: "VALIDATION_ERROR" },
      );
    }
    return bytes;
  }
  return existing?.maxSpecBytes;
}

/** Parses repeated `--header 'Name: Value'` flags into a header map. */
export function parseHeaderFlags(headers: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of headers ?? []) {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new ScoutError(`Invalid --header "${entry}". Expected "Name: Value".`, {
        code: "VALIDATION_ERROR",
        hint: 'Use env references for secrets, e.g. --header "Authorization: Bearer $API_TOKEN".',
      });
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Generates or refreshes scout.json and hydrates the .scout/ cache. With an
 * existing scout.json in a non-interactive shell, bare `scout init` just
 * re-hydrates the cache (the CI path).
 */
export async function runInitCommand(
  specArg: string | undefined,
  options: InitOptions,
): Promise<void> {
  const existing = loadProjectConfig();
  const interactive = isInteractive() && !options.json;
  const flagHeaders = parseHeaderFlags(options.header);
  const maxSpecBytes = resolveMaxSpecBytes(options, existing?.config);

  const shouldHydrateOnly =
    existing !== null &&
    !specArg &&
    !options.baseUrl &&
    !options.allowMutations &&
    (options.allowMethod ?? []).length === 0 &&
    (options.allowPath ?? []).length === 0 &&
    !options.discover &&
    options.maxSpecMb === undefined &&
    Object.keys(flagHeaders).length === 0;

  if (interactive && !shouldHydrateOnly) {
    intro("scout init");
  }

  let config: ScoutProjectConfig;
  let loadedSpec;
  if (shouldHydrateOnly && existing) {
    config = existing.config;
    loadedSpec = config.spec
      ? await loadSpec(config.spec, { ...(maxSpecBytes ? { maxBytes: maxSpecBytes } : {}) })
      : emptyLoadedSpec();
  } else {
    const hasNewSpec = Boolean(specArg || options.discover);
    const specSource = await resolveSpecSource({
      specArg,
      options,
      existing: existing?.config,
      interactive,
      maxSpecBytes,
    });
    loadedSpec =
      specSource === undefined
        ? emptyLoadedSpec()
        : await loadSpec(specSource, { ...(maxSpecBytes ? { maxBytes: maxSpecBytes } : {}) });
    config = await buildConfig({
      specSource,
      options,
      interactive,
      existing: hasNewSpec ? undefined : existing?.config,
      flagHeaders,
      specDefaultBaseUrl: loadedSpec.defaultBaseUrl,
      maxSpecBytes,
    });
  }

  const specSource = config.spec;
  const specLess = specSource === undefined;
  const baseUrlSource = resolveBaseUrlSource({
    flag: options.baseUrl,
    existing: !specArg && !options.discover ? existing?.config.baseUrl : undefined,
    specDefault: loadedSpec.defaultBaseUrl,
    resolved: config.baseUrl,
  });

  const { path: configPath, literalSecretHeaders } = writeProjectConfig(config);
  const gitignoreUpdated = ensureSessionDirGitignored();
  const session = initSession(loadedSpec);

  const operations = extractOperations(loadedSpec.spec);

  const result: InitResult = {
    runId: session.runId,
    configPath,
    spec: {
      source: specSource ?? "(none)",
      title: loadedSpec.title,
      version: loadedSpec.version,
      specVersion: loadedSpec.specVersion,
    },
    specLess,
    operations: operations.length,
    baseUrl: config.baseUrl,
    baseUrlSource,
    policy: {
      allowMutations: config.policy?.allowMutations ?? false,
      ...(config.policy?.allowedMethods ? { allowedMethods: config.policy.allowedMethods } : {}),
      ...(config.policy?.allowedPaths ? { allowedPaths: config.policy.allowedPaths } : {}),
    },
    converted: loadedSpec.converted,
    dereferenced: loadedSpec.dereferenced,
    warnings: loadedSpec.warnings,
    gitignoreUpdated,
    hydratedOnly: shouldHydrateOnly,
  };

  if (options.json || !isInteractive()) {
    if (literalSecretHeaders.length > 0) {
      result.warnings.push(
        `Headers may contain literal secrets: ${literalSecretHeaders.join(", ")}. Use $VAR references.`,
      );
    }
    console.log(stringifyJson(result));
    return;
  }

  if (literalSecretHeaders.length > 0) {
    printWarning(
      `Headers may contain literal secrets: ${literalSecretHeaders.join(", ")}. Prefer $VAR references so scout.json is safe to commit.`,
    );
  }
  for (const warning of loadedSpec.warnings) {
    printWarning(warning);
  }

  if (specLess) {
    log.success("Spec-less mode — no OpenAPI spec; every request is treated as undocumented.");
  } else {
    log.success(
      `${loadedSpec.title} ${loadedSpec.version} — ${operations.length} operations cached.`,
    );
  }
  log.info(`Config: ${configPath}`);
  log.info(
    `Base URL: ${config.baseUrl}${baseUrlSource === "spec" ? " (from spec servers[0].url)" : ""}`,
  );
  log.info(`Mutations: ${config.policy?.allowMutations ? "allowed" : "blocked (safe default)"}`);
  outro(
    specLess
      ? "Next: `scout call GET /path --json`. Host lock, mutation gate, rate, and budget still apply."
      : "Next: `scout sweep` for a baseline, or `scout endpoints` to explore.",
  );
}

async function buildConfig(input: {
  specSource?: string;
  options: InitOptions;
  interactive: boolean;
  existing?: ScoutProjectConfig;
  flagHeaders: Record<string, string>;
  specDefaultBaseUrl?: string;
  maxSpecBytes?: number;
}): Promise<ScoutProjectConfig> {
  const { options, interactive, existing, flagHeaders, specDefaultBaseUrl, maxSpecBytes } = input;

  // Precedence: --base-url flag > existing scout.json > spec servers[0].url > prompt.
  let baseUrl = options.baseUrl ?? existing?.baseUrl ?? specDefaultBaseUrl;
  if (!baseUrl && interactive) {
    baseUrl = ensureNotCancelled(
      await text({
        message: "Base URL of the API under test",
        placeholder: "https://api.example.com",
        validate: (value) => (value?.trim() ? undefined : "Base URL is required"),
      }),
    );
  }
  if (!baseUrl) {
    throw new ScoutError("Missing --base-url and the spec declares no server URL.", {
      code: "VALIDATION_ERROR",
      hint: "Pass --base-url <url>, e.g. `scout init openapi.json --base-url https://api.example.com`.",
    });
  }

  let allowMutations = options.allowMutations ?? existing?.policy?.allowMutations ?? false;
  if (interactive && options.allowMutations === undefined && existing === undefined) {
    const answer = await confirm({
      message: "Allow mutating requests (POST/PUT/PATCH/DELETE)? Default is read-only.",
      initialValue: false,
    });
    if (!isCancel(answer)) {
      allowMutations = answer;
    }
  }

  const headers = { ...(existing?.headers ?? {}), ...flagHeaders };
  const allowedMethods =
    options.allowMethod && options.allowMethod.length > 0
      ? options.allowMethod.map((method) => method.toUpperCase())
      : existing?.policy?.allowedMethods;
  const allowedPaths =
    options.allowPath && options.allowPath.length > 0
      ? options.allowPath
      : existing?.policy?.allowedPaths;

  return {
    $schema: "https://tester.army/scout.schema.json",
    ...(input.specSource ? { spec: input.specSource } : {}),
    baseUrl: normalizeApiBaseUrl(baseUrl),
    ...(maxSpecBytes ? { maxSpecBytes } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(existing?.authProfiles ? { authProfiles: existing.authProfiles } : {}),
    policy: {
      allowMutations,
      ...(allowedMethods ? { allowedMethods } : {}),
      ...(allowedPaths ? { allowedPaths } : {}),
    },
  };
}

async function resolveSpecSource(input: {
  specArg?: string;
  options: InitOptions;
  existing?: ScoutProjectConfig;
  interactive: boolean;
  maxSpecBytes?: number;
}): Promise<string | undefined> {
  const { specArg, options, existing, interactive, maxSpecBytes } = input;

  if (specArg) {
    return specArg;
  }

  if (options.discover) {
    const baseUrl = options.baseUrl;
    if (!baseUrl) {
      throw new ScoutError("--discover requires --base-url to probe well-known spec paths.", {
        code: "VALIDATION_ERROR",
        hint: "Run `scout init --discover --base-url https://api.example.com`.",
      });
    }
    return maxSpecBytes ? discoverSpecUrl(baseUrl, maxSpecBytes) : discoverSpecUrl(baseUrl);
  }

  if (existing?.spec) {
    return existing.spec;
  }

  if (interactive) {
    const source = ensureNotCancelled(
      await text({
        message: "OpenAPI spec (URL or file path) — leave blank to explore without one",
        placeholder: "https://api.example.com/openapi.json",
      }),
    );
    const trimmed = source.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  // Non-interactive: a base URL alone enables spec-less exploratory mode.
  if (options.baseUrl || existing?.baseUrl) {
    return undefined;
  }

  throw new ScoutError("Missing spec source and base URL.", {
    code: "VALIDATION_ERROR",
    hint: "Pass a spec (`scout init <url-or-file>`), discover one (`--discover --base-url <url>`), or explore spec-less with `scout init --base-url <url>`.",
  });
}
