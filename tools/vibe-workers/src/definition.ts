import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { capabilitiesSchema, type Capability } from "./contracts.js";

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const metadataSchema = z.object({ name: z.string(), description: z.string().min(1),
  model: z.string().min(1), tools: z.union([z.string(), z.array(z.string())]),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();
const builtins = new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash", "Skill", "ToolSearch"]);

/** Reads the canonical own-plugin agent once, preserving its prompt, model and declared built-ins. */
export function readDefinition(agentRoot: string, agentName: string, capabilityInput: Capability[]) {
  if (!/^vibe-[a-z0-9-]+$/.test(agentName)) throw new Error("Only own-plugin vibe agents are supported");
  const root = realpathSync(agentRoot);
  const file = realpathSync(join(root, "agents", `${agentName}.md`));
  if (file !== join(root, "agents", `${agentName}.md`)) throw new Error("Agent escapes its owning plugin");
  const manifest = z.object({ name: z.literal("vibe") }).passthrough().parse(
    JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")),
  );
  const source = readFileSync(file, "utf8");
  const match = source.match(frontmatter);
  if (!match) throw new Error("Agent has no canonical frontmatter");
  const metadata = metadataSchema.parse(parse(match[1] ?? ""));
  if (metadata.name !== agentName) throw new Error("Agent name does not match canonical file");
  const tools = asList(metadata.tools);
  if (tools.some((tool) => !builtins.has(tool))) throw new Error("Unrecognized canonical built-in tool");
  const capabilities = capabilitiesSchema.parse(capabilityInput).sort((a, b) => a.name.localeCompare(b.name));
  const digest = createHash("sha256").update(source).update(JSON.stringify(capabilities)).digest("hex");
  return { root, name: `${manifest.name}:${agentName}`, metadata, prompt: match[2] ?? "", tools,
    skills: asList(metadata.skills), binding: { agentRoot: root, agentName, digest, capabilities } };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value;
}
