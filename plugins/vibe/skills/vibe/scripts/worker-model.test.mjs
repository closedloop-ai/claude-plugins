import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexBindingForRole } from "../../cl-sweep/scripts/model-policy.mjs";
import { codexWorkerBinding, VIBE_AGENT_ROLES } from "./worker-model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "worker-model.mjs");
const AGENTS = path.resolve(HERE, "../../../agents");
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const WRITE_TOOLS = /\b(?:Write|Edit|NotebookEdit)\b/;

function frontmatter(file) {
  const block = FRONTMATTER.exec(readFileSync(path.join(AGENTS, file), "utf8"))?.[1] ?? "";
  return Object.fromEntries(block.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
}

const agentFiles = readdirSync(AGENTS).filter((file) => file.endsWith(".md"));

test("every vibe agent file has exactly one role, and every role names a real agent", () => {
  const names = agentFiles.map((file) => frontmatter(file).name).sort();
  assert.deepEqual(Object.keys(VIBE_AGENT_ROLES).sort(), names);
});

test("explorers run on gpt-5.6-terra and every other role keeps gpt-6-sol, all at high effort on Codex", () => {
  const explorer = codexWorkerBinding("vibe-requirements-worker");
  assert.deepEqual(explorer, { agent: "vibe-requirements-worker", role: "explorer", model: "gpt-5.6-terra", reasoning_effort: "high" });
  const writer = codexWorkerBinding("vibe:vibe-change-worker");
  assert.deepEqual(writer, { agent: "vibe-change-worker", role: "writer", model: "gpt-6-sol", reasoning_effort: "high" });
  assert.equal(codexWorkerBinding("vibe-adversarial-reviewer").model, "gpt-6-sol");
  assert.equal(codexWorkerBinding("vibe-verify-worker").model, "gpt-6-sol");
  for (const name of Object.keys(VIBE_AGENT_ROLES)) {
    assert.notEqual(codexWorkerBinding(name).reasoning_effort, "xhigh", name);
  }
});

test("Claude explorers only read and search, on sonnet or haiku", () => {
  for (const file of agentFiles) {
    const meta = frontmatter(file);
    if (VIBE_AGENT_ROLES[meta.name] !== "explorer") {
      continue;
    }
    assert.match(meta.model, /^(?:sonnet|haiku)$/, `${meta.name} model`);
    assert.doesNotMatch(meta.tools, WRITE_TOOLS, `${meta.name} tools`);
  }
});

test("an unknown agent or role is refused instead of falling back to a default model", () => {
  assert.throws(() => codexWorkerBinding("vibe-made-up-worker"), /Unknown vibe agent/);
  assert.throws(() => codexWorkerBinding("constructor"), /Unknown vibe agent/);
  assert.throws(() => codexBindingForRole("toString"), /Unknown Codex worker role/);
  assert.deepEqual(codexBindingForRole("mechanical"), { model: "gpt-6-luna", reasoningEffort: "low" });
});

test("the command prints the Codex binding the skill passes to spawn_agent", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, "codex", "vibe-storybook-decomposer"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), {
    agent: "vibe-storybook-decomposer", role: "explorer", model: "gpt-5.6-terra", reasoning_effort: "high",
  });
  const bad = spawnSync(process.execPath, [SCRIPT, "claude", "vibe-change-worker"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage/);
});
