import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Record every canonical vibe agent's declared model, including Opus roles. */
export function agentModels(pluginDir: string): Record<string, string> {
  const definitions: Record<string, string> = {};
  for (const file of readdirSync(join(pluginDir, "agents")).filter((name) => name.endsWith(".md"))) {
    const source = readFileSync(join(pluginDir, "agents", file), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    const name = frontmatter?.[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
    const model = frontmatter?.[1].match(/^model:\s*(\S+)\s*$/m)?.[1];
    if (!name || !model) throw new Error(`benchmark-agent-model-missing: ${file}`);
    definitions[name] = model;
  }
  if (definitions["vibe-change-worker"] !== "sonnet") {
    throw new Error("benchmark-writer-model-policy-changed");
  }
  return definitions;
}
