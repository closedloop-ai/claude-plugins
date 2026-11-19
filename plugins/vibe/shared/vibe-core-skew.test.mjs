// The version-skew matrix between the slim vibe-core (hook entry files and a loader) and the vibe whose guards it
// loads, rows 1 to 10 of the slimming plan as ruled: vibe-core never refuses anything for vibe's sake. No vibe, or
// a disabled one, or one that still registers its own hooks: silent stand-down. A vibe it cannot use: the degraded
// notice on the events NOTICE_EVENTS names, silence on the rest, and the action proceeds. A vibe serving a shared
// contract: whatever that vibe's runtime returns.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { recordHookSkill } from "../hooks/hook-session-scope.mjs";
import {
  CORE_CONTRACTS, CORE_SOURCE, CORE_VERSION, ENTRIES, EVENTS, LAYOUTS, Layout, NOTICE_EVENTS, Runtime,
  assertDegraded, assertNeverBlocks, assertServed, assertSilent, copyCore, degradedNotice, machine, mentionsNotice, runEntry,
  tempRoot, unknownContract, vibeLookup, writePlugin,
} from "./vibe-core-skew-test-support.mjs";

const HIGHEST = Math.max(...CORE_CONTRACTS);
const FORCE_PUSH = ["git", "push", "-f", "origin", "fix/x"].join(" ");
const BASH_FORCE_PUSH = { tool_name: "Bash", tool_input: { command: FORCE_PUSH } };

/** The vibe name a layout's install uses: a checkout's plugins/vibe holds vibe-generic. */
function vibeName(layout) {
  return layout === Layout.Checkout ? "vibe-generic" : "vibe";
}

test("the degraded notice is the operator's ruled sentence, verbatim, around the reason", () => {
  assert.equal(degradedNotice("REASON"), "vibe's safety checks couldn't load (REASON), so they're off for now. Your work continues. "
    + "To fix: run `claude plugin update vibe@closedloop-ai` then start a new Claude Code session, or run "
    + "`codex plugin add vibe@closedloop-ai` then quit and reopen the Codex app.");
});

// Operator ruling (final): the degraded notice goes to the agent on UserPromptSubmit only; every other event
// proceeds silently. This pins the set itself; the other tests read NOTICE_EVENTS.
test("the ruled notice set: degraded, the notice appears on UserPromptSubmit and nowhere else", (t) => {
  assert.deepEqual([...NOTICE_EVENTS], ["UserPromptSubmit"]);
  const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.1.80" }]);
  const prompt = m.run("UserPromptSubmit", { prompt: "hello" });
  assertNeverBlocks(prompt);
  const output = JSON.parse(prompt.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(mentionsNotice(output.hookSpecificOutput.additionalContext), prompt.stdout);
  for (const event of ["PreToolUse", "PostToolUse", "SessionStart", "PreCompact"]) {
    const result = m.run(event, BASH_FORCE_PUSH);
    assertNeverBlocks(result, event);
    assert.equal(result.stdout, "", `${event}: no stdout`);
    assert.ok(!mentionsNotice(result.stderr), `${event}: no notice on stderr: ${result.stderr}`);
  }
});

test("NOTICE_EVENTS names only events core's hooks.json registers", () => {
  assert.ok(NOTICE_EVENTS.length > 0);
  for (const event of NOTICE_EVENTS) assert.ok(EVENTS.includes(event), `${event} is registered`);
});

for (const layout of LAYOUTS) {
  test(`row 1 (${layout}): every event round-trips through the served runtime with the highest shared contract`, (t) => {
    const m = machine(t, layout, [{ name: vibeName(layout), version: "1.2.0", runtime: Runtime.marker("served", [...CORE_CONTRACTS, unknownContract()]) }]);
    for (const event of EVENTS) {
      const probe = `${layout}-${event}`;
      const seen = assertServed(m.run(event, { probe }), event, "served", layout);
      assert.equal(seen.probe, probe, "the stdin event reaches runHook");
      assert.deepEqual(seen.core, { root: m.core, version: CORE_VERSION, contract: HIGHEST });
    }
  });
}

test("row 1: a string result prints as plain text, an object as JSON, null as nothing", (t) => {
  const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("served") }]);
  const text = m.run("PreToolUse", { want: "string" });
  assertServed(text, "PreToolUse", "served");
  assert.ok(text.stdout.startsWith("MARKER "), "not JSON-quoted");
  const object = m.run("PreToolUse");
  assert.equal(JSON.parse(object.stdout).hookSpecificOutput.hookEventName, "PreToolUse");
  const nothing = m.run("PreToolUse", { want: "null" });
  assertNeverBlocks(nothing);
  assert.equal(nothing.stdout, "");
});

