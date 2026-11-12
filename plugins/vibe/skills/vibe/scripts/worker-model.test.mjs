import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexBindingForRole } from "../../cl-sweep/scripts/model-policy.mjs";
import { MODELS_FILE_ENV, readModelOverrides, resolveWorkerModel, setModelOverride, VIBE_AGENT_ROLES } from "./agent-models.mjs";
import { claudeWorkerBinding, codexWorkerBinding } from "./worker-model.mjs";

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
const OPERATIONAL = ["vibe-environment-worker", "vibe-prototype-worker", "vibe-seed-pr-worker", "vibe-setup-worker", "vibe-ticket-worker"];

// The default tests below must not read the models this machine's person chose.
const scratch = mkdtempSync(path.join(os.tmpdir(), "vibe-worker-model-"));
process.env[MODELS_FILE_ENV] = path.join(scratch, "none.json");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A models file of its own for one test, and the options that point the resolver at it. */
function modelsAt(name, overrides) {
  const file = path.join(scratch, name);
  if (overrides !== undefined) {
    writeFileSync(file, typeof overrides === "string" ? overrides : JSON.stringify(overrides));
  }
  return { file, options: { env: { [MODELS_FILE_ENV]: file } } };
}

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

test("every agent that writes product code defaults to opus on Claude Code (ISS-14109)", () => {
  const writers = agentFiles.map((file) => frontmatter(file)).filter((meta) => VIBE_AGENT_ROLES[meta.name] === "writer");
  assert.deepEqual(writers.map((meta) => meta.name).sort(), ["vibe-change-worker", "vibe-seed-fix-worker"]);
  for (const meta of writers) {
    assert.equal(meta.model, "opus", `${meta.name} model`);
    assert.equal(claudeWorkerBinding(meta.name).model, "opus", `${meta.name} binding`);
  }
  // An agent that can edit files is a code writer unless it is one of the named operational workers.
  for (const meta of agentFiles.map((file) => frontmatter(file)).filter((entry) => /\bEdit\b/.test(entry.tools))) {
    assert.ok(VIBE_AGENT_ROLES[meta.name] === "writer" || OPERATIONAL.includes(meta.name), `${meta.name} edits files`);
  }
  assert.deepEqual(Object.keys(VIBE_AGENT_ROLES).filter((name) => VIBE_AGENT_ROLES[name] === "operational").sort(), OPERATIONAL);
  assert.deepEqual(codexBindingForRole("operational"), codexBindingForRole("writer"));
});

test("no agent's Codex default changed when the operational role was split from writer", () => {
  const explorers = ["vibe-backend-worker", "vibe-handoff-summarizer", "vibe-primitive-worker", "vibe-requirements-worker", "vibe-storybook-decomposer"];
  for (const name of Object.keys(VIBE_AGENT_ROLES)) {
    const { model, reasoning_effort: effort } = codexWorkerBinding(name);
    assert.deepEqual({ model, effort }, { model: explorers.includes(name) ? "gpt-5.6-terra" : "gpt-6-sol", effort: "high" }, name);
  }
});

test("a person's model for a role reaches that role's agents on its harness and no other role or harness", () => {
  const { options } = modelsAt("role.json", { claude: { roles: { writer: "any-model-9[1m]" } }, codex: { roles: { explorer: "gpt-anything" } } });
  const codexWriter = modelsAt("codex-writer.json", { codex: { roles: { writer: "gpt-writer" } } }).options;
  assert.equal(codexWorkerBinding("vibe-seed-fix-worker", codexWriter).model, "gpt-writer");
  assert.equal(codexWorkerBinding("vibe-ticket-worker", codexWriter).model, "gpt-6-sol", "an operational worker is not a writer");
  assert.equal(claudeWorkerBinding("vibe-change-worker", codexWriter).model, "opus", "the Codex writer override does not reach Claude Code");
  assert.deepEqual(claudeWorkerBinding("vibe:vibe-change-worker", options), { agent: "vibe-change-worker", role: "writer", model: "any-model-9[1m]" });
  assert.equal(claudeWorkerBinding("vibe-seed-fix-worker", options).model, "any-model-9[1m]");
  for (const [name, model] of [["vibe-ticket-worker", "sonnet"], ["vibe-requirements-worker", "sonnet"], ["vibe-verify-worker", "sonnet"],
    ["vibe-adversarial-reviewer", "opus"]]) {
    assert.equal(claudeWorkerBinding(name, options).model, model, name);
  }
  assert.equal(codexWorkerBinding("vibe-change-worker", options).model, "gpt-6-sol", "the Claude writer override does not reach Codex");
  assert.deepEqual(codexWorkerBinding("vibe-requirements-worker", options),
    { agent: "vibe-requirements-worker", role: "explorer", model: "gpt-anything", reasoning_effort: "high" });
  assert.equal(codexWorkerBinding("vibe-verify-worker", options).model, "gpt-6-sol");
});

