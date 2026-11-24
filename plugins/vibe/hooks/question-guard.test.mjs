import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { codeCitationProblem, isVersionQuestion, questionGuard } from "./question-guard.mjs";
import { startupFile } from "../lib/vibe/scripts/startup-record.mjs";
import { startupFile as startupQuestions } from "../skills/vibe/scripts/session-questions.mjs";

const PRE_TOOL_USE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");
const BACKUP = "Some files in your copy are not part of this work. May I move them to a backup folder so the pull request can be made?";

test("AC 13 chat preflight and tool delivery cite earlier rulings and record an uncovered fact", t => {
  const question = "Does cloud testing satisfy the local lane rule?";
  const file = transcript(t, fleetSkill, recorded(question));
  const home = path.dirname(file);
  execFileSync("git", ["init", "-q", home]);
  const program = path.join(home, "programs", "fleet");
  mkdirSync(program, { recursive: true });
  const directory = path.join(home, ".vibe-hook-scope", "fleet-binding");
  mkdirSync(directory, { recursive: true });
  const chat = "ruling-test";
  writeFileSync(path.join(directory, chat + ".json"), JSON.stringify({ chat, home, program: "fleet" }));
  const dates = ["2026-11-18", "2026-11-19"];
  const lines = [
    "- Ruling (Operator, chat 2026-11-18): Yes, use proof branches for cloud validation of the non-eval lanes.",
    "- Ruling (Operator, chat 2026-11-18): Tests wait for the slot or go to cloud/laptop 2.",
    "- Ruling (Operator, chat 2026-11-19): Use cloud workers for lanes when heavy slots refuse on load.",
  ];
  writeFileSync(path.join(program, "rulings.md"), lines.join("\n"));
  writeFileSync(path.join(home, "product.md"), "Labels\n");
  const recorder = fileURLToPath(new URL("../skills/vibe/scripts/session-questions.mjs", import.meta.url));
  const run = (key, words, ...extra) => JSON.parse(spawnSync(process.execPath, [recorder, "ask", "--product", "--code-evidence", "product.md:1",
    "--key", key, "--question", words, "--default", "Keep the current choice", "--deadline-minutes", "5", ...extra],
    { cwd: home, env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: chat, CODEX_THREAD_ID: chat }, encoding: "utf8" }).stdout);
  const blocked = run("validation", question);
  assert.equal(blocked.ask, false);
  assert.deepEqual(blocked.rulings, lines);
  const refused = ask(file, question, "AskUserQuestion", { home, cwd: home, sessionId: chat });
  for (const date of dates) assert.ok(refused.reason.includes(date));
  const emptyFact = run("empty", question, "--new-fact", "a new fact");
  assert.equal(emptyFact.ask, false);
  const mismatchedFact = run("unseen", question, "--new-fact", "The contract requires offline execution");
  assert.equal(mismatchedFact.ask, false);
  const newQuestion = "Which label should appear on the welcome card?";
  assert.equal(run("welcome", newQuestion).ask, true);
  assert.equal(ask(transcriptWith(newQuestion), newQuestion, "request_user_input", { home, cwd: home, sessionId: chat }), null);
  const fact = "The new customer contract requires offline execution";
  const changed = fact + ". " + question;
  assert.equal(run("offline", changed, "--new-fact", fact).ask, true);
  assert.equal(ask(transcriptWith(changed), changed, "AskUserQuestion", { home, cwd: home, sessionId: chat }), null);
  const saved = JSON.parse(readFileSync(startupQuestions(home), "utf8")).questions.find(entry => entry.key === "offline");
  assert.equal(saved.newFact, fact);
  assert.deepEqual(saved.rulings, lines);
  const ticketRecord = path.join(home, "tracker.json");
  const ticketWords = "Should the welcome card show a legal disclaimer?";
  const ticketLine = "- Ruling 2026-11-17 (operator): Include the legal disclaimer on the welcome card; amends: AC 1.";
  writeFileSync(ticketRecord, JSON.stringify({ slug: "TASK-9", latestVersion: 1, version: { version: 1, content: ticketLine } }));
  assert.deepEqual(run("disclaimer", ticketWords, "--ticket-record", ticketRecord).rulings, [ticketLine]);
  function transcriptWith(words) { return transcript(t, fleetSkill, recorded(words)); }
});