test("row 1: each entry file prints exactly what runEvent prints for its event", (t) => {
  const m = machine(t, Layout.Checkout, [{ name: "vibe-generic", version: "1.2.0", runtime: Runtime.marker("served") }]);
  const runtime = JSON.stringify(pathToFileURL(path.join(m.core, "hooks", "vibe-runtime.mjs")).href);
  for (const event of EVENTS) {
    const input = JSON.stringify({ session_id: "skew-session", hook_event_name: event, cwd: m.project, probe: event });
    const direct = spawnSync(process.execPath, ["--input-type=module", "-e", `const { runEvent } = await import(${runtime}); await runEvent(${JSON.stringify(event)});`],
      { cwd: m.project, env: { ...process.env, HOME: m.home }, input, encoding: "utf8", timeout: 60_000 });
    const entry = m.run(event, { probe: event });
    assertServed(entry, event, "served");
    assert.deepEqual([direct.status, direct.stdout], [entry.status, entry.stdout], event);
  }
});

test("the lookup is tri-state: absent, found, or unresolved with a reason", (t) => {
  const m = machine(t, Layout.Claude);
  const from = pathToFileURL(path.join(m.core, "shared", "vibe-install.mjs")).href;
  assert.deepEqual(vibeLookup(m.project, from), { absent: true });
  const root = m.add({ name: "vibe", version: "1.2.0", runtime: Runtime.marker("served") });
  const found = vibeLookup(m.project, from);
  assert.equal(found.install?.root, root);
  assert.equal(found.install?.name, "vibe");
  const second = m.add({ name: "vibe", version: "1.3.0" }, { register: false });
  m.register("vibe", [{ scope: "user", installPath: root }, { scope: "user", installPath: second }]);
  const unresolved = vibeLookup(m.project, from);
  assert.equal(typeof unresolved.unresolved, "string");
  assert.notEqual(unresolved.unresolved.trim(), "");
  assert.equal(unresolved.install, undefined);
});

for (const layout of LAYOUTS) {
  test(`row 2 (${layout}): with no vibe installed every hook stands down silently`, (t) => {
    const m = machine(t, layout);
    for (const event of EVENTS) assertSilent(m.run(event, BASH_FORCE_PUSH), `${layout} ${event}`);
  });
}

test("row 3: a vibe disabled in Claude Code's user or project settings stands every hook down", (t) => {
  const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("disabled vibe ran") }]);
  assertServed(m.run("PreToolUse"), "PreToolUse", "disabled vibe ran", "enabled");
  m.enable("vibe", false);
  for (const event of EVENTS) assertSilent(m.run(event), `user settings ${event}`);
  m.enable("vibe", true);
  mkdirSync(path.join(m.project, ".claude"), { recursive: true });
  writeFileSync(path.join(m.project, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": false } }));
  for (const event of EVENTS) assertSilent(m.run(event), `project settings ${event}`);
});

test("row 3: a vibe disabled in Codex's config.toml stands every hook down", (t) => {
  const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("disabled vibe ran") }]);
  m.enable("vibe", false);
  for (const event of EVENTS) assertSilent(m.run(event), event);
  m.enable("vibe", true);
  assertServed(m.run("PreToolUse"), "PreToolUse", "disabled vibe ran", "enabled again");
});

for (const layout of LAYOUTS) {
  test(`row 4 (${layout}): a vibe of 1.1.70 or older that registers its own hooks leaves every event to them`, (t) => {
    const m = machine(t, layout, [{ name: vibeName(layout), version: "1.1.70", ownHooks: true, runtime: Runtime.marker("old vibe's runtime ran") }]);
    for (const event of EVENTS) assertSilent(m.run(event, BASH_FORCE_PUSH), `${layout} ${event}`);
  });
}

