/**
 * Legacy plugin JavaScript entry points remain in the payload, while every
 * newly authored runtime tool must come from a TypeScript toolchain.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const GENERATED_PAYLOAD_DIRS = new Set([
  "plugins/closedloop-core/skills/guided-manual-qa/scripts/dist",
  "plugins/code-review/scripts/dist",
  "plugins/code/skills/design-inventory/scripts/dist",
  "plugins/vibe/skills/vibe/scripts/dist",
]);

function runtimeFiles(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git"].includes(entry.name)
        || entry.name === "dist" && GENERATED_PAYLOAD_DIRS.has(relative(root, file).split(sep).join("/"))) return [];
      return runtimeFiles(root, file);
    }
    if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) return [];
    return [relative(root, file).split(sep).join("/")];
  });
}

/** Reject every plugin runtime .mjs outside the pinned pre-TypeScript inventory. */
export function unapprovedRuntimeSources(repoRoot: string, allowed: ReadonlySet<string>): string[] {
  return runtimeFiles(repoRoot, join(repoRoot, "plugins")).filter((file) => !allowed.has(file)).sort();
}
