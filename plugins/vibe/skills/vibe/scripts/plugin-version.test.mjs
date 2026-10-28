import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { blockingProblem, compareVersions, markPending, updateCommands, versionsText } from "./plugin-version.mjs";
import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-version.mjs");
// Nothing listens here, so the check can never reach a real marketplace.
const UNREACHABLE = "http://127.0.0.1:9";
const CONVERSATION = "conversation-1";
// Only system tools: a real claude or codex on the developer's PATH must never be found.
const SYSTEM_PATH = ["/usr/bin", "/bin"].join(path.delimiter);

/** A main branch whose marketplace files list `plugins` ({name: version}) under ./plugins/<name>. */
function mainFiles(plugins) {
  const files = {
    "/.claude-plugin/marketplace.json": JSON.stringify({ name: "closedloop-ai", plugins: Object.keys(plugins).map((name) => ({ name, source: `./plugins/${name}` })) }),
    "/.agents/plugins/marketplace.json": JSON.stringify({ name: "closedloop-ai", plugins: Object.keys(plugins).map((name) => ({ name, source: { source: "local", path: `./plugins/${name}` } })) }),
  };
  for (const [name, version] of Object.entries(plugins)) {
    for (const dir of [".claude-plugin", ".codex-plugin"]) files[`/plugins/${name}/${dir}/plugin.json`] = JSON.stringify({ name, version });
  }
  return files;
}