test("DT-04–06 AC-5/7 a PM gets product choices and no test evidence or local paths", (t) => {
  const person = { type: "user", message: { content: "I'm the PM, I'll review the design." } };
  const product = "Which wording should the button use?";
  const technical = "Are the integration test results sufficient to merge?";
  for (const tool_name of ["AskUserQuestion", "request_user_input", "request_user_input_async"]) {
    const call = (question, options = []) => {
      const source = transcript(t, vibeSkill, person, recorded(question));
      const result = spawnSync(process.execPath, [PRE_TOOL_USE], { encoding: "utf8", env: { ...process.env, HOME: path.dirname(source) },
        input: JSON.stringify({ tool_name, cwd: path.dirname(source), transcript_path: source,
          tool_input: { questions: [tool_name === "request_user_input_async"
            ? { title: question, options: options.map(option => option.description ?? option.label) }
            : { question, options }] } }) });
      assert.equal(result.status, 0);
      return result.stdout;
    };
    assert.match(call(technical), /technical or test-evidence/i);
    assert.match(call("Does that screenshot provide enough proof?"), /technical or test-evidence/i);
    assert.match(call(product, [{ label: "Open", description: "Check file:\/\/\/tmp\/capture.png" }]), /local filesystem path/i);
    assert.equal(call(product), "");
    assert.equal(call(product, [{ label: "API keys" }]), "");
    assert.equal(call('Should we label the button "API keys" or "Access keys"?'), "");
    assert.match(call(product, [{ label: "docs/guides/setup.md" }]), /local filesystem path/i);
    assert.equal(call(product, [{ label: "Open the preview", description: "https://example.com/design/button" }]), "");
  }
});

function transcript(t, ...entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-question-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return file;
}
const vibeSkill = { type: "user", message: { content: "Base directory for this skill: /cache/vibe/1.0.85/skills/vibe" } };
const fleetSkill = { type: "user", message: { content: "Base directory for this skill: /cache/vibe/1.0.85/skills/fleet-orchestrator" } };
const recorded = (question) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash",
  input: { command: `node scripts/session-questions.mjs ask --key backup --question "${question}" --default "leave them" --deadline-minutes 30` } }] } });
const ask = (file, question, toolName = "AskUserQuestion", state = {}) => questionGuard({ tool_name: toolName, transcript_path: file,
  ...(state.sessionId ? { session_id: state.sessionId } : {}),
  cwd: state.cwd ?? (file && path.dirname(file)),
  tool_input: { questions: [{ question, header: "Files", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } }, state.home ?? (file && path.dirname(file)));

/** Save the existing session-questions record, keeping its code citation out of the question tool. */
function privateCitation(t, question, codeEvidence, skills = [fleetSkill]) {
  const file = transcript(t, ...skills, recorded(question));
  const target = startupQuestions(path.dirname(file));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ questions: [{ question, product: true, codeEvidence }] }));
  return file;
}

test("F09/F10 startup-recorded product choice and private technical fork in an operator worktree", t => {
  const product = "Which wording should the button use?";
  const source = transcript(t, fleetSkill, recorded(product));
  const home = path.dirname(source);
  const cwd = path.join(home, "worktree");
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(path.join(cwd, "copy.md"), "Button\n");
  writeFileSync(path.join(cwd, ".git", "vibe-session.json"), JSON.stringify({ operator: { id: "pm" }, questions: [] }));
  const recorder = fileURLToPath(new URL("../skills/vibe/scripts/session-questions.mjs", import.meta.url));
  execFileSync(process.execPath, [recorder, "ask", "--product", "--code-evidence", "copy.md:1", "--key", "wording",
    "--question", product, "--default", "Save", "--deadline-minutes", "5"], { cwd, env: { ...process.env, HOME: home } });
  assert.equal(ask(source, product, "AskUserQuestion", { cwd, home }), null);
  writeFileSync(path.join(cwd, ".git", "vibe-spec-card.json"), JSON.stringify({ openQuestions: [{ kind: "technical-fork", question: product }] }));
  assert.match(ask(source, product, "AskUserQuestion", { cwd, home }).reason, /technical or test-evidence/);
});
function versionState(t, status = "outdated", choice) {
  const home = mkdtempSync(path.join(tmpdir(), "version-question-state-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionId = "version-question-session";
  const file = startupFile(sessionId, home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ conversation: sessionId, status, ...(choice ? { choice } : {}) }));
  return { home, sessionId };
}

