import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_TOOLS, TASK_PREFIX, TEMP_PROJECT, precedentPrompt, summarize } from "./precedent-check.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "precedent-check.mjs");
const QUESTION = "What should the settings page show when someone cancels the GitHub authorization halfway?";
const REPORT = [
  "Answer: Returns to the integrations page with nothing connected and no error",
  "Source: Asana, observed 2026-10-16",
  "Observed directly: canceled on GitHub's screen; Asana showed its integrations list unchanged",
  "Help center / forum: none needed",
  "Apps without this situation: none",
  "Cleanup: nothing created",
].join("\n");

/** A fake claude that records its arguments, folder and stdin, then prints `output` and exits `code`. */
function fakeClaude(dir, { output = REPORT, code = 0, sleep = 0 } = {}) {
  const file = path.join(dir, "claude");
  const reportFile = path.join(dir, "canned-report.txt");
  writeFileSync(reportFile, output);
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\npwd > "${dir}/cwd.txt"\ncat > "${dir}/stdin.txt"\n` +
      `${sleep ? `sleep ${sleep}\n` : ""}cat "${reportFile}"\nexit ${code}\n`
  );
  chmodSync(file, 0o755);
  return file;
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, json: JSON.parse(result.stdout) };
}

function workspace(t) {
  const fixture = makeHome("vibe-precedent-");
  t.after(fixture.cleanup);
  return fixture.root;
}

test("the brief checks Asana first, then another app, then help centers, and carries every safety rule", () => {
  const prompt = precedentPrompt({ question: QUESTION, today: new Date("2026-10-16T12:00:00Z") });
  const order = ["1. Asana, in Chrome", "2. When Asana does not have this situation", "3. When Chrome is not available"];
  const positions = order.map((line) => prompt.indexOf(line));
  assert.ok(positions.every((position) => position >= 0), "every step is present");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "Asana, then another app, then help centers");
  assert.match(prompt, /Linear, then the service's own screens \(for example GitHub's own authorization screens\)/);
  for (const rule of [
    "Never sign in, create an account or type a credential.",
    "Never touch anything that already exists",
    `create one new private project named "${TEMP_PROJECT}", with no members and notifications off`,
    `Prefix every task you create with "${TASK_PREFIX}"`,
    "go only as far as its confirmation step, then cancel it",
    "delete every task you created and then the project, check that they are gone",
    "Verify every state before you record it",
    "A hover can look like a completed task",
    "Keep what you observed directly separate from what a help center or forum says",
    "Quote on-screen wording exactly",
    'write "undocumented"; never guess',
    "Source: <app>, observed 2026-10-16 | <help-center or documentation URL> | undocumented",
    "Cleanup:",
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test("the named apps replace the default fallback and the question is required", () => {
  assert.match(precedentPrompt({ question: QUESTION, apps: "Notion" }), /same flow: Notion\./);
  assert.throws(() => precedentPrompt({ question: "  " }), /--question/);
  assert.equal(run(["prompt"]).status, 1);
});

test("prompt mode prints the brief for the Codex orchestrator and starts nothing", () => {
  const { status, json } = run(["prompt", "--question", QUESTION, "--situation", "Start connecting GitHub, then cancel"]);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.match(json.prompt, /Situation to reproduce: Start connecting GitHub, then cancel/);
});

test("run mode starts headless claude with Chrome and only the research tools, the brief on stdin", (t) => {
  const dir = workspace(t);
  const claude = fakeClaude(dir);
  const out = path.join(dir, "out");
  const { status, json } = run(["run", "--question", QUESTION, "--claude", claude, "--out", out]);
  assert.equal(status, 0);
  assert.deepEqual(json, {
    ok: true,
    answer: "Returns to the integrations page with nothing connected and no error",
    source: "Asana, observed 2026-10-16",
    prompt: path.join(out, "prompt.md"),
    report: path.join(out, "report.md"),
  });
  assert.deepEqual(readFileSync(path.join(dir, "args.txt"), "utf8").trim().split("\n"), ["-p", "--chrome", "--allowedTools", CLAUDE_TOOLS]);
  assert.equal(readFileSync(path.join(dir, "stdin.txt"), "utf8"), readFileSync(path.join(out, "prompt.md"), "utf8"));
  assert.match(readFileSync(path.join(dir, "stdin.txt"), "utf8"), new RegExp(QUESTION.replace(/[?]/g, "\\?")));
  assert.equal(readFileSync(path.join(dir, "cwd.txt"), "utf8").trim(), path.resolve(out));
  assert.equal(readFileSync(path.join(out, "report.md"), "utf8"), REPORT);
});

test("a failed, empty or slow run is not an answer", (t) => {
  const dir = workspace(t);
  const failed = run(["run", "--question", QUESTION, "--claude", fakeClaude(dir, { code: 1 }), "--out", path.join(dir, "a")]);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.error, /exited 1/);
  const empty = run(["run", "--question", QUESTION, "--claude", fakeClaude(dir, { output: "I looked around." }), "--out", path.join(dir, "b")]);
  assert.equal(empty.json.ok, false);
  assert.match(empty.json.error, /no Answer or Source line/);
  const slow = run(["run", "--question", QUESTION, "--claude", fakeClaude(dir, { sleep: 5 }), "--out", path.join(dir, "c"), "--timeout-seconds", "1"]);
  assert.equal(slow.json.ok, false);
  assert.match(slow.json.error, /timed out after 1s/);
  const missing = run(["run", "--question", QUESTION, "--claude", path.join(dir, "no-claude"), "--out", path.join(dir, "d")]);
  assert.equal(missing.json.ok, false);
  assert.match(missing.json.error, /could not start/);
});

test("the summary reads only the report's Answer and Source lines", () => {
  assert.deepEqual(summarize(REPORT), {
    answer: "Returns to the integrations page with nothing connected and no error",
    source: "Asana, observed 2026-10-16",
  });
  assert.deepEqual(summarize("Answer: undocumented\nSource: undocumented\n"), { answer: "undocumented", source: "undocumented" });
  assert.deepEqual(summarize("nothing"), { answer: null, source: null });
});
