// Shared esbuild driver for the TypeScript tool packages under tools/.
// Each package's build.mjs passes in its own esbuild `build` (tools/shared has
// no node_modules of its own), the bundle output directory inside the owning
// plugin, and the source entry files to bundle.
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export async function buildBundles({ build, toolDir, outdir, isEntry, banner }) {
  // Clean stale bundles before building so renamed/deleted sources leave no orphans.
  let cleaned = 0;
  try {
    for (const f of readdirSync(outdir)) {
      if (f.endsWith(".mjs")) {
        rmSync(join(outdir, f));
        cleaned++;
      }
    }
  } catch {
    // outdir may not exist yet on a fresh checkout; that's fine
  }
  if (cleaned > 0) {
    console.log(`cleaned ${cleaned} stale bundle(s) from ${outdir}`);
  }

  const srcDir = resolve(toolDir, "src");
  const entries = readdirSync(srcDir)
    .filter(isEntry)
    .map((f) => resolve(srcDir, f));

  await build({
    entryPoints: entries,
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outExtension: { ".js": ".mjs" },
    banner: { js: banner },
  });
  console.log(`built ${entries.length} entries to ${outdir}`);
}
