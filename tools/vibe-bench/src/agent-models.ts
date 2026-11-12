import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, resolveWorkerModel, VIBE_AGENT_ROLES,
  type ModelOverrideOptions } from "../../../plugins/vibe/skills/vibe/scripts/agent-models.mjs";

/**
 * Record the model the Claude launcher starts every canonical vibe agent on: the model this machine's person chose
 * for it, else its declared default (ISS-14109). The run's calls are checked against this record, so it must name
 * what the launcher resolves, not only what the agent file declares.
 */
export function agentModels(pluginDir: string, options?: ModelOverrideOptions): Record<string, string> {
  const definitions: Record<string, string> = {};
  for (const file of readdirSync(join(pluginDir, "agents")).filter((name) => name.endsWith(".md"))) {
    const source = readFileSync(join(pluginDir, "agents", file), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    const name = frontmatter?.[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
    const model = frontmatter?.[1].match(/^model:\s*(\S+)\s*$/m)?.[1];
    if (!name || !model) throw new Error(`benchmark-agent-model-missing: ${file}`);
    definitions[name] = model;
  }
  if (definitions["vibe-change-worker"] !== "opus") {
    throw new Error("benchmark-writer-model-policy-changed");
  }
  return Object.fromEntries(Object.entries(definitions).map(([name, model]) => [name,
    Object.hasOwn(VIBE_AGENT_ROLES, name) ? resolveWorkerModel(ModelRuntime.Claude, name, model, options).model : model]));
}
