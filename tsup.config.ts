import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/cli/index.ts" },
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  // Templates (the generated notifier scripts) ship as static files under
  // ./templates and are resolved at runtime — they are NOT bundled.
  banner: { js: "#!/usr/bin/env node" },
});
