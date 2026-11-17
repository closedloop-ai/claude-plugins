import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_CAPABILITIES, bindProvider, git, gitEnv, makeCheckout, makeHome, SYMPHONY_REMOTE } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-preflight.sh");
const SPACED = ["Documents", "Closedloop.ai - Active Work", "symphony-alpha"];
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function writeExecutable(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// Reports the given version; anything else (the preflight's own node scripts)
// runs on the real Node.
function fakeNode(dir, version) {
  writeExecutable(
    path.join(dir, "node"),
    `case "$1" in --version|-v) echo ${version} ;; *) exec "${process.execPath}" "$@" ;; esac`
  );
}

/**
 * A home folder, a bin folder of fake tools first on PATH, and a fake login
 * shell. `freshBin` stands in for what a brand-new shell's profile puts first.
 */
const INSTALLED_PLUGINS = JSON.stringify({ installed: ["closedloop-core", "vibe-core"]
  .map((name) => ({ pluginId: `${name}@closedloop-ai`, installed: true, enabled: true })) });

function setup(t, { nodeVersion = "v24.11.0", freshNodeVersion } = {}) {
  const fixture = makeHome("vibe-preflight-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  const freshBin = path.join(fixture.root, "fresh-bin");
  mkdirSync(freshBin, { recursive: true });
  fakeNode(bin, nodeVersion);
  writeExecutable(path.join(bin, "codex"), `printf '%s\\n' '${INSTALLED_PLUGINS}'`);
  if (freshNodeVersion) {
    fakeNode(freshBin, freshNodeVersion);
  }
  const shell = path.join(fixture.root, "login-shell");
  writeExecutable(shell, `PATH="${freshBin}:$PATH" exec /bin/bash -c "$2"`);
  return { ...fixture, bin, shell };
}

// Nothing listens here, so the PostHog check never reaches the network.
const UNREACHABLE_PAGE = "http://127.0.0.1:9/sign-in";

// Runs from `cwd` (by default the fixture root, which is no git checkout, so only --repo or the remembered
// checkout can name one).
function runPreflight({ root, home, bin, shell }, args = [], extraEnv = {}, cwd = root) {
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    cwd,
    env: {
      ...gitEnv(home),
      PATH: `${bin}:${SYSTEM_PATH}`,
      SHELL: shell,
      VIBE_POSTHOG_PAGE_URL: UNREACHABLE_PAGE,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  const checks = Object.fromEntries(
    result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return [parsed.check, parsed];
      })
  );
  return { status: result.status, checks, stdout: result.stdout };
}

const BOUND_CHAT = "preflight-chat";

/** Environment for a conversation whose start bound this checkout's provider with `capabilities`. */
function boundProvider(home, capabilities = ALL_CAPABILITIES) {
  return bindProvider(home, { capabilities, conversation: BOUND_CHAT });
}

function remembered(home) {
  const file = path.join(home, ".codex", "vibe", "config.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).repo : null;
}

test("Codex requires an installed enabled core before remembering a checkout", (t) => {
  for (const output of [
    '{"installed":[]}',
    '{"installed":[{"pluginId":"closedloop-core@closedloop-ai","installed":true,"enabled":false}]}',
    '{"installed":[{"pluginId":"closedloop-core@closedloop-ai","installed":false,"enabled":true}]}',
    '{"available":[{"pluginId":"closedloop-core@closedloop-ai","installed":true,"enabled":true}]}',
    'invalid',
  ]) {
    const env = setup(t);
    writeExecutable(path.join(env.bin, "codex"), `printf '%s\\n' '${output}'`);
    const result = runPreflight(env);
    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(result.checks), ["closedloop-core", "vibe-core"]);
    assert.equal(result.checks["closedloop-core"].fix, `${path.join(env.bin, "codex")} plugin add closedloop-core@closedloop-ai`);
    assert.equal(remembered(env.home), null);
  }
});

// Codex installs no plugin dependency and vibe ships no hooks, so a vibe update without vibe-core leaves every guard off.
test("Codex requires an installed enabled vibe-core, which carries vibe's hooks, before remembering a checkout", (t) => {
  const core = '{"pluginId":"closedloop-core@closedloop-ai","installed":true,"enabled":true}';
  for (const hooks of ['', ',{"pluginId":"vibe-core@closedloop-ai","installed":true,"enabled":false}', ',{"pluginId":"vibe-core@other","installed":true,"enabled":true}']) {
    const env = setup(t);
    writeExecutable(path.join(env.bin, "codex"), `printf '%s\\n' '{"installed":[${core}${hooks}]}'`);
    const result = runPreflight(env);
    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(result.checks), ["closedloop-core", "vibe-core"]);
    assert.equal(result.checks["closedloop-core"].ok, true);
    assert.equal(result.checks["vibe-core"].ok, false);
    assert.equal(result.checks["vibe-core"].fix, `${path.join(env.bin, "codex")} plugin add vibe-core@closedloop-ai`);
    assert.equal(remembered(env.home), null);
  }
});