for (const layout of LAYOUTS) {
  test(`row 5 (${layout}): a vibe from 1.1.71 to the last pre-slim release (no hooks/runtime.mjs) gets the notice and proceeds`, (t) => {
    const m = machine(t, layout, [{ name: vibeName(layout), version: "1.1.80" }]);
    for (const event of EVENTS) assertDegraded(m.run(event, BASH_FORCE_PUSH), event, layout);
  });
}

test("row 6: a newer vibe that serves no contract this vibe-core speaks gets the notice", (t) => {
  const m = machine(t, Layout.Codex, [{ name: "vibe", version: "9.0.0", runtime: Runtime.marker("unshared contract ran", [unknownContract()]) }]);
  for (const event of EVENTS) assertDegraded(m.run(event), event, "contract");
});

test("row 7: a runtime that throws on import, or has the wrong shape, gets the notice", (t) => {
  for (const [kind, runtime] of [["throws on import", Runtime.throwsOnImport], ["no runHook", Runtime.noRunHook], ["CONTRACTS not a list", Runtime.contractsNotList]]) {
    const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.2.0", runtime }]);
    for (const event of EVENTS) assertDegraded(m.run(event, BASH_FORCE_PUSH), event, kind);
  }
});

test("row 7: a vibe-core outside every plugin layout cannot resolve vibe and says so", (t) => {
  const root = tempRoot(t, "outside");
  const core = copyCore(path.join(root, "elsewhere", "vibe-core"));
  writePlugin(path.join(root, "elsewhere", "vibe"), { name: "vibe-generic", version: "1.2.0" }, { "hooks/runtime.mjs": Runtime.marker("outside ran") });
  const project = path.join(root, "project");
  mkdirSync(project);
  for (const event of EVENTS) {
    const result = runEntry(path.join(core, ENTRIES[event]), { session_id: "skew-session", hook_event_name: event, cwd: project }, { cwd: project, home: root });
    assertDegraded(result, event, "outside layouts");
  }
});

test("row 7: two Claude Code user installs of vibe, or an unreadable plugin registry, get the notice", (t) => {
  const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("served") }]);
  const second = m.add({ name: "vibe", version: "1.3.0", runtime: Runtime.marker("second") }, { register: false });
  m.register("vibe", [{ scope: "user", installPath: m.roots["vibe@1.2.0"] }, { scope: "user", installPath: second }]);
  for (const event of EVENTS) assertDegraded(m.run(event), event, "two user installs");
  writeFileSync(m.registry, "{ \"version\": 2, \"plugins\": ");
  for (const event of EVENTS) assertDegraded(m.run(event), event, "invalid registry JSON");
});

test("row 8: a runHook that rejects or throws gets the notice and the action proceeds", (t) => {
  for (const [kind, runtime] of [["rejects", Runtime.rejects], ["throws", Runtime.throws]]) {
    const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime }]);
    for (const event of EVENTS) assertDegraded(m.run(event, BASH_FORCE_PUSH), event, kind);
  }
});

test("row 9 (Codex): an update mid-session is picked up by the next event, and a half-written one gets the notice", (t) => {
  const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("old") }]);
  assertServed(m.run("PreToolUse"), "PreToolUse", "old");
  m.add({ name: "vibe", version: "1.10.0", runtime: Runtime.marker("new") });
  for (const event of EVENTS) assertServed(m.run(event), event, "new", "after the update");
  const unpacking = path.join(m.cache, "vibe", "1.11.0");
  mkdirSync(path.join(unpacking, "hooks"), { recursive: true });
  writeFileSync(path.join(unpacking, "hooks", "runtime.mjs"), Runtime.marker("unpacking"));
  for (const event of EVENTS) assertDegraded(m.run(event), event, "version folder with no manifest yet");
  rmSync(unpacking, { recursive: true });
  m.add({ name: "vibe", version: "1.12.0" });
  for (const event of EVENTS) assertDegraded(m.run(event), event, "manifest written, runtime not yet");
});

test("row 9 (Claude Code): repointing the registry mid-session switches the next event to the new vibe", (t) => {
  const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("old") }]);
  assertServed(m.run("PreToolUse"), "PreToolUse", "old");
  m.add({ name: "vibe", version: "1.3.0", runtime: Runtime.marker("new") });
  for (const event of EVENTS) assertServed(m.run(event), event, "new", "after the update");
  m.add({ name: "vibe", version: "1.4.0" });
  for (const event of EVENTS) assertDegraded(m.run(event), event, "half-written update");
});

