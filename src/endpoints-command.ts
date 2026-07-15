import { getBorderCharacters, table } from "table";
import { filterOperations, scopeOperations, type OperationFilter } from "./operation-filter.js";
import { stringifyJson } from "./output.js";
import { loadProjectConfigOrThrow, resolvePolicy } from "./project-config.js";
import { loadCachedSpec } from "./session-store.js";
import { extractOperations, type SpecOperation } from "./spec-loader.js";
import { isInteractive } from "./utils.js";

const DEFAULT_LIMIT = 100;

export type EndpointsOptions = OperationFilter & {
  json?: boolean;
  limit?: number;
  all?: boolean;
};

type EndpointRow = {
  method: string;
  path: string;
  auth: boolean;
  summary?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
};

/** Compacts an operation to a row, omitting empty fields to save tokens. */
function toRow(op: SpecOperation): EndpointRow {
  return {
    method: op.method.toUpperCase(),
    path: op.path,
    auth: op.secured,
    ...(op.summary ? { summary: op.summary } : {}),
    ...(op.tags.length > 0 ? { tags: op.tags } : {}),
    ...(op.operationId ? { operationId: op.operationId } : {}),
    ...(op.deprecated ? { deprecated: true } : {}),
  };
}

/** Builds a tag → count overview so agents can orient before drilling in. */
function tagOverview(operations: SpecOperation[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const op of operations) {
    for (const tag of op.tags.length > 0 ? op.tags : ["(untagged)"]) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Lists a compact endpoint index, optionally filtered. Output is capped by
 * default so a large API never blows the caller's context window — the
 * whole point of scout. Narrow with filters or pass --all.
 */
export async function runEndpointsCommand(options: EndpointsOptions): Promise<void> {
  const loadedSpec = loadCachedSpec();
  const { config } = loadProjectConfigOrThrow();
  const matched = filterOperations(
    scopeOperations(extractOperations(loadedSpec.spec), resolvePolicy(config)),
    options,
  ).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const limit = options.all ? matched.length : (options.limit ?? DEFAULT_LIMIT);
  const shown = matched.slice(0, limit);
  const truncated = shown.length < matched.length;
  const hasFilter = Boolean(options.tag || options.path || options.method || options.search);

  if (options.json || !isInteractive()) {
    const payload: Record<string, unknown> = {
      total: matched.length,
      shown: shown.length,
      truncated,
      operations: shown.map(toRow),
    };
    // A tag overview only helps when the caller has not already narrowed by
    // tag; include it when truncated so the next step is obvious.
    if (truncated && !options.tag) {
      payload.tags = tagOverview(matched);
      payload.hint = `Showing ${shown.length} of ${matched.length}. Narrow with --tag <tag>, --path <glob>, --method <m>, or --search <q>; or pass --all.`;
    }
    console.log(stringifyJson(payload));
    return;
  }

  if (matched.length === 0) {
    console.log("No endpoints match the given filters.");
    return;
  }

  if (truncated && !hasFilter) {
    console.log(
      `${matched.length} operations across ${tagOverview(matched).length} tags. Showing ${shown.length}. Narrow with --tag/--path/--search, or --all.\n`,
    );
    const tagRows = tagOverview(matched).map((entry) => [entry.tag, String(entry.count)]);
    console.log(
      table([["Tag", "Ops"], ...tagRows], {
        border: getBorderCharacters("ramac"),
        header: { alignment: "left", content: "Tags" },
      }),
    );
  }

  const tableData = [
    ["Method", "Path", "Auth", "Summary"],
    ...shown.map((op) => [
      op.method.toUpperCase(),
      op.path,
      op.secured ? "yes" : "no",
      (op.summary ?? "").length > 60 ? `${(op.summary ?? "").slice(0, 57)}...` : (op.summary ?? ""),
    ]),
  ];

  console.log(
    table(tableData, {
      border: getBorderCharacters("ramac"),
      header: {
        alignment: "left",
        content: truncated
          ? `${shown.length} of ${matched.length} operations`
          : `${matched.length} operations`,
      },
    }),
  );
}
