import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageFocusedClaudeEvalCases } from "./eval-driver.ts";
import { privateTextProblem } from "./private-artifact.ts";

// Operator ruling Q-14162-4 (2026-11-14): every staged Claude case carries the
// skill-use line in its system prompt, the parity of the Codex runner's line;
// the case sources stay unchanged.

function writePlugin(pluginsRoot: string, name: string, dependencies?: string[]): void {
  mkdirSync(join(pluginsRoot, name, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginsRoot, name, ".claude-plugin/plugin.json"),
    JSON.stringify({ name, version: "1.0.0", ...(dependencies ? { dependencies } : {}) }));
}

function writeCase(vibeDir: string, id: string, files: Record<string, string>): void {
  mkdirSync(join(vibeDir, "evals", id), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(vibeDir, "evals", id, name), text);
}

function fixture(root: string): string {
  const plugins = join(root, "plugins");
  writePlugin(plugins, "vibe", ["closedloop-core"]);
  writePlugin(plugins, "closedloop-core");
  return join(plugins, "vibe");
}

test("ISS-14162 Q-14162-4 staged case.yaml and prompt.md cases carry the skill line; sources unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-skill-line-"));
  try {
    const vibeDir = fixture(root);
    const yamlCase = {
      "case.yaml": "schema_version: \"1.1\"\nname: case-yaml\nappend_system_prompt: \"Stand-in session.\"\n",
      "prompt.md": "---\nplugins: [\"../..\"]\n---\nLoad `vibe:handoff` and hand it over.\n",
    };
    const promptCase = {
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"You are in a stand-in session.\"\n---\n" +
        "Load the instructions with the Skill tool (`vibe:vibe`).\n",
    };
    const bareCase = { "prompt.md": "---\ntags: []\n---\nLoad `vibe:vibe`.\n" };
    writeCase(vibeDir, "case-yaml", yamlCase);
    writeCase(vibeDir, "case-prompt", promptCase);
    writeCase(vibeDir, "case-bare", bareCase);

    assert.equal(stageFocusedClaudeEvalCases(vibeDir, ["case-yaml", "case-prompt", "case-bare"]),
      "vibe/evals-focused");
    const staged = (id: string, name: string) => readFileSync(join(vibeDir, "evals-focused", id, name), "utf8");
    assert.equal(staged("case-yaml", "case.yaml"), "schema_version: \"1.1\"\nname: case-yaml\n" +
      "append_system_prompt: \"Stand-in session.\\n\\nUse the installed vibe:handoff skill.\"\n");
    assert.doesNotMatch(staged("case-yaml", "prompt.md"), /append_system_prompt/,
      "a case.yaml system prompt is the one that carries the line");
    assert.match(staged("case-prompt", "prompt.md"),
      /^append_system_prompt: "You are in a stand-in session\.\\n\\nUse the installed vibe:vibe skill\."$/m);
    assert.equal(staged("case-bare", "prompt.md"),
      "---\ntags: []\nappend_system_prompt: \"Use the installed vibe:vibe skill.\"\n---\nLoad `vibe:vibe`.\n");

    for (const [id, files] of [["case-yaml", yamlCase], ["case-prompt", promptCase], ["case-bare", bareCase]] as const) {
      for (const [name, text] of Object.entries(files)) {
        assert.equal(readFileSync(join(vibeDir, "evals", id, name), "utf8"), text, `${id}/${name} source is byte-unchanged`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-4 no selection stages every case with the closure and the skill line", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-full-suite-"));
  try {
    const vibeDir = fixture(root);
    writeCase(vibeDir, "case-one", { "prompt.md": "---\nplugins: [\"../..\"]\n---\nLoad `vibe:vibe`.\n" });
    writeCase(vibeDir, "case-two", { "prompt.md": "---\nplugins: [\"../..\"]\n---\nLoad `vibe:handoff`.\n" });
    mkdirSync(join(vibeDir, "evals/shared"), { recursive: true });
    writeFileSync(join(vibeDir, "evals/shared/stand-in-repo.sh"), "#!/bin/bash\n");

    assert.equal(stageFocusedClaudeEvalCases(vibeDir, []), "vibe/evals-focused",
      "the full suite is staged, never run from the unstaged source");
    const focused = join(vibeDir, "evals-focused");
    assert.deepEqual(readdirSync(focused).sort(), ["case-one", "case-two", "shared"]);
    for (const [id, skill] of [["case-one", "vibe"], ["case-two", "handoff"]] as const) {
      const text = readFileSync(join(focused, id, "prompt.md"), "utf8");
      assert.match(text, /^plugins: \["\.\.\/\.\.", "\.\.\/\.\.\/\.\.\/closedloop-core"\]$/m, `${id} closure`);
      assert.match(text, new RegExp(`^append_system_prompt: "Use the installed vibe:${skill} skill\\."$`, "m"),
        `${id} skill line`);
    }
    assert.equal(existsSync(join(focused, "shared/stand-in-repo.sh")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Orchestrator ruling Q-14162-10 (A), 2026-11-15: a stand-in whose system prompt
// has it do the writer's work is told to work as vibe-change-worker and read
// agents/vibe-change-worker.md in the installed plugin, named relative to the
// plugin and never by an absolute path (orchestrator ruling); no other case is.
// Q-14162-13 (2026-11-15): one combined line, skill first, replaces the separate skill line.
const WRITER_LINE = "Use the installed vibe:vibe skill. You are that skill's implementation writer: also read " +
  "agents/vibe-change-worker.md in the installed vibe plugin (two folders up from the skill's base directory) " +
  "and the quality-loop.md sections it names, 'Visual references' and 'The reference check before ready', " +
  "before you plan.";
const count = (text: string, part: string) => text.split(part).length - 1;

/** Stage one case beside a plugin that has the writer agent; return the staged prompt. */
function stageWithWriterAgent(root: string, files: Record<string, string>): { text: string } {
  const vibeDir = fixture(root);
  mkdirSync(join(vibeDir, "agents"));
  writeFileSync(join(vibeDir, "agents/vibe-change-worker.md"), "# writer\n");
  writeCase(vibeDir, "case-one", files);
  stageFocusedClaudeEvalCases(vibeDir, ["case-one"]);
  for (const [name, text] of Object.entries(files)) {
    assert.equal(readFileSync(join(vibeDir, "evals/case-one", name), "utf8"), text, `${name} source is byte-unchanged`);
  }
  return { text: readFileSync(join(vibeDir, "evals-focused/case-one/prompt.md"), "utf8") };
}

test("ISS-14162 Q-14162-10 a writer stand-in carries the vibe-change-worker line; sources unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-writer-line-"));
  try {
    const { text } = stageWithWriterAgent(root, {
      "case.yaml": "schema_version: \"1.1\"\nname: case-one\n",
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"Stand-in session. Skip startup and " +
        "do the persistent writer's work yourself in this context.\"\n---\nGo ahead and build it.\n",
    });
    assert.equal(text.split("\n")[2], `append_system_prompt: ${JSON.stringify(
      "Stand-in session. Skip startup and do the persistent writer's work yourself in this context.\n\n" +
      WRITER_LINE)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-13 the writer stand-in loads the skill first, once, with no second skill line", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-writer-order-"));
  try {
    const { text } = stageWithWriterAgent(root, {
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"Do the persistent writer's work yourself.\"\n" +
        "---\nLoad `vibe:vibe`.\n",
    });
    assert.ok(text.includes("agents/vibe-change-worker.md"), "the agent file is named");
    assert.ok(text.indexOf("vibe:vibe skill") < text.indexOf("agents/vibe-change-worker.md"),
      "the skill comes before the agent file");
    assert.equal(count(text, "Use the installed vibe:vibe skill."), 1, "no separate second skill line");
    assert.equal(count(text, "agents/vibe-change-worker.md"), 1, "the writer line appears exactly once");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-10 a non-writer stand-in gets no vibe-change-worker line; sources unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-no-writer-line-"));
  try {
    const { text } = stageWithWriterAgent(root, {
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"Stand-in session. The writer returned DONE; " +
        "do the `vibe-guardrails-reviewer` agent's work yourself.\"\n---\nLoad `vibe:handoff`.\n",
    });
    assert.doesNotMatch(text, /vibe-change-worker/);
    assert.match(text, /agent's work yourself\.\\n\\nUse the installed vibe:handoff skill\."$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-10 no staged prompt carries an absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-no-absolute-path-"));
  try {
    const vibeDir = fixture(root);
    mkdirSync(join(vibeDir, "agents"));
    writeFileSync(join(vibeDir, "agents/vibe-change-worker.md"), "# writer\n");
    writeCase(vibeDir, "case-writer", { "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: " +
      "\"Stand-in session. Do the persistent writer's work yourself.\"\n---\nLoad `vibe:vibe`.\n" });
    writeCase(vibeDir, "case-reviewer", { "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: " +
      "\"Do the reviewer's work yourself.\"\n---\nLoad `vibe:handoff`.\n" });
    writeCase(vibeDir, "case-yaml", { "case.yaml": "schema_version: \"1.1\"\nappend_system_prompt: " +
      "\"Do the persistent writer's work yourself.\"\n", "prompt.md": "---\n---\nLoad `vibe:vibe`.\n" });
    stageFocusedClaudeEvalCases(vibeDir, []);
    const staged = ["case-writer/prompt.md", "case-reviewer/prompt.md", "case-yaml/case.yaml", "case-yaml/prompt.md"]
      .map((file) => readFileSync(join(vibeDir, "evals-focused", file), "utf8"));
    assert.equal(count(staged[0]!, WRITER_LINE), 1, "the writer case carries the line");
    assert.equal(count(staged[2]!, WRITER_LINE), 1, "a case.yaml writer carries the line");
    for (const text of staged) {
      assert.equal(privateTextProblem(text), null, text);
      assert.doesNotMatch(text, /\/(?:Users|private|home)\//, text);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-10 a writer stand-in without the agent file stops staging", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-writer-agent-missing-"));
  try {
    const vibeDir = fixture(root);
    writeCase(vibeDir, "case-writer", { "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: " +
      "\"Do the persistent writer's work yourself.\"\n---\nLoad `vibe:vibe`.\n" });
    assert.throws(() => stageFocusedClaudeEvalCases(vibeDir, ["case-writer"]), /^Error: eval-writer-agent-missing$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Orchestrator ruling Q-14162-14 (2), 2026-11-15: a case whose history already holds an
// earlier assistant turn is told it is a later turn, beside the skill line; a first reply is not.
const LATER_TURN = "This is a later turn of a session that is already running, not its first reply.";

test("ISS-14162 Q-14162-14 a case with a prior assistant turn is told it is a later turn", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-later-turn-"));
  try {
    const vibeDir = fixture(root);
    const files = {
      "case.yaml": "schema_version: \"1.1\"\nname: case-later\ncontext:\n  history_file: history.jsonl\n",
      "history.jsonl": "{\"type\": \"user\", \"message\": {\"role\": \"user\", \"content\": []}}\n" +
        "{\"type\": \"assistant\", \"message\": {\"role\": \"assistant\", \"content\": []}}\n",
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"Stand-in session.\"\n---\nLoad `vibe:vibe`.\n",
    };
    writeCase(vibeDir, "case-later", files);
    stageFocusedClaudeEvalCases(vibeDir, ["case-later"]);
    const text = readFileSync(join(vibeDir, "evals-focused/case-later/prompt.md"), "utf8");
    assert.equal(text.split("\n")[2], `append_system_prompt: ${JSON.stringify(
      `Stand-in session.\n\nUse the installed vibe:vibe skill.\n\n${LATER_TURN}`)}`);
    assert.equal(privateTextProblem(text), null);
    assert.doesNotMatch(text, /\/(?:Users|private|home)\//);
    for (const [name, source] of Object.entries(files)) {
      assert.equal(readFileSync(join(vibeDir, "evals/case-later", name), "utf8"), source, `${name} source is byte-unchanged`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-14 a first reply is not told it is a later turn", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-first-reply-"));
  try {
    const vibeDir = fixture(root);
    writeCase(vibeDir, "case-no-history", { "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: " +
      "\"Stand-in session.\"\n---\nLoad `vibe:vibe`.\n" });
    writeCase(vibeDir, "case-user-only", {
      "case.yaml": "schema_version: \"1.1\"\ncontext:\n  history_file: history.jsonl\n",
      "history.jsonl": "{\"type\": \"user\", \"message\": {\"role\": \"user\", \"content\": []}}\n",
      "prompt.md": "---\nplugins: [\"../..\"]\nappend_system_prompt: \"Stand-in session.\"\n---\nLoad `vibe:vibe`.\n",
    });
    stageFocusedClaudeEvalCases(vibeDir, []);
    for (const id of ["case-no-history", "case-user-only"]) {
      const text = readFileSync(join(vibeDir, "evals-focused", id, "prompt.md"), "utf8");
      assert.match(text, /Use the installed vibe:vibe skill\./, `${id} still gets the skill line`);
      assert.doesNotMatch(text, /later turn of a session/, id);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
