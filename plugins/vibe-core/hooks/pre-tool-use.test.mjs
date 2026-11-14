import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentLaunchProblem } from "./agent-guard.mjs";
import { AWAY_CHECKLIST } from "./away-protocol.mjs";
import { mergeResults, runGuards } from "./hook-dispatch.mjs";
import { killProblems } from "./kill-guard.mjs";
import { TASKSTOP_REMINDER } from "./pause-guard.mjs";
import { MCP_ROUTE, PRE_TOOL_USE_ROUTES, scratchCreationProblem } from "./pre-tool-use.mjs";
import { forcePushProblem } from "./shell-safety-guard.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE_TOOL_USE = path.join(HERE, "pre-tool-use.mjs");
const USER_PROMPT_SUBMIT = path.join(HERE, "user-prompt-submit.mjs");
// Assembled from words so the repository's signal scans, which read test text, never meet a live shape.
const sh = (...words) => words.join(" ");
const BY_NAME_KILL = sh("p" + "kill", "-f", "vitest");
const FORCE_PUSH = sh("git push", "-f", "origin fix/x");

test('raw recognizable scratch Docker creation is refused while reads and wrapped E2E remain available', () => {
  for (const command of ['docker run --name iss-42-postgres postgres:16', 'docker compose -p iss-42-perf up -d',
    'docker run -d --rm --name iss-42-postgres postgres:16',
    'docker run --rm -itd --name iss-42-postgres postgres:16',
    'docker run -dit --rm --name iss-42-postgres postgres:16',
    'docker run --detach --rm --name scratch-db postgres:16',
    'docker container run -d postgres:16', 'docker create --name scratch-db alpine',
    'docker compose run postgres', 'docker compose create seed', 'docker-compose -p iss-7 up -d']) {
    assert.match(scratchCreationProblem(command, 'vibe') ?? '', /registered scratch/i, command);
  }
  assert.match(scratchCreationProblem('node helpers.mjs scratch-run; docker run --name iss-42-postgres postgres:16', 'vibe') ?? '',
    /registered scratch/, 'a wrapper name elsewhere in the command cannot bypass the raw start');
  for (const command of ['docker ps', 'docker volume inspect data', 'node helpers.mjs scratch-run --ticket ticket-one',
    'node e2e-lock.mjs run --head abc e2e/run-containerized.sh',
    'docker run --rm alpine /tmp/iss-42/postgres --version',
    'docker run --rm postgres:16 psql --version',
    'docker run -d --name postgres16 -e POSTGRES_USER=postgres -p 5432:5432 postgres:16',
    'docker run --env-file .env.seed --rm node:24 true',
    'docker compose -f /tmp/iss-42/postgres.yml up -d app']) {
    assert.equal(scratchCreationProblem(command, 'vibe'), null, command);
  }
  assert.equal(scratchCreationProblem('docker run --name iss-42-postgres postgres:16', null), null);
  assert.equal(scratchCreationProblem("cat <<'EOF'\ndocker run --name iss-42-postgres postgres:16\nEOF", 'vibe'), null,
    'heredoc body is data, not a Docker invocation');
  assert.match(scratchCreationProblem("cat <<EOF\n$(docker run --name iss-42-postgres postgres:16)\nEOF", 'vibe') ?? '',
    /registered scratch/, 'an unquoted heredoc still executes command substitutions');
  for (const command of ["# <<EOF\ndocker run --name iss-42-postgres postgres:16",
    "echo $((1 << 2)); docker run --name iss-42-postgres postgres:16",
    "docker</dev/null run --name iss-42-postgres postgres:16"]) {
    assert.match(scratchCreationProblem(command, 'vibe') ?? '', /registered scratch/, command);
  }
  for (const command of ["cat <<\\EOF\ndocker run --name iss-42-postgres postgres:16\nEOF",
    "cat <<E\"OF\"\ndocker run --name iss-42-postgres postgres:16\nEOF"]) {
    assert.equal(scratchCreationProblem(command, 'vibe'), null, command);
  }
});

