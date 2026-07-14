import { isCancel, confirm, intro, log, outro, text } from "@clack/prompts";
import { captureCliTelemetryEvent, cliAnalyticsEvents } from "./cli-analytics.js";
import { ScoutError } from "./errors.js";
import { printWarning } from "./output.js";
import {
  loadProjectConfig,
  writeProjectConfig,
  type ScoutProjectConfig,
} from "./project-config.js";
import { ensureSessionDirGitignored, initSession } from "./session-store.js";
import { discoverSpecUrl, extractOperations, loadSpec } from "./spec-loader.js";
import { normalizeApiBaseUrl } from "./url.js";
import { ensureNotCancelled, isInteractive } from "./utils.js";

export type InitOptions = {
  json?: boolean;
  baseUrl?: string;
  header?: string[];
  allowMutations?: boolean;
  allowHost?: string[];
  discover?: boolean;
  config?: string;
};

type InitResult = {
  configPath: string;
  spec: { source: string; title: string; version: string; specVersion: string };
  operations: number;
  baseUrl: string;
  baseUrlSource: "flag" | "config" | "spec" | "prompt";
  policy: { allowMutations: boolean };
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
  const existing = loadProjectConfig({ config: options.config });
  const interactive = isInteractive() && !options.json;
  const flagHeaders = parseHeaderFlags(options.header);

  const shouldHydrateOnly =
    existing !== null &&
    !specArg &&
    !options.baseUrl &&
    !options.allowMutations &&
    !options.discover &&
    Object.keys(flagHeaders).length === 0 &&
    (options.allowHost ?? []).length === 0;

  if (interactive && !shouldHydrateOnly) {
    intro("scout init");
  }

  let config: ScoutProjectConfig;
  let loadedSpec;
  if (shouldHydrateOnly && existing) {
    config = existing.config;
    loadedSpec = await loadSpec(config.spec);
  } else {
    const specSource = await resolveSpecSource({
      specArg,
      options,
      existing: existing?.config,
      interactive,
    });
    loadedSpec = await loadSpec(specSource);
    config = await buildConfig({
      specSource,
      options,
      interactive,
      existing: existing?.config,
      flagHeaders,
      specDefaultBaseUrl: loadedSpec.defaultBaseUrl,
    });
  }

  const specSource = config.spec;
  const baseUrlSource = resolveBaseUrlSource({
    flag: options.baseUrl,
    existing: existing?.config.baseUrl,
    specDefault: loadedSpec.defaultBaseUrl,
    resolved: config.baseUrl,
  });

  const { path: configPath, literalSecretHeaders } = writeProjectConfig(config, {
    config: options.config,
  });
  const gitignoreUpdated = ensureSessionDirGitignored();
  initSession(loadedSpec);

  const operations = extractOperations(loadedSpec.spec);

  const result: InitResult = {
    configPath,
    spec: {
      source: specSource,
      title: loadedSpec.title,
      version: loadedSpec.version,
      specVersion: loadedSpec.specVersion,
    },
    operations: operations.length,
    baseUrl: config.baseUrl,
    baseUrlSource,
    policy: { allowMutations: config.policy?.allowMutations ?? false },
    converted: loadedSpec.converted,
    dereferenced: loadedSpec.dereferenced,
    warnings: loadedSpec.warnings,
    gitignoreUpdated,
    hydratedOnly: shouldHydrateOnly,
  };

  void captureCliTelemetryEvent({
    event: cliAnalyticsEvents.init,
    properties: {
      operations: operations.length,
      converted: loadedSpec.converted,
      spec_version: loadedSpec.specVersion,
    },
  }).catch(() => {});

  if (options.json || !isInteractive()) {
    if (literalSecretHeaders.length > 0) {
      result.warnings.push(
        `Headers may contain literal secrets: ${literalSecretHeaders.join(", ")}. Use $VAR references.`,
      );
    }
    console.log(JSON.stringify(result, null, 2));
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

  log.success(
    `${loadedSpec.title} ${loadedSpec.version} — ${operations.length} operations cached.`,
  );
  log.info(`Config: ${configPath}`);
  log.info(
    `Base URL: ${config.baseUrl}${baseUrlSource === "spec" ? " (from spec servers[0].url)" : ""}`,
  );
  log.info(`Mutations: ${config.policy?.allowMutations ? "allowed" : "blocked (safe default)"}`);
  outro("Next: `scout sweep` for a baseline, or `scout endpoints` to explore.");
}

async function buildConfig(input: {
  specSource: string;
  options: InitOptions;
  interactive: boolean;
  existing?: ScoutProjectConfig;
  flagHeaders: Record<string, string>;
  specDefaultBaseUrl?: string;
}): Promise<ScoutProjectConfig> {
  const { options, interactive, existing, flagHeaders, specDefaultBaseUrl } = input;

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
  const allowHosts = [...new Set([...(existing?.allowHosts ?? []), ...(options.allowHost ?? [])])];

  return {
    $schema: "https://tester.army/scout.schema.json",
    spec: input.specSource,
    baseUrl: normalizeApiBaseUrl(baseUrl),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(allowHosts.length > 0 ? { allowHosts } : {}),
    policy: { allowMutations },
  };
}

async function resolveSpecSource(input: {
  specArg?: string;
  options: InitOptions;
  existing?: ScoutProjectConfig;
  interactive: boolean;
}): Promise<string> {
  const { specArg, options, existing, interactive } = input;

  if (specArg) {
    return specArg;
  }

  if (existing?.spec) {
    return existing.spec;
  }

  if (options.discover) {
    const baseUrl = options.baseUrl ?? existing?.baseUrl;
    if (!baseUrl) {
      throw new ScoutError("--discover requires --base-url to probe well-known spec paths.", {
        code: "VALIDATION_ERROR",
        hint: "Run `scout init --discover --base-url https://api.example.com`.",
      });
    }
    return discoverSpecUrl(baseUrl);
  }

  if (interactive) {
    const source = ensureNotCancelled(
      await text({
        message: "OpenAPI spec (URL or file path)",
        placeholder: "https://api.example.com/openapi.json",
        validate: (value) => (value?.trim() ? undefined : "Spec source is required"),
      }),
    );
    return source.trim();
  }

  throw new ScoutError("Missing spec source.", {
    code: "VALIDATION_ERROR",
    hint: "Pass a spec: `scout init <url-or-file>`, or `scout init --discover --base-url <url>`.",
  });
}