test("an agent's model beats its role's, one launch's model beats both, and with none the default applies", () => {
  const { options } = modelsAt("agent.json", { claude: { roles: { reviewer: "role-model" }, agents: { "vibe-guardrails-reviewer": "agent-model" } } });
  assert.deepEqual(resolveWorkerModel("claude", "vibe-guardrails-reviewer", "sonnet", options), { model: "agent-model", source: "agent" });
  assert.deepEqual(resolveWorkerModel("claude", "vibe-adversarial-reviewer", "opus", options), { model: "role-model", source: "role" });
  assert.deepEqual(resolveWorkerModel("claude", "vibe-guardrails-reviewer", "sonnet", { ...options, launchModel: "launch-model" }),
    { model: "launch-model", source: "launch" });
  assert.deepEqual(resolveWorkerModel("claude", "vibe-change-worker", "opus", options), { model: "opus", source: "default" });
  const absent = modelsAt("absent.json");
  assert.deepEqual(readModelOverrides(absent.options), {});
  assert.deepEqual(resolveWorkerModel("codex", "vibe-change-worker", "gpt-6-sol", absent.options), { model: "gpt-6-sol", source: "default" });
});

test("set and unset save any model name for a role or an agent and keep the other entries", () => {
  const { file, options } = modelsAt("set.json");
  setModelOverride("claude", "writer", "claude-fable-5-2", options);
  setModelOverride("claude", "vibe:vibe-verify-worker", "us.vendor.model-v1:0", options);
  setModelOverride("codex", "explorer", "gpt-x", options);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    claude: { roles: { writer: "claude-fable-5-2" }, agents: { "vibe-verify-worker": "us.vendor.model-v1:0" } },
    codex: { roles: { explorer: "gpt-x" } },
  });
  // Keys this release does not know are kept, and no temporary file is left behind.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), note: "kept", claude: { roles: { writer: "x" }, future: { a: 1 } } }));
  const kept = setModelOverride("claude", "writer", "claude-fable-5-2", options);
  assert.deepEqual(kept, { claude: { roles: { writer: "claude-fable-5-2" }, future: { a: 1 } }, codex: { roles: { explorer: "gpt-x" } }, note: "kept" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), kept);
  assert.equal(existsSync(`${file}.tmp`), false);
  setModelOverride("claude", "vibe-verify-worker", "us.vendor.model-v1:0", options);
  assert.deepEqual(setModelOverride("claude", "writer", undefined, options).claude,
    { roles: {}, future: { a: 1 }, agents: { "vibe-verify-worker": "us.vendor.model-v1:0" } });
  assert.equal(claudeWorkerBinding("vibe-change-worker", options).model, "opus");
  assert.equal(claudeWorkerBinding("vibe-verify-worker", options).model, "us.vendor.model-v1:0");
  assert.throws(() => setModelOverride("claude", "vibe-made-up-worker", "opus", options), /Unknown vibe agent/);
  assert.throws(() => setModelOverride("gemini", "writer", "opus", options), /Unknown harness/);
  for (const bad of ["", "two words", "--flag"]) {
    assert.throws(() => setModelOverride("claude", "writer", bad, options), /must be a model name with no spaces/, bad);
  }
});

test("a models file that cannot be used is refused, never read as no override", () => {
  for (const [name, body, reason] of [["broken.json", "{not json", /could not be read/], ["list.json", "[]", /not a JSON object/],
    ["shape.json", { claude: { roles: "opus" } }, /claude\.roles is not an object/],
    ["value.json", { codex: { agents: { "vibe-change-worker": 5 } } }, /codex\.agents\.vibe-change-worker is not a model name/],
    ["role.json", { claude: { roles: { writers: "opus" } } }, /claude\.roles\.writers is not a vibe role/],
    ["agent.json", { claude: { agents: { "vibe:vibe-change-worker": "opus" } } }, /claude\.agents\.vibe:vibe-change-worker is not a vibe agent/]]) {
    const { file, options } = modelsAt(name, body);
    assert.throws(() => claudeWorkerBinding("vibe-change-worker", options), (error) => error.code === "MODEL_OVERRIDES_INVALID"
      && error.message.includes(file) && reason.test(error.message), name);
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
  const bad = spawnSync(process.execPath, [SCRIPT, "codex"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage/);
});

test("the command prints the Claude binding and saves a model the person chose", () => {
  const { file } = modelsAt("command.json");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, [MODELS_FILE_ENV]: file } });
  assert.deepEqual(JSON.parse(run("claude", "vibe-change-worker").stdout), { agent: "vibe-change-worker", role: "writer", model: "opus" });
  assert.equal(existsSync(file), false);
  assert.deepEqual(JSON.parse(run("set", "claude", "writer", "claude-fable-5-2").stdout), { claude: { roles: { writer: "claude-fable-5-2" } } });
  assert.equal(JSON.parse(run("claude", "vibe-change-worker").stdout).model, "claude-fable-5-2");
  assert.equal(JSON.parse(run("claude", "vibe-ticket-worker").stdout).model, "sonnet");
  assert.equal(run("unset", "claude", "writer").status, 0);
  assert.equal(JSON.parse(run("claude", "vibe-change-worker").stdout).model, "opus");
  writeFileSync(file, "{not json");
  const refused = run("codex", "vibe-change-worker");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Model overrides in .* could not be read/);
});