test('the routed Bash hook denies scratch creation only in an active vibe conversation', (t) => {
  const { dir, run } = sandbox(t);
  recordHookSkill('scratch-session', 'vibe:vibe', dir);
  const event = (session_id) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id,
    tool_input: { command: 'docker run --name iss-42-postgres postgres:16' } });
  const scoped = run(PRE_TOOL_USE, event('scratch-session'));
  assert.equal(JSON.parse(scoped.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(scoped.stdout, /registered scratch stack/);
  assert.equal(run(PRE_TOOL_USE, event('unrelated-session')).stdout, '');
});

/** The exact line one old guard script printed for a decision. */
const line = (hookSpecificOutput) => `${JSON.stringify({ hookSpecificOutput })}\n`;
const denyLine = (reason) => line({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason });
const killReason = (command) => `Signal only processes this session started and recorded: ${killProblems(command, () => false).join("; ")}`;

// The guards below run only in a chat that activated vibe (operator ruling, 2026-11-11; activation.mjs), so
// each payload without its own session comes from one that loaded vibe:vibe. activation.test.mjs covers the
// chat that never did.
const ACTIVATED_SESSION = "vibe-chat";

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-pre-tool-use-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordHookSkill(ACTIVATED_SESSION, "vibe:vibe", dir);
  const env = { ...process.env, HOME: dir, MERGE_GUARD_GH: path.join(dir, "missing-gh") };
  const withSession = (payload) => (typeof payload === "string" || payload.session_id ? payload : { session_id: ACTIVATED_SESSION, ...payload });
  const run = (script, payload) => {
    const input = withSession(payload);
    return spawnSync(process.execPath, [script], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env });
  };
  return { dir, run };
}

test("each tool's payload yields the exact stdout and exit code its old guard script printed", (t) => {
  const { dir, run } = sandbox(t);
  const bash = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: FORCE_PUSH } });
  assert.deepEqual([bash.status, bash.stdout, bash.stderr], [0, denyLine(forcePushProblem(FORCE_PUSH)), ""]);

  const worker = "vibe:vibe-change-worker";
  const agent = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Agent", cwd: dir, tool_input: { subagent_type: worker, prompt: "go" } });
  assert.deepEqual([agent.status, agent.stdout, agent.stderr], [0, denyLine(agentLaunchProblem({ subagent_type: worker })), ""]);

  const message = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "SendMessage", cwd: dir, tool_input: { to: "w", message: "HOLD everything" } });
  assert.deepEqual([message.status, message.stdout, message.stderr], [0, line({ hookEventName: "PreToolUse", additionalContext: TASKSTOP_REMINDER }), ""]);

  const prompt = run(USER_PROMPT_SUBMIT, { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "stepping away. brb." });
  assert.deepEqual([prompt.status, prompt.stdout, prompt.stderr], [0, line({ hookEventName: "UserPromptSubmit", additionalContext: AWAY_CHECKLIST }), ""]);
});

test("tools with no guard, and calls no guard refuses, print nothing", (t) => {
  const { dir, run } = sandbox(t);
  for (const payload of [
    { tool_name: "Read", cwd: dir, tool_input: { file_path: "x" } },
    { tool_name: "constructor", cwd: dir, tool_input: {} },
    { tool_name: "Bash", cwd: dir, tool_input: { command: "git status" } },
    { tool_name: "Agent", cwd: dir, tool_input: { subagent_type: "general-purpose" } },
    { tool_name: "SendMessage", cwd: dir, tool_input: { to: "w", message: "Push nothing more." } },
  ]) {
    const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", ...payload });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], payload.tool_name);
  }
  const prompt = run(USER_PROMPT_SUBMIT, { hook_event_name: "UserPromptSubmit", prompt: "go back to the PR" });
  assert.deepEqual([prompt.status, prompt.stdout], [0, ""]);
});