test("Codex query failure fails closed and Claude does not query Codex", (t) => {
  const env = setup(t);
  writeExecutable(path.join(env.bin, "codex"), "exit 1");
  assert.equal(runPreflight(env).checks["closedloop-core"].ok, false);
  const claude = runPreflight(env, ["--runtime", "claude", "--prototype"]);
  assert.equal(claude.checks["closedloop-core"], undefined);
  assert.equal(claude.checks["vibe-core"], undefined);
  assert.ok(claude.checks.repo);
});

test("an explicit app-bundled Codex CLI works without codex on PATH", (t) => {
  const env = setup(t);
  const bundled = path.join(env.root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
  mkdirSync(path.dirname(bundled), { recursive: true });
  renameSync(path.join(env.bin, "codex"), bundled);
  const result = runPreflight(env, ["--codex", bundled]);
  assert.equal(result.checks["closedloop-core"].ok, true);
  assert.equal(result.checks["vibe-core"].ok, true);
  assert.ok(result.checks.repo);
});

test("missing Node reports its prerequisite fix rather than missing core", (t) => {
  const env = setup(t);
  const withoutNode = path.join(env.root, "without-node");
  mkdirSync(withoutNode);
  for (const name of ["dirname", "mktemp", "find", "sort", "grep", "sed", "paste", "rm", "mkdir", "git", "uname", "head", "tail", "curl"]) {
    const target = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(target, path.join(withoutNode, name));
  }
  const result = runPreflight(env, ["--prototype"], { PATH: withoutNode });
  assert.equal(result.status, 1);
  assert.equal(result.checks.node.ok, false);
  assert.equal(result.checks.node.fix, "install-node");
  assert.equal(result.checks["closedloop-core"], undefined);
});

// Operator ruling, 2026-11-10: any git checkout is accepted; nothing is tied to one organization's repositories.
test("the checkout this command runs in is used, spaces and all, whatever its remote, and remembered", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout, remoteUrl: "git@github.com:someone/notes-app.git",
    files: { "package.json": '{"engines":{"node":">=24"}}\n' } });
  const { checks } = runPreflight(env, [], {}, path.join(checkout));
  assert.equal(checks.repo.ok, true);
  assert.equal(checks.repo.detail, checkout);
  assert.equal(remembered(env.home), checkout);
  assert.equal(checks.node.ok, true, checks.node.detail);
});

test("a remembered checkout is used when the command runs outside one, even outside the home folder", (t) => {
  const env = setup(t);
  const checkout = path.join(env.root, "elsewhere", "app");
  makeCheckout({ ...env, checkout });
  mkdirSync(path.join(env.home, ".codex", "vibe"), { recursive: true });
  writeFileSync(
    path.join(env.home, ".codex", "vibe", "config.json"),
    `${JSON.stringify({ repo: checkout })}\n`
  );
  const { checks } = runPreflight(env);
  assert.equal(checks.repo.ok, true);
  assert.equal(checks.repo.detail, checkout);
});

test("--repo wins over the working folder and remembers the main checkout of a worktree", (t) => {
  const env = setup(t);
  const first = path.join(env.home, ...SPACED);
  const second = path.join(env.home, "Source", "other-app");
  makeCheckout({ ...env, checkout: first });
  makeCheckout({ ...env, checkout: second });
  const worktree = path.join(first, ".claude", "worktrees", "vibe-x");
  git(first, ["worktree", "add", "--quiet", "-b", "vibe/x", worktree], env.home);
  const chosen = runPreflight(env, ["--repo", worktree], {}, second);
  assert.equal(chosen.checks.repo.ok, true);
  assert.equal(chosen.checks.repo.detail, first);
  assert.equal(remembered(env.home), first);
  assert.equal(runPreflight(env, [], {}, second).checks.repo.detail, second, "the working folder's checkout comes next");
  assert.equal(runPreflight(env).checks.repo.detail, second, "then the one remembered last");
});

