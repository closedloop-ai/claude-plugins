// Bundles src/cli.ts to .out/ (same depth as src/, so its relative imports of plugins/ still resolve) and runs it.
// provider.mjs stays external: the build calls the installed module, never a copy of it.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(toolDir, ".out/cli.mjs");
await build({
  entryPoints: [resolve(toolDir, "src/cli.ts")],
  outfile,
  absWorkingDir: toolDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  plugins: [{
    name: "plugins-external",
    setup(builder) {
      builder.onResolve({ filter: /\/plugins\// }, (args) => ({ path: args.path, external: true }));
    },
  }],
});
await import(pathToFileURL(outfile).href);