/** A local stand-in for main that answers from `files`, or with `status`, or never. */
async function marketplace(t, { files = {}, status, hang = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (hang) return;
    const body = files[request.url];
    response.writeHead(status ?? (body === undefined ? 404 : 200), { "content-type": "application/json" });
    response.end(body ?? "Not Found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/**
 * A fake `claude` or `codex` CLI backed by a JSON state file: `installed` ({name, version}),
 * `main` (the versions a refreshed marketplace offers), `fail` (an argv prefix that exits 1)
 * and `stuck` (an update that changes nothing). Every call is appended to `calls`.
 */
function fakeCli(dir, kind, state) {
  const stateFile = path.join(dir, `${kind}-state.json`);
  writeFileSync(stateFile, JSON.stringify({ calls: [], refreshed: false, ...state }));
  const file = path.join(dir, kind);
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const a = process.argv.slice(2);
const line = a.join(" ");
s.calls.push(line);
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s));
if (s.fail && line.startsWith(s.fail)) { save(); process.stderr.write("boom: " + line + "\\n"); process.exit(1); }
const kind = ${JSON.stringify(kind)};
const refresh = (name) => { const p = s.installed.find((x) => x.name === name); if (p && s.refreshed && !s.stuck) p.version = s.main[name]; };
const localVersion = (name) => JSON.parse(fs.readFileSync(s.root + "/plugins/" + name + "/.codex-plugin/plugin.json", "utf8")).version;
if (line === "plugin list --json") {
  if (kind === "claude") process.stdout.write(JSON.stringify(s.installed.map((p) => ({ id: p.name + "@" + (p.market ?? "closedloop-ai"), version: p.version, scope: "user", enabled: p.enabled !== false }))));
  else process.stdout.write(JSON.stringify({ installed: s.installed.map((p) => ({ pluginId: p.name + "@" + (p.market ?? "closedloop-ai"), name: p.name, marketplaceName: p.market ?? "closedloop-ai", version: p.version, installed: true, enabled: p.enabled !== false, marketplaceSource: s.root ? { sourceType: "local", source: s.root } : { sourceType: "git", source: "https://example.invalid/claude-plugins.git" } })), available: [] }));
} else if (line === "plugin marketplace update closedloop-ai" || line === "plugin marketplace upgrade closedloop-ai") {
  s.refreshed = true;
} else if (kind === "claude" && a[0] === "plugin" && a[1] === "update") {
  refresh(a[2].split("@")[0]);
} else if (kind === "codex" && a[0] === "plugin" && a[1] === "add") {
  const name = a[2].split("@")[0];
  if (s.root) { const p = s.installed.find((x) => x.name === name); p.version = localVersion(name); } else refresh(name);
} else { save(); process.exit(2); }
save();
`);
  chmodSync(file, 0o755);
  return { file, state: () => JSON.parse(readFileSync(stateFile, "utf8")) };
}

function sandbox(t) {
  const fixture = makeHome("vibe-plugin-version-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  return { ...fixture, bin };
}

function run(home, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: SYSTEM_PATH, HOME: home, CLAUDE_CODE_SESSION_ID: CONVERSATION, CODEX_THREAD_ID: "", ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, result: JSON.parse(stdout) }));
  });
}

const startup = (home) => JSON.parse(readFileSync(path.join(home, ".codex", "vibe", "plugin-version", `${CONVERSATION}.json`), "utf8"));
const both = (claude, codex, url) => ["--claude", claude.file, "--codex", codex.file, "--latest-base", url];

test("versions compare numerically and anything else is not comparable", () => {
  assert.equal(compareVersions("1.0.52", "1.0.53"), -1);
  assert.equal(compareVersions("1.0.53", "1.0.53"), 0);
  assert.equal(compareVersions("1.0.100", "1.0.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
  assert.equal(compareVersions("1.0.52", undefined), null);
});

test("every closedloop-ai plugin in both harnesses is compared with main, and the result is recorded for the conversation", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53", "closedloop-core": "1.5.3" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }, { name: "closedloop-core", version: "1.5.3" }, { name: "context7", version: "1", market: "other" }] });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }] });
  const { code, result } = await run(home, ["check", ...both(claude, codex, main.url)]);
  assert.equal(code, 0);
  assert.equal(result.status, "outdated");
  assert.deepEqual(result.outdated, [
    { harness: "claude", plugin: "vibe", installed: "1.0.52", latest: "1.0.53" },
    { harness: "codex", plugin: "vibe", installed: "1.0.52", latest: "1.0.53" },
  ]);
  assert.equal(result.versions, "vibe: you have 1.0.52, the latest is 1.0.53");
  assert.deepEqual(result.harnesses.map((entry) => [entry.harness, entry.installed, entry.plugins.map((plugin) => `${plugin.name}=${plugin.status}`)]), [
    ["claude", true, ["vibe=outdated", "closedloop-core=current"]],
    ["codex", true, ["vibe=outdated"]],
  ]);
  assert.equal(startup(home).status, "outdated");
  assert.ok(main.requests.includes("/plugins/vibe/.claude-plugin/plugin.json"));
  assert.ok(main.requests.includes("/plugins/vibe/.codex-plugin/plugin.json"));
  assert.ok(!claude.state().calls.some((call) => call.includes("update")), "a check never updates");
});

test("a harness whose CLI is missing, or lists no closedloop-ai plugin, is reported as not installed and never touched", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.53" }] });
  const codexOnly = await run(home, ["check", "--codex", codex.file, "--latest-base", main.url]);
  assert.equal(codexOnly.result.status, "current");
  assert.deepEqual(codexOnly.result.harnesses[0], { harness: "claude", installed: false });

  const claude = fakeCli(bin, "claude", { installed: [{ name: "context7", version: "1", market: "other" }] });
  const unrelated = await run(home, ["check", ...both(claude, codex, main.url)]);
  assert.deepEqual(unrelated.result.harnesses[0], { harness: "claude", cli: claude.file, installed: false });

  // Found on PATH with no flag at all.
  const onPath = await run(home, ["check", "--latest-base", main.url], { PATH: [bin, SYSTEM_PATH].join(path.delimiter) });
  assert.deepEqual(onPath.result.harnesses.map((entry) => [entry.harness, entry.cli]), [["claude", claude.file], ["codex", codex.file]]);

  const none = await run(home, ["check", "--latest-base", main.url]);
  assert.equal(none.result.status, "unknown");
  assert.match(none.result.reason, /no closedloop-ai plugin is installed in Claude Code or Codex/);
});

test("an unreachable, failing, slow or garbled main is unknown and never fails the session", async (t) => {
  const { home, bin } = sandbox(t);
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }] });
  const notFound = await marketplace(t, { status: 404 });
  const garbled = await marketplace(t, { files: { "/.claude-plugin/marketplace.json": "<html>" } });
  const missingPlugin = await marketplace(t, { files: mainFiles({ "closedloop-core": "1.5.3" }) });
  const unversioned = await marketplace(t, { files: { ...mainFiles({ vibe: "1.0.53" }), "/plugins/vibe/.claude-plugin/plugin.json": JSON.stringify({ name: "vibe" }) } });
  const slow = await marketplace(t, { hang: true });
  for (const [url, reason] of [
    [UNREACHABLE, /could not be reached/],
    [notFound.url, /answered 404/],
    [garbled.url, /not JSON/],
    [missingPlugin.url, /vibe is not in the marketplace on main/],
    [unversioned.url, /cannot compare 1\.0\.52 with undefined/],
  ]) {
    const { code, result } = await run(home, ["check", "--claude", claude.file, "--latest-base", url]);
    assert.equal(code, 0);
    assert.equal(result.status, "unknown", url);
    assert.match(result.reason, reason);
    assert.deepEqual(result.outdated, []);
  }
  const started = await run(home, ["check", "--claude", claude.file, "--latest-base", slow.url, "--timeout-ms", "200"]);
  assert.equal(started.code, 0);
  assert.equal(started.result.status, "unknown");
  assert.match(started.result.reason, /could not be reached/);
});

test("a CLI that cannot list its plugins makes that harness unknown while the other is still checked", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [], fail: "plugin list" });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }] });
  const { code, result } = await run(home, ["check", ...both(claude, codex, main.url)]);
  assert.equal(code, 0);
  assert.equal(result.status, "outdated");
  assert.match(result.reason, /claude: claude plugin list failed: boom/);
});

test("update refuses until the person chose it, and proceed records that they accepted worse results", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }], main: { vibe: "1.0.53" } });
  const early = await run(home, ["choose", "--choice", "update"]);
  assert.equal(early.code, 1);
  assert.match(early.result.error, /nothing to choose: the recorded check is missing/);
  await run(home, ["check", "--claude", claude.file, "--latest-base", main.url]);
  const unchosen = await run(home, ["update", "--claude", claude.file]);
  assert.equal(unchosen.code, 1);
  assert.match(unchosen.result.error, /has not chosen to update/);
  const proceed = await run(home, ["choose", "--choice", "proceed"]);
  assert.equal(proceed.code, 0);
  assert.deepEqual({ ...startup(home).choice, at: undefined }, { choice: "proceed", by: "person", acceptedWorseResults: true, at: undefined });
  const afterProceed = await run(home, ["update", "--claude", claude.file]);
  assert.equal(afterProceed.code, 1);
  assert.deepEqual(claude.state().calls, ["plugin list --json"], "nothing but the check's listing ran");
  const bad = await run(home, ["choose", "--choice", "maybe"]);
  assert.equal(bad.code, 1);
});

test("checking again in the same conversation keeps the answer for the same versions; a new conversation or version asks again", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }] });
  await run(home, ["check", "--claude", claude.file, "--latest-base", main.url]);
  await run(home, ["choose", "--choice", "proceed"]);
  const again = await run(home, ["check", "--claude", claude.file, "--latest-base", main.url]);
  assert.equal(again.result.choice.choice, "proceed");
  assert.equal(startup(home).choice.choice, "proceed");
  const program = path.join(home, "program.json");
  await run(home, ["check", "--state", program, "--claude", claude.file, "--latest-base", main.url]);
  await run(home, ["choose", "--choice", "proceed", "--state", program]);
  const newChat = await run(home, ["check", "--state", program, "--claude", claude.file, "--latest-base", main.url], { CLAUDE_CODE_SESSION_ID: "conversation-2" });
  assert.equal(newChat.result.choice, undefined, "a new chat on the same program is asked again");
  const newer = await marketplace(t, { files: mainFiles({ vibe: "1.0.54" }) });
  const moved = await run(home, ["check", "--claude", claude.file, "--latest-base", newer.url]);
  assert.equal(moved.result.choice, undefined, "a newer release is asked about again");
});

test("a current check leaves nothing to choose or update", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.54" }] });
  assert.equal((await run(home, ["check", "--claude", claude.file, "--latest-base", main.url])).result.status, "current");
  assert.match((await run(home, ["choose", "--choice", "update"])).result.error, /the recorded check is current/);
});

test("a chosen update updates each outdated plugin in each installed harness, verifies it and names the restarts", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53", "closedloop-core": "1.5.3" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }, { name: "closedloop-core", version: "1.5.3" }], main: { vibe: "1.0.53", "closedloop-core": "1.5.3" } });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }, { name: "closedloop-core", version: "1.5.2" }], main: { vibe: "1.0.53", "closedloop-core": "1.5.3" } });
  await run(home, ["check", ...both(claude, codex, main.url)]);
  await run(home, ["choose", "--choice", "update"]);
  const { code, result } = await run(home, ["update", "--claude", claude.file, "--codex", codex.file]);
  assert.equal(code, 0);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.restart, ["claude", "codex"]);
  assert.deepEqual(result.plugins.map((plugin) => `${plugin.harness} ${plugin.plugin} ${plugin.before}->${plugin.after} ${plugin.status}`), [
    "claude vibe 1.0.52->1.0.53 updated",
    "codex vibe 1.0.52->1.0.53 updated",
    "codex closedloop-core 1.5.2->1.5.3 updated",
  ]);
  assert.deepEqual(claude.state().calls.slice(1), [
    "plugin marketplace update closedloop-ai",
    "plugin update vibe@closedloop-ai --scope user",
    "plugin list --json",
  ]);
  assert.deepEqual(codex.state().calls.slice(1), [
    "plugin marketplace upgrade closedloop-ai",
    "plugin add vibe@closedloop-ai",
    "plugin add closedloop-core@closedloop-ai",
    "plugin list --json",
  ]);
  assert.equal(startup(home).update.status, "updated");
});

test("an update only touches the harness that is outdated", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.53" }] });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }], main: { vibe: "1.0.53" } });
  await run(home, ["check", ...both(claude, codex, main.url)]);
  await run(home, ["choose", "--choice", "update"]);
  const { result } = await run(home, ["update", "--claude", claude.file, "--codex", codex.file]);
  assert.deepEqual(result.restart, ["codex"]);
  assert.deepEqual(claude.state().calls, ["plugin list --json"]);
});

test("an update that fails or leaves a plugin behind is reported as failed with its reason", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53", "closedloop-core": "1.5.3" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }, { name: "closedloop-core", version: "1.5.2" }], main: { vibe: "1.0.53", "closedloop-core": "1.5.3" }, fail: "plugin update vibe" });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }], main: { vibe: "1.0.53" }, stuck: true });
  await run(home, ["check", ...both(claude, codex, main.url)]);
  await run(home, ["choose", "--choice", "update"]);
  const { code, result } = await run(home, ["update", "--claude", claude.file, "--codex", codex.file]);
  assert.equal(code, 1);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.plugins.map((plugin) => [plugin.harness, plugin.plugin, plugin.status]), [
    ["claude", "vibe", "not-updated"],
    ["claude", "closedloop-core", "not-updated"],
    ["codex", "vibe", "not-updated"],
  ]);
  assert.match(result.plugins[0].reason, /plugin update vibe@closedloop-ai failed: boom/);
  assert.ok(!claude.state().calls.includes("plugin update closedloop-core@closedloop-ai --scope user"), "a harness stops at its first failed command");
  assert.match(result.plugins[2].reason, /still 1\.0\.52 after the update/);
  assert.deepEqual(result.restart, []);
});

test("a Codex local folder marketplace is pulled instead of upgraded", async (t) => {
  const { root, home, bin } = sandbox(t);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  const upstream = path.join(root, "upstream");
  const manifest = (dir) => path.join(dir, "plugins", "vibe", ".codex-plugin", "plugin.json");
  mkdirSync(path.dirname(manifest(upstream)), { recursive: true });
  writeFileSync(manifest(upstream), JSON.stringify({ version: "1.0.52" }));
  git(root, "init", "--quiet", "--initial-branch=main", upstream);
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "old");
  const checkout = path.join(root, "My plugins", "claude-plugins");
  git(root, "clone", "--quiet", upstream, checkout);
  writeFileSync(manifest(upstream), JSON.stringify({ version: "1.0.53" }));
  git(upstream, "commit", "--quiet", "-am", "new");
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }], root: checkout });
  await run(home, ["check", "--codex", codex.file, "--latest-base", main.url]);
  await run(home, ["choose", "--choice", "update"]);
  const { code, result } = await run(home, ["update", "--codex", codex.file]);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.commands[0], `git -C '${checkout}' pull --ff-only`);
  assert.equal(JSON.parse(readFileSync(manifest(checkout), "utf8")).version, "1.0.53");
  assert.deepEqual(codex.state().calls.slice(1), ["plugin add vibe@closedloop-ai", "plugin list --json"]);
});

// PR #350 review: a local marketplace is often someone's own checkout on a feature branch.
test("a Codex local marketplace on another branch, or with uncommitted changes, is left alone and the update fails naming it", async (t) => {
  const { root, home, bin } = sandbox(t);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const upstream = path.join(root, "upstream");
  const manifest = (dir) => path.join(dir, "plugins", "vibe", ".codex-plugin", "plugin.json");
  mkdirSync(path.dirname(manifest(upstream)), { recursive: true });
  writeFileSync(manifest(upstream), JSON.stringify({ version: "1.0.52" }));
  git(root, "init", "--quiet", "--initial-branch=main", upstream);
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "old");
  const checkout = path.join(root, "claude-plugins");
  git(root, "clone", "--quiet", upstream, checkout);
  writeFileSync(manifest(upstream), JSON.stringify({ version: "1.0.53" }));
  git(upstream, "commit", "--quiet", "-am", "new");
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const update = async () => {
    const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.0.52" }], root: checkout });
    await run(home, ["check", "--codex", codex.file, "--latest-base", main.url]);
    await run(home, ["choose", "--choice", "update"]);
    return { codex, ...(await run(home, ["update", "--codex", codex.file])) };
  };
  git(checkout, "checkout", "--quiet", "-b", "feat/my-work");
  const onBranch = await update();
  assert.equal(onBranch.code, 1);
  assert.match(onBranch.result.plugins[0].reason, new RegExp(`${checkout.replaceAll("/", "\\/")} is on feat/my-work, not main; it was left alone`));
  assert.equal(git(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "feat/my-work");
  assert.equal(JSON.parse(readFileSync(manifest(checkout), "utf8")).version, "1.0.52", "the feature branch was not moved");
  assert.deepEqual(onBranch.codex.state().calls.slice(1), ["plugin list --json"], "nothing was installed");
  git(checkout, "checkout", "--quiet", "main");
  writeFileSync(path.join(checkout, "notes.txt"), "mine\n");
  const dirty = await update();
  assert.equal(dirty.code, 1);
  assert.match(dirty.result.plugins[0].reason, /has uncommitted changes; it was left alone/);
  assert.equal(JSON.parse(readFileSync(manifest(checkout), "utf8")).version, "1.0.52");
});

test("a disabled plugin is not checked or updated", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53", code: "2.0.3" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.53" }, { name: "code", version: "2.0.1", enabled: false }] });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "code", version: "2.0.1", enabled: false }] });
  const { result } = await run(home, ["check", ...both(claude, codex, main.url)]);
  assert.equal(result.status, "current");
  assert.deepEqual(result.harnesses.map((entry) => [entry.harness, entry.installed, (entry.plugins ?? []).map((plugin) => plugin.name)]), [["claude", true, ["vibe"]], ["codex", false, []]]);
});

test("a fleet program's state file and a vibe session record hold the result, mirrored for the hooks", async (t) => {
  const { root, home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }] });
  const program = path.join(root, "program", "plugin-version.json");
  await run(home, ["check", "--state", program, "--claude", claude.file, "--latest-base", main.url]);
  await run(home, ["choose", "--choice", "proceed", "--state", program]);
  assert.equal(JSON.parse(readFileSync(program, "utf8")).choice.choice, "proceed");
  assert.equal(startup(home).choice.choice, "proceed");

  const worktree = path.join(root, "worktree");
  execFileSync("git", ["init", "--quiet", worktree]);
  writeSessionRecord(worktree, { slug: "s" });
  await run(home, ["check", "--worktree", worktree, "--claude", claude.file, "--latest-base", main.url]);
  await run(home, ["choose", "--choice", "proceed", "--by", "opening-message", "--worktree", worktree]);
  const record = readSessionRecord(worktree);
  assert.equal(record.slug, "s");
  assert.equal(record.pluginVersion.status, "outdated");
  assert.equal(record.pluginVersion.choice.by, "opening-message");
});

test("adopt moves the conversation's record onto a new session and refuses one nobody answered", async (t) => {
  const { root, home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.0.53" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "vibe", version: "1.0.52" }] });
  const worktree = path.join(root, "worktree");
  execFileSync("git", ["init", "--quiet", worktree]);
  writeSessionRecord(worktree, { slug: "s" });
  const nothing = await run(home, ["adopt", "--worktree", worktree]);
  assert.deepEqual(nothing.result, { ok: true, pluginVersion: null });
  await run(home, ["check", "--claude", claude.file, "--latest-base", main.url]);
  const refused = await run(home, ["adopt", "--worktree", worktree]);
  assert.equal(refused.code, 1);
  assert.match(refused.result.error, /has not chosen to update or to proceed/);
  assert.equal(readSessionRecord(worktree).pluginVersion, undefined);
  await run(home, ["choose", "--choice", "proceed"]);
  const adopted = await run(home, ["adopt", "--worktree", worktree]);
  assert.equal(adopted.code, 0);
  assert.equal(readSessionRecord(worktree).pluginVersion.choice.choice, "proceed");
});

test("a started session is pending until the check runs, and a later start keeps what was recorded", async (t) => {
  const { home } = sandbox(t);
  const pending = markPending(CONVERSATION, home);
  assert.equal(pending.status, "pending");
  assert.match(blockingProblem(pending), /has not run/);
  writeFileSync(path.join(home, ".codex", "vibe", "plugin-version", `${CONVERSATION}.json`), JSON.stringify({ status: "outdated", versions: "vibe: x", choice: { choice: "proceed" } }));
  assert.equal(markPending(CONVERSATION, home).choice.choice, "proceed");
  assert.equal(blockingProblem({ status: "outdated", versions: "vibe: x" }), "plugins are outdated (vibe: x) and the person has not chosen to update or to proceed");
  assert.equal(blockingProblem({ status: "unknown" }), null);
  assert.equal(blockingProblem(null), null);
  const cli = await run(home, ["pending", "--conversation", "other-conversation"]);
  assert.equal(cli.result.status, "pending");
  assert.ok(existsSync(path.join(home, ".codex", "vibe", "plugin-version", "other-conversation.json")));
  assert.throws(() => markPending("../escape", home), /invalid conversation id/);
});

test("versions are listed once per plugin and update commands keep paths with spaces whole", () => {
  assert.equal(versionsText([
    { plugin: "vibe", installed: "1.0.52", latest: "1.0.53" },
    { plugin: "vibe", installed: "1.0.52", latest: "1.0.53" },
    { plugin: "closedloop-core", installed: "1.5.2", latest: "1.5.3" },
  ]), "vibe: you have 1.0.52, the latest is 1.0.53; closedloop-core: you have 1.5.2, the latest is 1.5.3");
  assert.deepEqual(updateCommands("codex", "/Applications/My Apps/codex", [{ name: "vibe", marketplace: { type: "git" } }]), [
    ["/Applications/My Apps/codex", "plugin", "marketplace", "upgrade", "closedloop-ai"],
    ["/Applications/My Apps/codex", "plugin", "add", "vibe@closedloop-ai"],
  ]);
  assert.deepEqual(updateCommands("claude", "claude", []), []);
});

test("the setup check block lists closedloop-core and vibe per installed harness and both connections, once per conversation", async (t) => {
  const { home, bin } = sandbox(t);
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.1.2", "closedloop-core": "1.5.3", code: "2.0.2" }) });
  const claude = fakeCli(bin, "claude", { installed: [{ name: "closedloop-core", version: "1.5.3" }, { name: "vibe", version: "1.1.2" }] });
  const codex = fakeCli(bin, "codex", { installed: [{ name: "vibe", version: "1.1.1" }, { name: "code", version: "2.0.2" }] });
  await run(home, ["check", ...both(claude, codex, main.url)]);
  const first = await run(home, ["status", "--closedloop", "connected", "--graph", "not-connected"]);
  assert.equal(first.code, 0);
  assert.equal(first.result.print, true);
  assert.equal(first.result.block, [
    "Setup check",
    "- Claude Code: closedloop-core 1.5.3, vibe 1.1.2",
    "- Codex: closedloop-core not installed, vibe 1.1.1",
    "- ClosedLoop connection: connected",
    "- closedloop-graph connection: not connected",
  ].join("\n"));
  assert.equal(startup(home).statusShown.graph, "not-connected");

  // A compaction reruns the check and the status in the same conversation: nothing is shown again.
  await run(home, ["check", ...both(claude, codex, main.url)]);
  const again = await run(home, ["status", "--closedloop", "connected", "--graph", "connected"]);
  assert.equal(again.result.print, false);
  assert.equal(again.result.block, undefined);

  // A new conversation shows it again.
  const other = { CLAUDE_CODE_SESSION_ID: "conversation-2" };
  await run(home, ["check", ...both(claude, codex, main.url)], other);
  const fresh = await run(home, ["status", "--closedloop", "connected", "--graph", "connected"], other);
  assert.equal(fresh.result.print, true);
  assert.match(fresh.result.block, /- closedloop-graph connection: connected$/);
});

test("the setup check block never claims versions it did not read, and refuses connections it was not told", async (t) => {
  const { home, bin } = sandbox(t);
  const fleet = path.join(home, "plugin-version.json");
  // No check has run in this conversation.
  const unchecked = await run(home, ["status", "--state", fleet, "--closedloop", "not-connected", "--graph", "connected"]);
  assert.equal(unchecked.result.print, true);
  assert.match(unchecked.result.block, /- Plugins: the version check has not run in this conversation\n/);
  assert.match(unchecked.result.block, /- ClosedLoop connection: not connected\n/);

  // A check from an earlier conversation in the same fleet state file is not this conversation's.
  const main = await marketplace(t, { files: mainFiles({ vibe: "1.1.2" }) });
  const claude = fakeCli(bin, "claude", { installed: [], fail: "plugin list" });
  const later = { CLAUDE_CODE_SESSION_ID: "conversation-3" };
  const failing = await run(home, ["check", "--state", fleet, "--claude", claude.file, "--latest-base", main.url], later);
  assert.equal(failing.result.status, "unknown");
  const listingFailed = await run(home, ["status", "--state", fleet, "--closedloop", "connected", "--graph", "connected"], later);
  assert.match(listingFailed.result.block, /- Claude Code: couldn't read its plugins\n/);
  assert.doesNotMatch(listingFailed.result.block, /Codex/);

  for (const args of [[], ["--closedloop", "connected"], ["--closedloop", "yes", "--graph", "connected"]]) {
    const refused = await run(home, ["status", "--state", fleet, ...args], { CLAUDE_CODE_SESSION_ID: "conversation-4" });
    assert.equal(refused.code, 1);
    assert.equal(refused.result.ok, false);
    assert.match(refused.result.error, /must each be connected or not-connected/);
  }
});