test("no checkout named, here or remembered, asks for the folder; a folder that is no checkout is refused", (t) => {
  const env = setup(t);
  const none = runPreflight(env);
  assert.equal(none.checks.repo.ok, false);
  assert.equal(none.checks.repo.fix, "ask-for-repo-path");
  const plain = path.join(env.root, "plain");
  mkdirSync(plain);
  const refused = runPreflight(env, ["--repo", plain]);
  assert.equal(refused.checks.repo.fix, "ask-for-repo-path");
  assert.match(refused.checks.repo.detail, /is not a git checkout/);
});

test("the Node range comes from the checkout's package.json", (t) => {
  const env = setup(t, { nodeVersion: "v24.11.0" });
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({
    ...env,
    checkout,
    files: { "package.json": '{"engines":{"node":">=26"}}\n' },
  });
  const { checks } = runPreflight(env, ["--repo", checkout]);
  assert.equal(checks.node.ok, false);
  assert.equal(checks.node.fix, "install-node");
  assert.match(checks.node.detail, /v24\.11\.0 .* outside >=26/);
});

test("an old Node first on PATH fails even when the range is the default", (t) => {
  const env = setup(t, { nodeVersion: "v20.11.0" });
  const { checks } = runPreflight(env);
  assert.equal(checks.node.ok, false);
  assert.equal(checks.node.fix, "install-node");
  assert.match(checks.node.detail, /v20\.11\.0 .* outside >=22/);
});

test("a supported Node here but an old one in a new shell still fails", (t) => {
  const env = setup(t, { nodeVersion: "v24.11.0", freshNodeVersion: "v20.11.0" });
  const { checks } = runPreflight(env);
  assert.equal(checks.node.ok, false);
  assert.match(checks.node.detail, /a new shell runs v20\.11\.0/);
});

test("no Docker check runs: vibe sessions use Vercel, not a local web environment", (t) => {
  const env = setup(t);
  writeExecutable(path.join(env.bin, "colima"), "exit 1");
  writeExecutable(path.join(env.bin, "docker"), "exit 1");
  const { checks } = runPreflight(env);
  assert.equal(checks.docker, undefined);
  assert.equal(checks["docker-compose"], undefined);
  assert.equal(checks.gh.ok, false);
});

test("the PostHog check runs only with the provider's recipes, and fails plainly without a key", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout });
  assert.equal(runPreflight(env, ["--repo", checkout]).checks["posthog-key"], undefined, "a generic session has no flag snapshot");
  const unopted = path.join(env.home, "Source", "personal-app");
  makeCheckout({ ...env, checkout: unopted, remoteUrl: "https://github.com/someone/personal-app.git" });
  assert.equal(runPreflight(env, ["--repo", unopted], boundProvider(env.home, ["tickets"])).checks["posthog-key"], undefined,
    "a provider without recipes for the repository adds no check");
  // The chat's own check ran where nothing opted in; the repository named here commits the opt-in, so its recipes apply.
  assert.equal(runPreflight(env, ["--repo", checkout], boundProvider(env.home, ["tickets"])).checks["posthog-key"].ok, false,
    "the named repository's own opt-in decides, not the folder the chat's check ran in");
  const bound = boundProvider(env.home);

  const missing = runPreflight(env, ["--repo", checkout], bound);
  assert.equal(missing.checks["posthog-key"].ok, false);
  assert.equal(missing.checks["posthog-key"].fix, "posthog-key-missing");
  assert.match(missing.checks["posthog-key"].detail, /could not be read/);

  const key = "phc_TestKey0123456789abcdefghijklmnopqrstu";
  mkdirSync(path.join(checkout, "apps", "app"), { recursive: true });
  writeFileSync(path.join(checkout, "apps", "app", ".env.local"), `NEXT_PUBLIC_POSTHOG_KEY=${key}\n`);
  const found = runPreflight(env, ["--repo", checkout], bound);
  assert.equal(found.checks["posthog-key"].ok, true, found.checks["posthog-key"].detail);
  assert.match(found.checks["posthog-key"].detail, /^https:\/\/us\.i\.posthog\.com from .*\.env\.local$/);
  assert.doesNotMatch(found.stdout, new RegExp(key));
});