test("two guards refusing one command give one deny carrying both reasons in guard order", (t) => {
  const { dir, run } = sandbox(t);
  const command = `${BY_NAME_KILL} && ${FORCE_PUSH}`;
  const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command } });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, denyLine(`${killReason(command)}\n${forcePushProblem(command)}`), ""]);
});

test("a throwing guard is reported under its name and the others still decide", (t) => {
  const { dir, run } = sandbox(t);
  const command = `gh pr merge 9169 --auto && ${FORCE_PUSH}`;
  const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, denyLine(forcePushProblem(command)));
  assert.match(result.stderr, /^merge-guard: /);
  const alone = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: "gh pr merge 9169 --auto" } });
  assert.deepEqual([alone.status, alone.stdout], [0, ""], "a guard that cannot answer fails open, as its own script did");
});

test("unreadable stdin fails open with the script named on stderr", (t) => {
  const { run } = sandbox(t);
  for (const [script, name] of [[PRE_TOOL_USE, "pre-tool-use"], [USER_PROMPT_SUBMIT, "user-prompt-submit"]]) {
    const result = run(script, "{not json");
    assert.deepEqual([result.status, result.stdout], [0, ""]);
    assert.match(result.stderr, new RegExp(`^${name}: `));
  }
});

test("results merge as deny > defer > ask > allow and keep every context", () => {
  assert.equal(mergeResults("PreToolUse", []), null);
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "allow", reason: "a" }, { decision: "ask", reason: "b" }, { decision: "defer" }]).hookSpecificOutput,
    { hookEventName: "PreToolUse", permissionDecision: "defer" });
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "ask", reason: "b" }, { context: "one" }, { decision: "deny", reason: "c" }, { context: "two" }, { decision: "deny", reason: "d" }]).hookSpecificOutput,
    { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "c\nd", additionalContext: "one\n\ntwo" });
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "allow", reason: "a" }, { decision: "ask", reason: "b" }]).hookSpecificOutput.permissionDecisionReason, "b");
  assert.deepEqual(mergeResults("PostToolUse", [{ systemMessage: "one" }, { context: "c", systemMessage: "two" }]),
    { systemMessage: "one\ntwo", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "c" } });
});