// A vibe session asked the person about their own files without session-questions.mjs (2026-10-26).
test("in a vibe session a question reaches the person only after session-questions.mjs recorded it", (t) => {
  const version = versionState(t);
  assert.equal(ask(transcript(t, vibeSkill), BACKUP)?.decision, "deny");
  assert.match(ask(transcript(t, vibeSkill), BACKUP).reason, /session-questions\.mjs ask/);
  assert.equal(ask(transcript(t, vibeSkill, recorded(BACKUP)), BACKUP), null);
  assert.equal(ask(transcript(t, vibeSkill, recorded("Which words should the page use?")), BACKUP)?.decision, "deny", "another question's record does not count");
  assert.equal(ask(transcript(t, vibeSkill), BACKUP, "request_user_input")?.decision, "deny", "the Codex question tool is held to the same path");
  assert.equal(ask(transcript(t, vibeSkill), "A newer version of vibe is available (vibe: you have 1.0.85, the latest is 1.1.0). Do you want me to update it now, or keep going with this one? Keeping going with an older version could give worse results.", "AskUserQuestion", version), null,
    "the startup version question runs once per conversation outside session-questions.mjs");
  assert.equal(ask(transcript(t, fleetSkill), "A newer version of the plugins is available (vibe: you have 1.0.85, the latest is 1.1.0). Update now, or proceed on this version? Proceeding on an outdated plugin could give worse results.", "AskUserQuestion", version), null,
    "the fleet startup version question is about the install, so it names no code");
  assert.equal(ask(transcript(t, fleetSkill), BACKUP)?.decision, "deny", "every other orchestrator question still names the code");
});

test("startup version questions accept paraphrases without inventing code citations", (t) => {
  const version = "The vibe plugin has an update available. Update now or continue with this version?";
  const state = versionState(t);
  assert.equal(isVersionQuestion(version), true);
  assert.equal(ask(transcript(t, fleetSkill), version, "AskUserQuestion", state), null);
  assert.equal(ask(transcript(t, vibeSkill), version, "AskUserQuestion", state), null);
  assert.equal(ask(transcript(t, fleetSkill), version)?.decision, "deny", "wording alone grants no exception");
  assert.equal(ask(transcript(t, fleetSkill), version, "AskUserQuestion", versionState(t, "pending"))?.decision, "deny");
  assert.equal(ask(transcript(t, fleetSkill), version, "AskUserQuestion", versionState(t, "outdated", "proceed"))?.decision, "deny");
  assert.equal(isVersionQuestion("Should the app update the plugin version shown on this screen?"), false);
  assert.equal(ask(transcript(t, fleetSkill), "Should the app update the plugin version shown on this screen?")?.decision, "deny");
});

test("an orchestrator's question to the operator names where it checked the code", (t) => {
  const file = transcript(t, fleetSkill);
  assert.equal(ask(file, "The installed commit helper stages all files and has no ownership-exclusion option. Move them?")?.decision, "deny");
  assert.match(ask(file, "Move them?").reason, /code-evidence/);
  assert.match(ask(file, "The commit helper stages every file (checked in code: plugins/vibe/skills/vibe/scripts/commit-worktree.mjs:73). Move them?").reason, /local filesystem path/);
});

test("AC-020 a choice to split related delivery carries its own costs and recommends folding", (t) => {
  const file = transcript(t, fleetSkill);
  const cwd = path.dirname(file);
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(path.join(cwd, "surface.ts"), "export const shared = true;\n");
  const checked = "Both changes use one surface. Where should these ship?";
  const folded = { label: "Fold into the open unit (Recommended)", description: "Keep the shared tests together." };
  const separate = { label: "File a separate ticket", description: "This adds its own test lanes, CI, reviews and merge-queue time." };
  const one = (options, question = checked, tool_name = "AskUserQuestion") => {
    const source = privateCitation(t, question, "surface.ts:1");
    return questionGuard({ tool_name, cwd, transcript_path: source, tool_input: { questions: [{ question, options }] } }, path.dirname(source));
  };

  assert.equal(one([folded, separate]), null);
  assert.match(one([folded, { ...separate, description: "Keep the work independent." }])?.reason ?? "", /test lanes, CI, reviews and merge-queue time/);
  assert.match(one([{ ...folded, label: "Fold into the open unit" }, { ...separate, label: "Separate ticket (Recommended)" }])?.reason ?? "", /recommend folding/);
  assert.match(one([{ ...folded, description: "This grows that PR's scope and test surface." }, separate])?.reason ?? "", /bloat or scope growth/);
  assert.match(one([folded, { ...separate, description: "This adds test lanes, CI, and reviews." }], checked, "request_user_input")?.reason ?? "", /merge-queue time/);
  assert.equal(one([{ ...folded, label: "Fold into the open unit" }, { ...separate, label: "Separate ticket (Recommended)" }],
    "The export is unrelated to the active unit because it runs on an independent command."), null);
});

