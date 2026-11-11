import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_CAPABILITIES, bindProvider, git, gitEnv, makeCheckout, makeHome } from "./test-fixtures.mjs";

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
  assert.equal(runPreflight(env, ["--repo", checkout], boundProvider(env.home, ["tickets"])).checks["posthog-key"], undefined,
    "a provider without recipes for the repository adds no check");
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