test("row 10 (Claude Code): with vibe and vibe-generic at different ages the first enabled one decides", (t) => {
  const m = machine(t, Layout.Claude, [{ name: "vibe", version: "1.1.80" }, { name: "vibe-generic", version: "1.2.0", runtime: Runtime.marker("generic") }]);
  for (const event of EVENTS) assertDegraded(m.run(event), event, "the pre-slim vibe comes first");
  m.enable("vibe", false);
  for (const event of EVENTS) assertServed(m.run(event), event, "generic", "vibe disabled");
  m.enable("vibe-generic", false);
  for (const event of EVENTS) assertSilent(m.run(event), `both disabled ${event}`);
});

test("row 10 (Codex): a disabled newer vibe is passed over for an enabled pre-slim vibe-generic", (t) => {
  const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("disabled vibe ran") }, { name: "vibe-generic", version: "1.1.80" }]);
  assertServed(m.run("PreToolUse"), "PreToolUse", "disabled vibe ran", "both enabled");
  m.enable("vibe", false);
  for (const event of EVENTS) assertDegraded(m.run(event), event, "vibe-generic decides");
});

test("row 10 (checkout): plugins/vibe (vibe-generic) decides before the built vibe", (t) => {
  const m = machine(t, Layout.Checkout, [{ name: "vibe-generic", version: "1.1.80" }, { name: "vibe", version: "1.2.0", runtime: Runtime.marker("built") }]);
  for (const event of EVENTS) assertDegraded(m.run(event), event, "checkout order");
});

test("the loader never refuses: exit 0 and an explicit JSON object or nothing, in every state, for a force push too", (t) => {
  const states = [
    ["absent", machine(t, Layout.Codex)],
    ["disabled", (() => { const m = machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.marker("x") }]); m.enable("vibe", false); return m; })()],
    ["own hooks", machine(t, Layout.Codex, [{ name: "vibe", version: "1.1.70", ownHooks: true }])],
    ["pre-slim", machine(t, Layout.Codex, [{ name: "vibe", version: "1.1.80" }])],
    ["contract", machine(t, Layout.Codex, [{ name: "vibe", version: "9.0.0", runtime: Runtime.marker("x", [unknownContract()]) }])],
    ["import throws", machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.throwsOnImport }])],
    ["rejects", machine(t, Layout.Codex, [{ name: "vibe", version: "1.2.0", runtime: Runtime.rejects }])],
  ];
  for (const [state, m] of states) {
    for (const event of EVENTS) {
      const result = m.run(event, BASH_FORCE_PUSH);
      assertNeverBlocks(result, `${state} ${event}`);
      const text = result.stdout.trim();
      if (text !== "") assert.equal(typeof JSON.parse(text), "object", `${state} ${event}: a JSON object, not text`);
    }
  }
});

// The fixture runtimes above and the slim loader are both written from the same contract text; this runs the loader
// in this checkout against the real vibe beside it, so drift between the two shows here.
test("the slim loader in this checkout runs this vibe's real runtime: its guards decide, and no notice appears", (t) => {
  const home = tempRoot(t, "real");
  const project = path.join(home, "project");
  mkdirSync(project);
  const run = (event, input = {}) => runEntry(path.join(CORE_SOURCE, ENTRIES[event]),
    { session_id: "real-session", hook_event_name: event, cwd: project, ...input }, { cwd: project, home });
  for (const event of EVENTS) {
    const result = run(event, { prompt: "hello", tool_name: "Bash", tool_input: { command: "ls" } });
    assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    assert.ok(!mentionsNotice(`${result.stdout}${result.stderr}`), `${event}: ${result.stdout}${result.stderr}`);
  }
  // The force-push refusal acts only in a chat that activated vibe, so a deny proves vibe's guard ran.
  recordHookSkill("real-session", "vibe:vibe", home);
  const decided = run("PreToolUse", BASH_FORCE_PUSH);
  assert.equal(decided.status, 0, decided.stderr);
  assert.equal(JSON.parse(decided.stdout).hookSpecificOutput.permissionDecision, "deny", "vibe's own guard, loaded through the loader, refused");
});