test("the package manager comes from the lockfile, and missing dependencies name the provider's bootstrap or a plain install", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout, files: { "package.json": "{}\n", "yarn.lock": "\n" } });
  const generic = runPreflight(env, ["--repo", checkout]);
  assert.equal(generic.checks["package-manager"].ok, false);
  assert.equal(generic.checks["package-manager"].fix, "install-yarn");
  assert.equal(generic.checks["repo-bootstrap"].fix, "install-dependencies");
  assert.equal(runPreflight(env, ["--repo", checkout], boundProvider(env.home)).checks["repo-bootstrap"].fix, "run-loops-setup");
  const plain = path.join(env.home, "Source", "no-node");
  makeCheckout({ ...env, checkout: plain });
  const none = runPreflight(env, ["--repo", plain]);
  assert.equal(none.checks["package-manager"], undefined, "no package.json, no package manager");
  assert.equal(none.checks["repo-bootstrap"], undefined);
});

test("just is not a vibe prerequisite", (t) => {
  const env = setup(t);
  assert.equal(runPreflight(env).checks.just, undefined);
});

test("prototype preflight keeps common prerequisites and omits only the app PostHog check", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout });
  const bound = boundProvider(env.home);
  const prototype = runPreflight(env, ["--prototype", "--repo", checkout], bound);
  assert.equal(prototype.checks["posthog-key"], undefined);
  assert.equal(prototype.checks.repo.ok, true);
  assert.equal(prototype.checks.gh.ok, false, "common prerequisite failures remain visible");
  const app = runPreflight(env, ["--repo", checkout], bound);
  assert.equal(app.checks["posthog-key"].ok, false, "app sessions still require the real key");
});

test("Claude preflight reports a signed-out claude command before any worker launches, asking from the home folder", (t) => {
  const env = setup(t);
  const asked = path.join(env.root, "claude-asked-from");
  writeExecutable(path.join(env.bin, "claude"),
    `pwd > "${asked}"; [ "$1 $2" = "auth status" ] && echo '{"loggedIn":false}' && exit 1; exit 2`);
  const signedOut = runPreflight(env, ["--runtime", "claude", "--prototype"]);
  assert.equal(signedOut.checks["claude-login"].ok, false);
  assert.equal(signedOut.checks["claude-login"].fix, "claude-auth-login");
  assert.equal(readFileSync(asked, "utf8").trim(), env.home);
  writeExecutable(path.join(env.bin, "claude"), `echo '{"loggedIn":true}'`);
  assert.equal(runPreflight(env, ["--runtime", "claude", "--prototype"]).checks["claude-login"].ok, true);
  assert.equal(runPreflight(env, ["--prototype"]).checks["claude-login"], undefined);
});

test("a refused write of the remembered checkout asks for an escalated rerun and never fails setup", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout, files: { "package.json": '{"engines":{"node":"^24 || >=26"}}\n' } });
  const codex = path.join(env.home, ".codex");
  mkdirSync(codex, { recursive: true });
  chmodSync(codex, 0o500);
  const { checks, stdout } = runPreflight(env, ["--repo", checkout], { CODEX_SANDBOX_NETWORK_DISABLED: "1" });
  chmodSync(codex, 0o700);
  assert.equal(checks.repo.ok, true);
  const escalation = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.escalate);
  assert.equal(escalation?.justification, "Remember where your copy of the code is");
  assert.equal(remembered(env.home), null);
});

const OTHER_REMOTE = "git@github.com:someone/notes-app.git";

function rememberRepo(home, repo) {
  mkdirSync(path.join(home, ".codex", "vibe"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "vibe", "config.json"), `${JSON.stringify({ repo })}\n`);
}

// Restores the home-folder search the app's preflight ran before vibe became generic: the bound provider names its
// repository's remote (provider.json `data.memory.repository.remote`), and only a checkout of that remote is used.
test("with the provider naming its repository, its only checkout under the home folder is found and remembered", (t) => {
  const env = setup(t);
  const app = path.join(env.home, ...SPACED);
  const other = path.join(env.home, "Source", "notes-app");
  makeCheckout({ ...env, checkout: app });
  makeCheckout({ ...env, checkout: other, remoteUrl: OTHER_REMOTE });
  const generic = runPreflight(env);
  assert.equal(generic.checks.repo.fix, "ask-for-repo-path", "a generic session never searches the home folder");
  assert.equal(remembered(env.home), null);

  const bound = boundProvider(env.home);
  const found = runPreflight(env, [], bound);
  assert.equal(found.checks.repo.ok, true, found.checks.repo.detail);
  assert.equal(found.checks.repo.detail, app);
  assert.equal(remembered(env.home), app);
  assert.equal(runPreflight(env, [], bound, other).checks.repo.detail, app, "a working checkout of another remote is not the provider's repository");
  assert.equal(runPreflight(env, [], {}, other).checks.repo.detail, other, "a generic session uses the working checkout, whatever its remote");
  assert.equal(runPreflight(env, [], boundProvider(env.home, ["tickets"]), other).checks.repo.detail, other,
    "a provider bound without the capability that names its repository leaves the working checkout in use");
});

