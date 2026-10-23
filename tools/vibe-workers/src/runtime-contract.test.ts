import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesSchema, type Capability } from "./contracts.js";
import { missingMcpTools } from "./claude-preflight.js";
import { readDefinition } from "./definition.js";
import { recordModes } from "./record-context.js";
import { bundleDirectory, fixture } from "./test-fixtures.js";

const pluginRoot = resolve(bundleDirectory, "../../../..");
const graphOperation = "sync_status";
const requiredReads: Readonly<Record<string, readonly string[]>> = {
  "vibe-requirements-worker": ["get_document"],
  "vibe-ticket-worker": ["get_document"],
};
const workers = [
  "vibe-adversarial-reviewer", "vibe-backend-worker", "vibe-change-worker", "vibe-environment-worker",
  "vibe-guardrails-reviewer", "vibe-handoff-summarizer", "vibe-primitive-worker", "vibe-prototype-worker",
  "vibe-requirements-worker", "vibe-setup-worker", "vibe-storybook-decomposer", "vibe-ticket-worker",
  "vibe-verify-worker",
] as const;
const runtimes = {
  codex: (operation: string) => operation,
  claude: (operation: string) => operation.replaceAll("_", "-"),
};
const builtinFixtures = {
  claude: new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash", "Skill", "WebSearch", "WebFetch", "SendMessage", "Agent"]),
  codex: new Set(["exec_command", "apply_patch", "web.run", "send_message", "spawn_agent"]),
};
const codexBuiltin: Readonly<Record<string, string>> = {
  Read: "exec_command", Write: "apply_patch", Edit: "apply_patch", Grep: "exec_command", Glob: "exec_command",
  Bash: "exec_command", Skill: "exec_command", WebSearch: "web.run", WebFetch: "web.run",
  SendMessage: "send_message", Agent: "spawn_agent",
};

function toolName(server: string, operation: string, runtime: keyof typeof runtimes): string {
  return `mcp__${server}__${runtimes[runtime](operation)}`;
}

function capabilitiesFor(worker: typeof workers[number], runtime: keyof typeof runtimes): Capability[] {
  const capabilities: Capability[] = [{ name: toolName("closedloop-graph", graphOperation, runtime),
    service: "graph", operation: graphOperation, access: "read" }];
  for (const operation of requiredReads[worker] ?? []) capabilities.push({
    name: toolName("closedloop", operation, runtime), service: "closedloop", operation, access: "read",
  });
  const writes = new Set(Object.values(recordModes[worker] ?? {}).flat());
  for (const operation of writes) capabilities.push({
    name: toolName("closedloop", operation, runtime), service: "closedloop", operation, access: "write",
  });
  return capabilities;
}

describe("vibe worker cross-runtime tool contract", () => {
  it("enumerates every worker's built-ins and resolves them in both runtime fixtures", () => {
    const agentNames = readdirSync(join(pluginRoot, "agents")).filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3)).sort();
    expect(workers).toEqual(agentNames.filter((name) => !name.startsWith("vibe-seed-")).sort());
    for (const agentName of agentNames) {
      const definition = readDefinition(pluginRoot, agentName, []);
      for (const tool of definition.tools) {
        expect(builtinFixtures.claude.has(tool), `${agentName} needs unknown Claude tool ${tool}`).toBe(true);
        expect(builtinFixtures.codex.has(codexBuiltin[tool] ?? ""), `${agentName} needs unmapped Codex tool ${tool}`).toBe(true);
      }
    }
  });

  it("resolves every owned worker capability under Codex and Claude MCP naming", () => {
    for (const worker of workers) {
      for (const runtime of Object.keys(runtimes) as (keyof typeof runtimes)[]) {
        expect(capabilitiesSchema.safeParse(capabilitiesFor(worker, runtime)).success,
          `${worker} must accept ${runtime} MCP names`).toBe(true);
      }
    }
  });

  it("treats hyphenated and underscored operation aliases as the same granted MCP tool", () => {
    expect(missingMcpTools(["mcp__closedloop__create-document"],
      ["mcp__closedloop__create_document"])).toEqual([]);
    expect(capabilitiesSchema.safeParse([
      { name: "mcp__closedloop__get_document", service: "closedloop", operation: "get_document", access: "read" },
      { name: "mcp__closedloop__get-document", service: "closedloop", operation: "get_document", access: "read" },
    ]).success).toBe(false);
  });

  it("binds the ticket worker's exact Claude document tools", () => {
    const capabilities = capabilitiesFor("vibe-ticket-worker", "claude");
    expect(capabilities).toEqual(expect.arrayContaining([
      { name: "mcp__closedloop__create-document", service: "closedloop", operation: "create_document", access: "write" },
      { name: "mcp__closedloop__update-document", service: "closedloop", operation: "update_document", access: "write" },
      { name: "mcp__closedloop__create-artifact-link", service: "closedloop", operation: "create_artifact_link", access: "write" },
    ]));
    expect(missingMcpTools(capabilities.map(({ name }) => name), ["mcp__closedloop__create_document"])).toEqual([]);
  });

  it("loads a canonical definition from either runtime manifest", () => {
    const value = fixture();
    try {
      renameSync(join(value.agentRoot, ".claude-plugin"), join(value.agentRoot, ".codex-plugin"));
      expect(readDefinition(value.agentRoot, "vibe-change-worker", capabilitiesFor("vibe-change-worker", "codex")).name)
        .toBe("vibe:vibe-change-worker");
    } finally { value.cleanup(); }
  });

  it("keeps the change worker's Claude collaboration tools in its canonical definition", () => {
    const value = fixture();
    try {
      writeFileSync(join(value.agentRoot, "agents", "vibe-change-worker.md"), `---\nname: vibe-change-worker\ndescription: Fixture role\nmodel: sonnet\ntools: Read, Write, Edit, Grep, Glob, Bash, Skill, SendMessage, Agent\n---\nCanonical fixture prompt.\n`);
      expect(readDefinition(value.agentRoot, "vibe-change-worker", []).tools).toEqual(expect.arrayContaining(["SendMessage", "Agent"]));
    } finally { value.cleanup(); }
  });

  it("keeps each runtime's public vibe invocation distinct", () => {
    const skillText = readFileSync(join(pluginRoot, "skills", "vibe", "SKILL.md"), "utf8");
    const templateText = readFileSync(join(pluginRoot, "skills", "fleet-orchestrator", "references", "templates.md"), "utf8");
    expect(skillText).toContain("Codex: invoke as `$vibe`");
    expect(skillText).toContain("Claude Code: invoke as `/vibe:vibe`");
    expect(templateText).toContain("A Codex writer's prompt starts with `$vibe");
    expect(templateText).toContain("Invoke vibe:vibe first:");
  });
});
