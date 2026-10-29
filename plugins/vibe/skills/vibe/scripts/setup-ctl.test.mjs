import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_FIXES, classifyChecks, CLAUDE_SIGN_IN_WORDS, createSetupCtl, DESKTOP_UNAVAILABLE, folderAccessWords, freePort, parsePreflight, Status, STORYBOOK_PORTS,
} from "./setup-ctl.mjs";

const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const bad = (stderr = "boom", status = 1) => ({ status, stdout: "", stderr });
const line = (check, okFlag, detail, fix) => JSON.stringify({ check, ok: okFlag, detail, fix });

function router(routes, calls = []) {
  return (command, args, options) => {
    const text = [command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    calls.push({ line: text, options });
    for (const [matcher, result] of routes) {
      if (text.includes(matcher)) return typeof result === "function" ? result(text) : result;
    }
    return bad(`no route for ${text}`, 127);
  };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}

test("preflight lines are parsed and every failed check is classified by its fix, never guessed", () => {
  const checks = parsePreflight([
    line("node", true, "24", ""), "not json", line("pnpm", false, "not installed", "install-pnpm"),
    line("claude-login", false, "signed out", "claude-auth-login"), line("repo", false, "a|b", "choose-repo"),
    line("gh", false, "no", "gh-auth-login"), line("odd", false, "?", "something-new"),
    line("closedloop-core", false, "missing", "codex plugin add closedloop-core@closedloop-ai"),
  ].join("\n"));
  const plan = classifyChecks(checks);
  assert.deepEqual(plan.auto.map((item) => item.fix), ["install-pnpm"]);
  assert.deepEqual(plan.needsPerson.map((item) => item.fix), ["claude-auth-login"]);
  assert.deepEqual(plan.blocked.map((item) => item.fix), ["choose-repo", "codex plugin add closedloop-core@closedloop-ai"]);
  assert.deepEqual(plan.delegated.map((item) => item.fix), ["gh-auth-login"]);
  assert.deepEqual(plan.unknown.map((item) => item.fix), ["something-new"]);
});

test("a person's exit carries only the sentence preflight.md writes; one with no written sentence has message null and a reference", () => {
  const plan = classifyChecks([
    { check: "claude-login", ok: false, detail: "x", fix: "claude-auth-login" },
    { check: "folders", ok: false, detail: "Documents", fix: "allow-folder-access" },
    { check: "git", ok: false, detail: "no", fix: "install-xcode-clt" },
  ]);
  assert.equal(plan.needsPerson[0].message, CLAUDE_SIGN_IN_WORDS);
  assert.equal(plan.needsPerson[1].message, folderAccessWords("Documents"));
  assert.equal(plan.needsPerson[2].message, null);
  assert.match(plan.needsPerson[2].reference, /install-xcode-clt/);
});

test("without --apply the preflight fix only reports; with it only the no-person fixes run, then the preflight runs again", () => {
  const calls = [];
  let preflightRuns = 0;
  const ctl = createSetupCtl({
    run: router([
      ["vibe-preflight.sh", () => { preflightRuns += 1; return ok(preflightRuns === 1 ? [line("pnpm", false, "no", "install-pnpm"), line("claude-login", false, "out", "claude-auth-login")].join("\n") : line("claude-login", false, "out", "claude-auth-login")); }],
      ["corepack enable", ok("")],
    ], calls),
  });
  const dry = ctl.preflightFix({ runtime: "claude" });
  assert.equal(dry.status, Status.NeedsPerson);
  assert.deepEqual(dry.applied, []);
  assert.deepEqual(dry.auto.map((item) => item.fix), ["install-pnpm"]);
  assert.ok(!calls.some((call) => call.line.includes("corepack")));
  preflightRuns = 0;
  const applied = ctl.preflightFix({ runtime: "claude", apply: true, prototype: true });
  assert.deepEqual(applied.applied, [{ fix: "install-pnpm", command: AUTO_FIXES["install-pnpm"].display, ok: true }]);
  assert.equal(applied.status, Status.NeedsPerson);
  assert.equal(applied.needsPerson[0].message, CLAUDE_SIGN_IN_WORDS);
  assert.deepEqual(applied.auto, []);
  assert.equal(preflightRuns, 2);
  assert.ok(calls.some((call) => call.line.includes("vibe-preflight.sh --runtime claude --prototype")));
});

test("a clean preflight is OK and a preflight that printed nothing is BLOCKED, never OK", () => {
  assert.equal(createSetupCtl({ run: router([["vibe-preflight.sh", ok(line("node", true, "24", ""))]]) }).preflightFix({}).status, Status.Ok);
  assert.equal(createSetupCtl({ run: router([["vibe-preflight.sh", ok("")]]) }).preflightFix({}).status, Status.Blocked);
});

test("a fix that fails is reported with its output and the check stays unresolved", () => {
  const ctl = createSetupCtl({ run: router([["vibe-preflight.sh", ok(line("jq", false, "no", "brew-install-jq"))], ["brew install jq", bad("brew: not found")]]) });
  const result = ctl.preflightFix({ apply: true });
  assert.equal(result.applied[0].ok, false);
  assert.match(result.applied[0].evidenceTail, /brew: not found/);
  assert.equal(result.status, Status.NeedsAgent);
});

test("bootstrap runs loops-setup.sh bounded in the worktree: OK, NEEDS_AGENT with output on failure, BLOCKED on time out or no script", () => {
  const calls = [];
  const present = (result) => createSetupCtl({ run: router([["run-bounded.mjs 1800 ./.closedloop-ai/loops-setup.sh", result]], calls), exists: () => true });
  assert.equal(present(ok()).bootstrap({ worktree: "/wt" }).status, Status.Ok);
  assert.equal(calls[0].options.cwd, "/wt");
  const failed = present(bad("missing DATABASE_URL")).bootstrap({ worktree: "/wt" });
  assert.equal(failed.status, Status.NeedsAgent);
  assert.match(failed.evidenceTail, /DATABASE_URL/);
  assert.equal(present(bad("", 124)).bootstrap({ worktree: "/wt" }).status, Status.Blocked);
  assert.equal(createSetupCtl({ run: router([]), exists: () => false }).bootstrap({ worktree: "/wt" }).status, Status.Blocked);
});

test("a free port is the first in the range that answers free, null when none", async () => {
  assert.equal(await freePort(async (port) => port >= 6103), 6103);
  assert.equal(await freePort(async () => false), null);
  assert.equal(await freePort(async () => true), STORYBOOK_PORTS.first);
});

function storybookCtl({ record, probes = {}, logs = "Local: http://localhost:6100", alive = () => true, extra = [] }) {
  const calls = [];
  const detached = [];
  const ctl = createSetupCtl({
    run: router([
      ["vibe-sessions.mjs show", ok({ ok: true, session: record })],
      ["rev-parse --absolute-git-dir", ok("/gd\n")],
      ["vibe-sessions.mjs touch", ok({ ok: true })],
      ...extra,
    ], calls),
    ...clock(),
    isPortFree: async (port) => port === 6100,
    detach: (command, args, options) => { detached.push({ command, args, options }); return 4242; },
    probe: async (url) => probes[url] ?? false,
    alive,
    exists: () => true,
    readFile: () => logs,
  });
  return { ctl, calls, detached };
}

test("a Storybook that is alive and answers is reused, never started a second time", async () => {
  const { ctl, detached } = storybookCtl({ record: { stack: { storybookUrl: "http://localhost:6101", storybookPid: 9 } }, probes: { "http://localhost:6101": true } });
  assert.deepEqual(await ctl.storybook({ worktree: "/wt" }), { status: Status.Ok, reused: true, url: "http://localhost:6101" });
  assert.equal(detached.length, 0);
});

test("a stale recorded Storybook is replaced: started on the first free port, recorded with the rest of the stack kept", async () => {
  const { ctl, detached, calls } = storybookCtl({
    record: { stack: { storybookUrl: "http://localhost:6101", storybookPid: 9, desktopPid: 77 } }, alive: () => false, probes: { "http://localhost:6100": true },
  });
  const result = await ctl.storybook({ worktree: "/wt" });
  assert.deepEqual(result, { status: Status.Ok, reused: false, url: "http://localhost:6100", pid: 4242 });
  assert.deepEqual(detached[0].args, ["--filter", "storybook", "exec", "storybook", "dev", "-p", "6100", "--ci", "--no-open"]);
  assert.equal(detached[0].options.logFile, "/gd/vibe-storybook.log");
  const touch = calls.find((call) => call.line.includes("vibe-sessions.mjs touch")).line;
  assert.match(touch, /"desktopPid":77/);
  assert.match(touch, /"storybookPid":4242/);
});

test("a Storybook that never answers is BLOCKED with the log tail and records nothing", async () => {
  const { ctl, calls } = storybookCtl({ record: {}, probes: {}, logs: "compiling\nError: port in use" });
  const result = await ctl.storybook({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.match(result.evidenceTail, /port in use/);
  assert.ok(!calls.some((call) => call.line.includes("vibe-sessions.mjs touch")));
});

test("desktop profile: prepare, the claim line saved through desktop-auth, then the next step named", () => {
  const written = {};
  const calls = [];
  const ctl = createSetupCtl({
    run: router([
      ["rev-parse --absolute-git-dir", ok("/gd\n")],
      ["vibe:profile prepare", ok("prepared")],
      ["vibe:profile auth-claim", ok("noise\n{\"refreshTokenHash\":\"h\",\"publicKeySpki\":\"k\",\"gatewayId\":\"g\"}\n")],
      ["desktop-auth", ok({ ok: true })],
    ], calls),
    ...clock(), writeFile: (file, text) => { written[file] = text; },
  });
  const result = ctl.desktopProfile({ worktree: "/wt" });
  assert.equal(result.status, Status.Ok);
  assert.match(result.next, /desktop mode/);
  assert.equal(JSON.parse(written["/gd/vibe-desktop-auth-claim.json"]).gatewayId, "g");
  assert.ok(calls.some((call) => call.line.includes("--out /gd/vibe-desktop-profile")));
});

test("desktop profile failures are BLOCKED with the code the worker returns", () => {
  const ctl = createSetupCtl({ run: router([["rev-parse --absolute-git-dir", ok("/gd\n")], ["vibe:profile prepare", bad("electron missing")]]), ...clock() });
  const result = ctl.desktopProfile({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.code, DESKTOP_UNAVAILABLE);
});

function launchCtl({ tab = { ok: true, running: false }, signIn = ok(), log = "Desktop window visible", extra = [] } = {}) {
  const calls = [];
  const detached = [];
  const ctl = createSetupCtl({
    run: router([
      ["desktop-tab", ok(tab)],
      ["vibe-sessions.mjs show", ok({ ok: true, session: { vercel: { apiUrl: "https://api.example", appUrl: "https://app.example" } } })],
      ["rev-parse --absolute-git-dir", ok("/gd\n")],
      ["vibe:profile sign-in", signIn],
      ["desktop-launched", ok({ ok: true })],
      ...extra,
    ], calls),
    ...clock(), detach: (command, args, options) => { detached.push({ args, options }); return 555; }, alive: () => true, exists: () => true, readFile: () => log,
  });
  return { ctl, calls, detached };
}

test("a running Desktop is never started a second time", async () => {
  const { ctl, detached } = launchCtl({ tab: { ok: true, running: true } });
  assert.deepEqual(await ctl.desktopLaunch({ worktree: "/wt" }), { status: Status.Ok, reused: true });
  assert.equal(detached.length, 0);
});

test("launch signs the profile in, starts it detached against the recorded origins and records the launch", async () => {
  const { ctl, detached, calls } = launchCtl();
  const result = await ctl.desktopLaunch({ worktree: "/wt" });
  assert.deepEqual(result, { status: Status.Ok, reused: false, pid: 555 });
  assert.deepEqual(detached[0].args, ["--filter", "desktop", "vibe:profile", "launch", "--profile", "/gd/vibe-desktop-profile", "--api-origin", "https://api.example", "--web-origin", "https://app.example"]);
  assert.equal(detached[0].options.logFile, "/gd/vibe-desktop.log");
  assert.ok(calls.some((call) => call.line.includes("desktop-launched") && call.line.includes("--pid 555")));
});

test("a profile that is already signed in goes on to launch; any other sign-in failure is BLOCKED and starts nothing", async () => {
  const already = launchCtl({ signIn: bad("profile is already signed in") });
  assert.equal((await already.ctl.desktopLaunch({ worktree: "/wt" })).status, Status.Ok);
  const refused = launchCtl({ signIn: bad("401 unauthorized") });
  const result = await refused.ctl.desktopLaunch({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.code, DESKTOP_UNAVAILABLE);
  assert.equal(refused.detached.length, 0);
});

test("a Desktop whose log never shows its window is BLOCKED with the log tail and is not recorded", async () => {
  const { ctl, calls } = launchCtl({ log: "starting\nError: renderer crashed" });
  const result = await ctl.desktopLaunch({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.match(result.evidenceTail, /renderer crashed/);
  assert.ok(!calls.some((call) => call.line.includes("desktop-launched")));
});

test("stop is the sessions script's own stop, never a signal by hand", () => {
  const calls = [];
  const ctl = createSetupCtl({ run: router([["vibe-sessions.mjs stop", ok({ ok: true, stopped: ["storybook"] })]], calls) });
  assert.deepEqual(ctl.stop({ worktree: "/wt" }), { status: Status.Ok, stopped: ["storybook"] });
  assert.ok(!calls.some((call) => /kill|pkill/.test(call.line)));
});

test("discard without --confirmed deletes nothing; with it, it stops first and runs from the retained checkout, never from the target", () => {
  const calls = [];
  const ctl = createSetupCtl({
    run: router([
      ["vibe-sessions.mjs repo", ok({ ok: true, repo: "/retained" })],
      ["vibe-sessions.mjs stop", ok({ ok: true })],
      ["discard --worktree /target --confirm", ok({ ok: true, discarded: true, cancelEvidence: { ticket: "ISS-1" } })],
      ["vibe-sessions.mjs discard --worktree /target", ok({ ok: true, wouldLose: ["x"] })],
    ], calls),
  });
  const preview = ctl.discard({ worktree: "/target", confirmed: false });
  assert.equal(preview.confirmed, false);
  assert.ok(!calls.some((call) => call.line.includes("--confirm")));
  const done = ctl.discard({ worktree: "/target", confirmed: true });
  assert.deepEqual(done, { status: Status.Ok, discarded: true, cancelEvidence: { ticket: "ISS-1" } });
  const discardCall = calls.find((call) => call.line.includes("discard --worktree /target --confirm"));
  assert.equal(discardCall.options.cwd, "/retained");
  assert.ok(calls.findIndex((call) => call.line.includes("vibe-sessions.mjs stop")) < calls.indexOf(discardCall));
});

test("discard refuses when the retained checkout is the target, and a discard that did not complete is BLOCKED", () => {
  const same = createSetupCtl({ run: router([["vibe-sessions.mjs repo", ok({ ok: true, repo: "/target/inner" })]]) });
  assert.equal(same.discard({ worktree: "/target", confirmed: true }).status, Status.Blocked);
  const partial = createSetupCtl({ run: router([["vibe-sessions.mjs repo", ok({ ok: true, repo: "/r" })], ["vibe-sessions.mjs stop", ok({ ok: true })], ["--confirm", ok({ ok: false, error: "push refused" })]]) });
  const result = partial.discard({ worktree: "/target", confirmed: true });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.error, "push refused");
});
