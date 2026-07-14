import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  bundle: true,
  ignoreWatch: ["**/*.test.ts", "**/*.spec.ts"],
});