// Main's precedence when the provider names its repository: --repo, the remembered clone, the home-folder search;
// the folder the command runs in is never a step (8a858bb4 vibe-preflight.sh:205-238).
test("with the provider naming its repository, the folder this runs in never picks between two clones of it", (t) => {
  const env = setup(t);
  const kept = path.join(env.home, "Source", "symphony-alpha");
  const here = path.join(env.home, "work", "app-copy");
  makeCheckout({ ...env, checkout: kept, remoteUrl: SYMPHONY_REMOTE });
  makeCheckout({ ...env, checkout: here, remoteUrl: SYMPHONY_REMOTE });
  const bound = boundProvider(env.home);
  const ambiguous = runPreflight(env, [], bound, here);
  assert.equal(ambiguous.checks.repo.fix, "choose-repo", "with none remembered, the working clone does not settle it");
  assert.deepEqual(ambiguous.checks.repo.detail.split(" | ").sort(), [kept, here].sort());
  assert.equal(remembered(env.home), null);
  rememberRepo(env.home, kept);
  assert.equal(runPreflight(env, [], bound, here).checks.repo.detail, kept, "the remembered clone is used, not the working one");
  assert.equal(remembered(env.home), kept);
  assert.equal(runPreflight(env, [], {}, here).checks.repo.detail, here, "with no provider the working clone is used");
});

test("with the provider naming its repository, --repo refuses a checkout of a remote it does not list", (t) => {
  const env = setup(t);
  const other = path.join(env.home, "Source", "notes-app");
  makeCheckout({ ...env, checkout: other, remoteUrl: OTHER_REMOTE });
  const plain = path.join(env.root, "plain");
  mkdirSync(plain);
  for (const folder of [other, plain]) {
    const refused = runPreflight(env, ["--repo", folder], boundProvider(env.home));
    assert.equal(refused.checks.repo.ok, false);
    assert.equal(refused.checks.repo.fix, "ask-for-repo-path");
    assert.equal(refused.checks.repo.detail, `${folder} is not a symphony-alpha or claude-plugins checkout`);
  }
  assert.equal(remembered(env.home), null);
});

test("with the provider naming its repository, --repo accepts a plugins checkout for that run only", (t) => {
  const env = setup(t);
  const app = path.join(env.home, "Source", "symphony-alpha");
  makeCheckout({ ...env, checkout: app });
  const bound = boundProvider(env.home);
  assert.equal(runPreflight(env, [], bound).checks.repo.detail, app);
  const plugins = path.join(env.home, "Source", "claude-plugins");
  makeCheckout({ ...env, checkout: plugins, remoteUrl: "https://github.com/closedloop-ai/claude-plugins.git",
    files: { "package.json": "{}\n", "pnpm-lock.yaml": "\n" } });
  const worktree = path.join(plugins, ".claude", "worktrees", "vibe-x");
  git(plugins, ["worktree", "add", "--quiet", "-b", "vibe/x", worktree], env.home);
  const result = runPreflight(env, ["--repo", worktree], bound);
  assert.equal(result.checks.repo.ok, true, result.stdout);
  assert.equal(result.checks.repo.detail, plugins);
  assert.equal(result.checks["repo-bootstrap"], undefined, "the app's dependency install is not a plugins prerequisite");
  assert.equal(result.checks["posthog-key"], undefined, "the app flag snapshot key is not a plugins prerequisite");
  assert.equal(remembered(env.home), app, "a plugins checkout is never remembered");
  const lookalike = path.join(env.home, "Source", "elsewhere");
  makeCheckout({ ...env, checkout: lookalike, remoteUrl: "git@github.com:someone/claude-plugins.git" });
  assert.match(runPreflight(env, ["--repo", lookalike], bound).checks.repo.detail, /is not a symphony-alpha or claude-plugins checkout/);
});

