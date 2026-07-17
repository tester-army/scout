import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractOperations, loadSpec } from "./spec-loader.js";
import { countUncompilableSchemaOperations } from "./verdict.js";

/**
 * Regression bench against large real-world specs (Stripe, Vercel). The spec
 * files are not committed; run `pnpm bench:specs` (or
 * `node scripts/download-bench-specs.mjs`) to fetch them into .bench-specs/.
 * Suites only run under BENCH_SPECS=1 and skip absent spec files, so the
 * default test run stays offline and fast.
 */
const benchDir = join(import.meta.dirname, "..", ".bench-specs");
const benchEnabled = process.env.BENCH_SPECS === "1";

const BENCH_SPECS = [
  {
    name: "Stripe",
    file: "stripe.json",
    minOperations: 600,
    maxUncompilable: 0,
  },
  {
    name: "Vercel",
    file: "vercel.json",
    minOperations: 300,
    maxUncompilable: 0,
  },
];

for (const bench of BENCH_SPECS) {
  const path = join(benchDir, bench.file);
  describe.skipIf(!benchEnabled || !existsSync(path))(`spec bench: ${bench.name}`, () => {
    it(
      "loads, dereferences, and compiles every response schema",
      { timeout: 120_000 },
      async () => {
        const loaded = await loadSpec(path);
        expect(loaded.dereferenced).toBe(true);
        expect(loaded.warnings).toEqual([]);

        const operations = extractOperations(loaded.spec);
        expect(operations.length).toBeGreaterThanOrEqual(bench.minOperations);

        const uncompilable = countUncompilableSchemaOperations(
          operations,
          loaded.specVersion,
          loaded.spec.components,
        );
        expect(
          uncompilable.operations.slice(0, 10),
          `${uncompilable.count} operation(s) with uncompilable response schemas`,
        ).toEqual([]);
        expect(uncompilable.count).toBeLessThanOrEqual(bench.maxUncompilable);
      },
    );
  });
}
