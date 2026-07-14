import { getBorderCharacters, table } from "table";
import { filterOperations, type OperationFilter } from "./operation-filter.js";
import { loadCachedSpec } from "./session-store.js";
import { extractOperations } from "./spec-loader.js";
import { isInteractive } from "./utils.js";

export type EndpointsOptions = OperationFilter & {
  json?: boolean;
};

/** Lists a compact endpoint index, optionally filtered. */
export async function runEndpointsCommand(options: EndpointsOptions): Promise<void> {
  const loadedSpec = loadCachedSpec();
  const operations = filterOperations(extractOperations(loadedSpec.spec), options);

  const rows = operations
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .map((op) => ({
      method: op.method.toUpperCase(),
      path: op.path,
      summary: op.summary ?? "",
      auth: op.secured,
      tags: op.tags,
      deprecated: op.deprecated,
      operationId: op.operationId ?? null,
    }));

  if (options.json || !isInteractive()) {
    console.log(JSON.stringify({ count: rows.length, operations: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No endpoints match the given filters.");
    return;
  }

  const tableData = [
    ["Method", "Path", "Auth", "Summary"],
    ...rows.map((row) => [
      row.method,
      row.path,
      row.auth ? "yes" : "no",
      row.summary.length > 60 ? `${row.summary.slice(0, 57)}...` : row.summary,
    ]),
  ];

  console.log(
    table(tableData, {
      border: getBorderCharacters("ramac"),
      header: { alignment: "left", content: `${rows.length} operations` },
    }),
  );
}