test("with no provider, --repo accepts a checkout of any remote and remembers it", (t) => {
  const env = setup(t);
  const other = path.join(env.home, "Source", "notes-app");
  makeCheckout({ ...env, checkout: other, remoteUrl: OTHER_REMOTE, files: { "package.json": "{}\n" } });
  const result = runPreflight(env, ["--repo", other]);
  assert.equal(result.checks.repo.ok, true, result.stdout);
  assert.equal(result.checks.repo.detail, other);
  assert.equal(remembered(env.home), other);
  assert.equal(result.checks["repo-bootstrap"].fix, "install-dependencies", "its own checks still run");
});

// Main's precedence: the remembered checkout of the repository comes before the home-folder search.
test("a remembered checkout of the provider's repository wins over the one the home-folder search would find", (t) => {
  const env = setup(t);
  const found = path.join(env.home, "Source", "symphony-alpha");
  const kept = path.join(env.root, "elsewhere", "symphony-alpha");
  makeCheckout({ ...env, checkout: found, remoteUrl: SYMPHONY_REMOTE });
  makeCheckout({ ...env, checkout: kept, remoteUrl: SYMPHONY_REMOTE });
  rememberRepo(env.home, kept);
  const bound = boundProvider(env.home);
  assert.equal(runPreflight(env, [], bound).checks.repo.detail, kept);
});

test("several checkouts of the provider's repository ask to choose unless one of them is remembered", (t) => {
  const env = setup(t);
  const first = path.join(env.home, "Source", "symphony-alpha");
  const second = path.join(env.home, "work", "app-copy");
  const other = path.join(env.home, "Source", "notes-app");
  makeCheckout({ ...env, checkout: first, remoteUrl: SYMPHONY_REMOTE });
  makeCheckout({ ...env, checkout: second, remoteUrl: SYMPHONY_REMOTE });
  makeCheckout({ ...env, checkout: other, remoteUrl: OTHER_REMOTE });
  const bound = boundProvider(env.home);
  rememberRepo(env.home, other);
  const ambiguous = runPreflight(env, [], bound);
  assert.equal(ambiguous.checks.repo.ok, false);
  assert.equal(ambiguous.checks.repo.fix, "choose-repo");
  assert.deepEqual(ambiguous.checks.repo.detail.split(" | ").sort(), [first, second].sort());
  rememberRepo(env.home, second);
  assert.equal(runPreflight(env, [], bound).checks.repo.detail, second);
});

test("with the provider naming its repository and none found, a remembered checkout of another remote is not used", (t) => {
  const env = setup(t);
  const other = path.join(env.home, "Source", "notes-app");
  makeCheckout({ ...env, checkout: other, remoteUrl: OTHER_REMOTE });
  rememberRepo(env.home, other);
  const none = runPreflight(env, [], boundProvider(env.home));
  assert.equal(none.checks.repo.ok, false);
  assert.equal(none.checks.repo.fix, "ask-for-repo-path");
  assert.match(none.checks.repo.detail, /no checkout whose git remote matches .*symphony-alpha/);
  assert.equal(runPreflight(env).checks.repo.detail, other, "a generic session uses the remembered checkout");
});

test("a bound provider that cannot be read fails the provider check once with its reason, never reads as unbound", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout, files: { "package.json": "{}\n", "pnpm-lock.yaml": "\n" } });
  const records = path.join(env.home, ".codex", "vibe", "plugin-version");
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, "gone-chat.json"), JSON.stringify({ conversation: "gone-chat", status: "current",
    provider: { state: "bound", name: "gone-provider", root: path.join(env.root, "uninstalled"), capabilities: ALL_CAPABILITIES } }));
  const result = runPreflight(env, ["--repo", checkout], { CLAUDE_CODE_SESSION_ID: "gone-chat", CODEX_THREAD_ID: "" });
  assert.equal(result.checks.provider.ok, false);
  assert.equal(result.checks.provider.fix, "provider-broken");
  assert.match(result.checks.provider.detail, /^the provider gone-provider this session is bound to is no longer installed/);
  assert.equal(result.stdout.split("\n").filter((line) => line.includes('"check":"provider"')).length, 1);
  assert.equal(result.checks.repo.ok, true);
  assert.equal(result.checks["repo-bootstrap"].fix, "install-dependencies");
  assert.equal(result.checks["posthog-key"], undefined);
});