test("hooks.json registers one command per event, and the PreToolUse matcher names exactly the routed tools", () => {
  const { hooks } = JSON.parse(readFileSync(path.join(HERE, "hooks.json"), "utf8"));
  const commands = (event) => hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "UserPromptSubmit"]);
  assert.deepEqual(commands("PreToolUse"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"']);
  assert.deepEqual(commands("PostToolUse"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use.mjs"']);
  assert.equal(hooks.PostToolUse[0].matcher, undefined, "the context guard measures after every tool call");
  assert.deepEqual(commands("PreCompact"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-compact.mjs"']);
  assert.equal(hooks.PreCompact[0].matcher, undefined, "manual and automatic compactions both get the instructions");
  assert.deepEqual(commands("UserPromptSubmit"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs"']);
  assert.deepEqual(commands("SessionStart"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"']);
  assert.equal(hooks.SessionStart[0].matcher, "compact");
  assert.deepEqual(hooks.PreToolUse[0].matcher.split("|").sort(), [...Object.keys(PRE_TOOL_USE_ROUTES), "mcp__.*"].sort(),
    "every routed tool, and every MCP tool for the rules a bound provider supplies");
});

// Codex (0.164) loads a plugin's hooks/hooks.json by default, sets CLAUDE_PLUGIN_ROOT, and reports its shell
// and exec_command tools as Bash with tool_input.command (Codex hooks docs). An audit took the manifest's missing
// `hooks` field to mean the guards never load in Codex (2026-10-27); this pins what they rely on there.
test("the Codex hook path: default hooks.json location, CLAUDE_PLUGIN_ROOT commands, and Codex's Bash payload is refused", (t) => {
  const pluginRoot = path.join(HERE, "..");
  const codexManifest = JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(codexManifest.hooks, undefined, "a hooks override would move Codex off hooks/hooks.json and re-key its trust");
  const { hooks } = JSON.parse(readFileSync(path.join(HERE, "hooks.json"), "utf8"));
  for (const entry of Object.values(hooks).flat()) {
    for (const hook of entry.hooks) assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.mjs"$/);
  }
  const codexEvent = {
    session_id: "01a17e08-330d-7d80-8afa-6b01adb56fbf", turn_id: "turn-1", transcript_path: null, cwd: tmpdir(),
    hook_event_name: "PreToolUse", model: "gpt-6-sol", permission_mode: "default",
    tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: FORCE_PUSH },
  };
  const { dir } = sandbox(t);
  recordHookSkill(codexEvent.session_id, "vibe:vibe", dir);
  const result = spawnSync(process.execPath, [PRE_TOOL_USE], { input: JSON.stringify(codexEvent), encoding: "utf8", env: { ...process.env, HOME: dir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

/** A git checkout whose vibe session record binds a provider that is no longer installed. */
function brokenSession(t) {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-broken-provider-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", worktree]);
  writeFileSync(path.join(worktree, ".git", "vibe-session.json"), JSON.stringify({ worktree, branch: "vibe/broken",
    provider: { state: "bound", name: "acme-provider", root: path.join(worktree, "gone"), capabilities: ["tickets", "recipes"] } }));
  return worktree;
}

test("a guard whose bound provider is broken refuses the action it guards, with the reason and fix, and only warns on others", (t) => {
  const cwd = brokenSession(t);
  const run = (route, event) => mergeResults("PreToolUse", runGuards(route, { cwd, ...event }, () => {}, () => true));
  const write = run(MCP_ROUTE, { tool_name: "mcp__tracker__update-document", tool_input: { documentId: "ISS-1", status: "DONE" } });
  assert.equal(write.hookSpecificOutput.permissionDecision, "deny", "the generic default (no status rule) would relax the bound rule");
  assert.match(write.hookSpecificOutput.permissionDecisionReason, /unit-status-guard cannot read its bound provider rule.*no longer installed.*Fix: reinstall or update the acme-provider plugin/);
  assert.match(write.systemMessage, /^vibe unit-status-guard: provider-broken: /);
  const read = run(MCP_ROUTE, { tool_name: "mcp__tracker__get-document-comments", tool_input: { documentId: "ISS-1", status: "OPEN" } });
  assert.equal(read.hookSpecificOutput.permissionDecision, undefined, "a read that filters by status is not the guarded write");
  assert.match(read.systemMessage, /provider-broken: .*no longer installed/);

  const bash = PRE_TOOL_USE_ROUTES.Bash.filter((guard) => guard.name === "shell-safety-guard");
  const e2e = run(bash, { tool_name: "Bash", tool_input: { command: "~/vibe-remote/e2e-slot.sh run-tests ISS-1" } });
  assert.equal(e2e.hookSpecificOutput.permissionDecision, "deny", "the slot wrapper's rule cannot be read, so an e2e script is refused");
  assert.match(e2e.hookSpecificOutput.permissionDecisionReason, /Fix: reinstall or update the acme-provider plugin/);
  for (const command of ["grep -n e2e-slot.sh scripts/run.sh", "cat ~/vibe-remote/e2e-slot.sh", "node scripts/check.mjs --spec e2e/home.spec.ts"]) {
    assert.equal(run(bash, { tool_name: "Bash", tool_input: { command } }).hookSpecificOutput.permissionDecision, undefined,
      `${command}: an e2e name in an argument or a path is not the executed script`);
  }
  const plain = run(bash, { tool_name: "Bash", tool_input: { command: "ls -la" } });
  assert.equal(plain.hookSpecificOutput.permissionDecision, undefined);
  assert.match(plain.systemMessage, /^vibe shell-safety-guard: provider-broken: /);
  const forced = run(bash, { tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
  assert.equal(forced.hookSpecificOutput.permissionDecision, "deny", "the generic checks still run first");
  assert.equal(forced.systemMessage, undefined);
});