test("a code citation must point at a real regular line in the event repository", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "question-citation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(path.join(dir, "source.ts"), "first\nsecond\n");
  const cited = (reference) => `May I change this? checked in code: ${reference}`;
  assert.equal(codeCitationProblem(cited("source.ts:2"), dir), null);
  const check = ref => ask(privateCitation(t, "May I change this?", ref), "May I change this?", "AskUserQuestion", { cwd: dir });
  assert.equal(check("source.ts:2"), null);
  for (const reference of ["source.ts:3", "missing.ts:1", "../outside.ts:1", ".:1"]) {
    assert.equal(check(reference)?.decision, "deny", reference);
  }
});

// PR #371 review: an orchestrator whose cwd is not a repository, or that cites a writer's
// worktree, was refused although the cited line was real.
test("an absolute citation is checked in its own repository, wherever the hook runs", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "question-citation-elsewhere-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const writer = path.join(base, "writer-worktree");
  const orchestration = path.join(base, "handoffs");
  const outside = path.join(base, "loose.ts");
  mkdirSync(orchestration);
  execFileSync("git", ["init", "-q", writer]);
  writeFileSync(path.join(writer, "source.ts"), "first\nsecond\n");
  writeFileSync(outside, "first\n");
  const other = path.join(base, "other-repo");
  execFileSync("git", ["init", "-q", other]);
  const check = (reference, cwd) => ask(privateCitation(t, "May I change this?", reference),
    "May I change this?", "AskUserQuestion", { cwd });
  for (const cwd of [orchestration, other]) {
    assert.equal(check(`${path.join(writer, "source.ts")}:2`, cwd), null, cwd);
    for (const reference of [`${path.join(writer, "source.ts")}:3`, `${path.join(writer, "missing.ts")}:1`, `${outside}:1`, `${writer}:1`, `${path.join(writer, ".git", "HEAD")}:1`]) {
      assert.equal(check(reference, cwd)?.decision, "deny", `${cwd}: ${reference}`);
    }
  }
  assert.equal(check("source.ts:1", orchestration)?.decision, "deny", "a relative path outside any repository has nothing to resolve against");
});

test("other sessions and tools are untouched, and the PreToolUse hook routes the question tools", (t) => {
  assert.equal(ask(transcript(t, { type: "user", message: { content: "fix the table" } }), BACKUP), null);
  assert.equal(ask(undefined, BACKUP), null);
  for (const tool of ["AskUserQuestion", "request_user_input"]) {
    assert.ok(PRE_TOOL_USE_ROUTES[tool].some((guard) => guard.run === questionGuard), tool);
  }
  const result = spawnSync(process.execPath, [PRE_TOOL_USE], { encoding: "utf8",
    input: JSON.stringify({ tool_name: "AskUserQuestion", transcript_path: transcript(t, vibeSkill), tool_input: { questions: [{ question: BACKUP }] } }) });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

// PR #350 review: a Read or a listing of skills/vibe/SKILL.md made any session a vibe session.
test("only a real skill load decides the rule, never a mention of the skill's files", (t) => {
  const read = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/plugins/vibe/skills/vibe/SKILL.md" } }] } };
  const listing = { type: "user", message: { content: "/repo/plugins/vibe/skills/vibe/SKILL.md\n/repo/plugins/vibe/skills/fleet-orchestrator/SKILL.md\n" } };
  assert.equal(ask(transcript(t, read, listing), BACKUP), null);
  const codexVibe = { type: "response_item", payload: { content: "<skill>\n<name>vibe:vibe</name>\n<path>/cache/vibe/1.1.0/skills/vibe/SKILL.md</path>" } };
  assert.equal(ask(transcript(t, codexVibe), BACKUP)?.decision, "deny", "Codex's injected skill block is a load");
  const toolCall = { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vibe:fleet-orchestrator" } }] } };
  assert.match(ask(transcript(t, toolCall), BACKUP).reason, /checked in code/, "a Skill tool call is a load");
});

// PR #350 review: vibe was checked first, so an orchestrator that read vibe's files was held to vibe's rule.
test("the skill loaded last decides, in either order", (t) => {
  const cited = "Which wording should we use?";
  const source = privateCitation(t, cited, import.meta.filename + ":1", [vibeSkill, fleetSkill]);
  assert.equal(ask(source, cited), null, "fleet loaded last: a privately cited question passes");
  assert.match(ask(transcript(t, vibeSkill, fleetSkill), BACKUP).reason, /checked in code/);
  assert.match(ask(transcript(t, fleetSkill, vibeSkill), cited).reason, /session-questions\.mjs ask/, "vibe loaded last: vibe's rule");
});
