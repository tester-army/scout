// Downloads large real-world OpenAPI specs used by the spec bench
// (src/spec-bench.test.ts) into .bench-specs/. Files are cached and only
// re-downloaded when missing; delete the directory to force a refresh.
import { mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, ".bench-specs");

const SPECS = [
  {
    file: "stripe.json",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json",
  },
  {
    file: "vercel.json",
    url: "https://openapi.vercel.sh/",
  },
];

mkdirSync(targetDir, { recursive: true });

for (const spec of SPECS) {
  const path = join(targetDir, spec.file);
  if (existsSync(path) && statSync(path).size > 0) {
    console.log(`cached  ${spec.file}`);
    continue;
  }
  console.log(`fetching ${spec.file} <- ${spec.url}`);
  const response = await fetch(spec.url, { redirect: "follow" });
  if (!response.ok) {
    console.error(`failed  ${spec.file}: HTTP ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  const body = await response.text();
  JSON.parse(body); // fail early on non-JSON payloads
  writeFileSync(path, body);
  console.log(`saved   ${spec.file} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
}
