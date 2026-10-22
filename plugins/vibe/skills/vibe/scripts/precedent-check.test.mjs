import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_TOOLS, TASK_PREFIX, TEMP_PROJECT, checkReport, precedentPrompt, precedentRoot, summarize } from "./precedent-check.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "precedent-check.mjs");
const QUESTION = "What should the settings page show when someone cancels the GitHub authorization halfway?";
const CODE_EVIDENCE = "packages/integrations/state.ts:42";
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

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
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

test("the brief checks live Asana only and carries every safety rule", () => {
  const prompt = precedentPrompt({ question: QUESTION, codeEvidence: CODE_EVIDENCE, today: new Date("2026-10-16T12:00:00Z") });
  const order = ["1. Asana, in Chrome", "2. If this actor cannot use that signed-in browser"];
  const positions = order.map((line) => prompt.indexOf(line));
  assert.ok(positions.every((position) => position >= 0), "every step is present");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(prompt, new RegExp(`Code/data-model check: ${CODE_EVIDENCE}`));
  assert.match(prompt, /Never use a public help center or documentation page as precedent/);
  for (const rule of [
    "Never sign in, create an account or type a credential.",
    "Never touch anything that already exists",
    `create one new private project named "${TEMP_PROJECT}", with no members and notifications off`,
    `Prefix every task you create with "${TASK_PREFIX}"`,
    "go only as far as its confirmation step, then cancel it",
    "delete every task you created and then the project, check that they are gone",
    "Verify every state before you record it",
    "A hover can look like a completed task",
    "Quote on-screen wording exactly",
    'write "undocumented"; never guess',
    "Source: Asana, observed 2026-10-16 | undocumented",
    "Cleanup:",
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test("the question and code evidence are required", () => {
  assert.throws(() => precedentPrompt({ question: "  " }), /--question/);
  assert.throws(() => precedentPrompt({ question: QUESTION }), /--code-evidence/);
  assert.equal(run(["prompt"]).status, 1);
});

test("prompt mode prints the brief for the Codex orchestrator and starts nothing", () => {
  const { status, json } = run(["prompt", "--question", QUESTION, "--code-evidence", CODE_EVIDENCE, "--situation", "Start connecting GitHub, then cancel"]);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.liveLook, false, "the fallback brief is not a live look");
  assert.match(json.prompt, /Situation to reproduce: Start connecting GitHub, then cancel/);
});

test("run mode starts headless claude with Chrome and only the research tools, the brief on stdin", (t) => {
  const dir = workspace(t);
  const claude = fakeClaude(dir);
  const out = path.join(dir, "out");
  const { status, json } = run(["run", "--question", QUESTION, "--code-evidence", CODE_EVIDENCE, "--claude", claude, "--out", out]);
  assert.equal(status, 0);
  assert.deepEqual(json, {
    ok: true,
    answer: "Returns to the integrations page with nothing connected and no error",
    source: "Asana, observed 2026-10-16",
    sourceKind: "observed",
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
  const base = ["run", "--question", QUESTION, "--code-evidence", CODE_EVIDENCE];
  const failed = run([...base, "--claude", fakeClaude(dir, { code: 1 }), "--out", path.join(dir, "a")]);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.error, /exited 1/);
  const empty = run([...base, "--claude", fakeClaude(dir, { output: "I looked around." }), "--out", path.join(dir, "b")]);
  assert.equal(empty.json.ok, false);
  assert.match(empty.json.error, /no Answer or Source line/);
  const slow = run([...base, "--claude", fakeClaude(dir, { sleep: 5 }), "--out", path.join(dir, "c"), "--timeout-seconds", "1"]);
  assert.equal(slow.json.ok, false);
  assert.match(slow.json.error, /timed out after 1s/);
  const missing = run([...base, "--claude", path.join(dir, "no-claude"), "--out", path.join(dir, "d")]);
  assert.equal(missing.json.ok, false);
  assert.match(missing.json.error, /could not start/);
});

test("the summary reads only the report's Answer and Source lines", () => {
  assert.deepEqual(summarize(REPORT), {
    answer: "Returns to the integrations page with nothing connected and no error",
    source: "Asana, observed 2026-10-16",
    sourceKind: "observed",
  });
  assert.deepEqual(summarize("Answer: undocumented\nSource: undocumented\n"), { answer: "undocumented", source: "undocumented", sourceKind: "none" });
  assert.deepEqual(summarize("Answer: x\nSource: https://help.asana.com/hc/en-us/articles/1\n"), { answer: "x", source: "https://help.asana.com/hc/en-us/articles/1", sourceKind: "public" });
  assert.deepEqual(summarize("nothing"), { answer: null, source: null, sourceKind: "none" });
});

test("without --out the report folder is under the vibe home a reboot keeps, never the temp folder", (t) => {
  const fixture = makeHome("vibe-precedent-home-");
  t.after(fixture.cleanup);
  const claude = fakeClaude(fixture.root);
  const { status, json } = run(["run", "--question", QUESTION, "--code-evidence", CODE_EVIDENCE, "--claude", claude], { ...process.env, HOME: fixture.home });
  assert.equal(status, 0);
  const root = path.join(fixture.home, ".codex", "vibe", "precedent");
  assert.equal(path.dirname(path.dirname(json.report)), root);
  assert.equal(precedentRoot("/Users/someone"), path.join("/Users/someone", ".codex", "vibe", "precedent"));
  assert.ok(!precedentRoot().startsWith(os.tmpdir()));
});

test("check always refuses an undocumented or help-center-only answer until a live look ran", (t) => {
  const dir = workspace(t);
  const write = (name, text) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  const live = write("live.md", REPORT);
  const publicOnly = write("public.md", "Answer: Keeps the list as it was\nSource: https://help.asana.com/hc/en-us/articles/1\n");
  const undocumentedOnline = write("undocumented.md", "Answer: undocumented\nSource: undocumented\n");
  const observedUndocumented = write("observed-undocumented.md", "Answer: undocumented\nSource: Asana, observed 2026-10-21\n");
  assert.deepEqual(run(["check", "--report", live]), { status: 0, json: { ok: true, answer: summarize(REPORT).answer, source: "Asana, observed 2026-10-16", sourceKind: "observed" } });
  for (const file of [publicOnly, undocumentedOnline, observedUndocumented]) {
    const refused = run(["check", "--report", file]);
    assert.equal(refused.status, 1, file);
    assert.equal(refused.json.ok, false);
    assert.match(refused.json.error, /return NEEDS_PERSON to the browser-holder/);
  }
  assert.equal(checkReport("I looked around.").ok, false);
  assert.equal(run(["check"]).status, 1);
});

test("a disputed behavior is a required checklist item: the report must observe it with a screenshot or mark it for the operator", () => {
  const behaviors = ["select a collapsed parent, then run a bulk action: does it reach the hidden children?", "select all with a filter applied"];
  const prompt = precedentPrompt({ question: "Does select-all reach hidden rows?", codeEvidence: CODE_EVIDENCE, behaviors });
  assert.match(prompt, /^B1\. select a collapsed parent/m);
  assert.match(prompt, /^B2\. select all with a filter applied$/m);
  const headline = "Answer: no select-all\nSource: Asana, observed 2026-10-21\n";
  const refused = checkReport(headline, behaviors);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.missing.map((item) => item.id), ["B1", "B2"]);
  const partial = checkReport(`${headline}B1: observed: the action reached all 4 children; screenshot: b1.png\nB2: observed: nothing happened\n`, behaviors);
  assert.deepEqual(partial.missing.map((item) => item.id), ["B2"], "an observation without a screenshot does not settle it");
  const settled = checkReport(`${headline}B1: observed: the action reached all 4 children; screenshot: b1.png\nB2: needs a write to test: only a filter on real tasks shows it\n`, behaviors);
  assert.equal(settled.ok, true);
  assert.equal(checkReport(headline, []).ok, true, "no disputed behaviors, no checklist");
});

test("run saves the disputed behaviors beside the report, and check reads them", (t) => {
  const { root: dir, cleanup } = makeHome("precedent-checklist-");
  t.after(cleanup);
  const claude = path.join(dir, "claude");
  writeFileSync(claude, "#!/bin/sh\ncat >/dev/null\nprintf 'Answer: no select-all\\nSource: Asana, observed 2026-10-21\\n'\n");
  chmodSync(claude, 0o755);
  const out = path.join(dir, "run");
  const ran = spawnSync(process.execPath, [SCRIPT, "run", "--question", "q", "--code-evidence", "src/model.ts:1", "--behavior", "select a collapsed parent", "--out", out, "--claude", claude], { encoding: "utf8" });
  assert.equal(JSON.parse(ran.stdout).ok, true, ran.stdout);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "checklist.json"), "utf8")).behaviors, ["select a collapsed parent"]);
  const checked = spawnSync(process.execPath, [SCRIPT, "check", "--report", path.join(out, "report.md")], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(JSON.parse(checked.stdout).error, /does not settle B1/);
});
