import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "scout-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { stdio: "inherit" });
  const archive = readdirSync(directory).find((entry) => entry.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not create a tarball");
  execFileSync("npm", ["install", "--prefix", directory, join(directory, archive)], {
    stdio: "inherit",
  });
  const scout = join(directory, "node_modules", ".bin", "scout");
  execFileSync(scout, ["--version"], { stdio: "inherit" });
  execFileSync(scout, ["--help"], { stdio: "ignore" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
