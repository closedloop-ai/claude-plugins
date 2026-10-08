import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, gitEnv, makeCheckout, makeHome } from "./test-fixtures.mjs";

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
function setup(t, { nodeVersion = "v24.11.0", freshNodeVersion } = {}) {
  const fixture = makeHome("vibe-preflight-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  const freshBin = path.join(fixture.root, "fresh-bin");
  mkdirSync(freshBin, { recursive: true });
  fakeNode(bin, nodeVersion);
  writeExecutable(path.join(bin, "codex"), "printf '%s\\n' '{\"installed\":[{\"pluginId\":\"closedloop-core@closedloop-ai\",\"installed\":true,\"enabled\":true}]}'");
  if (freshNodeVersion) {
    fakeNode(freshBin, freshNodeVersion);
  }
  const shell = path.join(fixture.root, "login-shell");
  writeExecutable(shell, `PATH="${freshBin}:$PATH" exec /bin/bash -c "$2"`);
  return { ...fixture, bin, shell };
}

// Nothing listens here, so the PostHog check never reaches the network.
const UNREACHABLE_PAGE = "http://127.0.0.1:9/sign-in";

function runPreflight({ home, bin, shell }, args = [], extraEnv = {}) {
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
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
    assert.deepEqual(Object.keys(result.checks), ["closedloop-core"]);
    assert.equal(result.checks["closedloop-core"].fix, "codex plugin add closedloop-core@closedloop-ai");
    assert.equal(remembered(env.home), null);
  }
});

test("Codex query failure fails closed and Claude does not query Codex", (t) => {
  const env = setup(t);
  writeExecutable(path.join(env.bin, "codex"), "exit 1");
  assert.equal(runPreflight(env).checks["closedloop-core"].ok, false);
  const claude = runPreflight(env, ["--runtime", "claude", "--prototype"]);
  assert.equal(claude.checks["closedloop-core"], undefined);
  assert.ok(claude.checks.repo);
});

test("finds a checkout with spaces in its path by its remote and remembers it", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout, files: { "package.json": '{"engines":{"node":"^24 || >=26"}}\n' } });
  // Same folder name, different project: not symphony-alpha.
  makeCheckout({
    ...env,
    checkout: path.join(env.home, "Source", "symphony-alpha"),
    remoteUrl: "git@github.com:someone/symphony-alpha.git",
  });

  const { checks } = runPreflight(env);
  assert.equal(checks.repo.ok, true);
  assert.equal(checks.repo.detail, checkout);
  assert.equal(remembered(env.home), checkout);
  assert.equal(checks.node.ok, true, checks.node.detail);
});

test("a remembered checkout is used even outside the home folder", (t) => {
  const env = setup(t);
  const checkout = path.join(env.root, "elsewhere", "symphony-alpha");
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

test("several checkouts ask the person to choose, and --repo remembers the main checkout of a worktree", (t) => {
  const env = setup(t);
  const first = path.join(env.home, ...SPACED);
  const second = path.join(env.home, "Source", "symphony-alpha");
  makeCheckout({ ...env, checkout: first });
  makeCheckout({ ...env, checkout: second });

  const ambiguous = runPreflight(env);
  assert.equal(ambiguous.checks.repo.ok, false);
  assert.equal(ambiguous.checks.repo.fix, "choose-repo");
  assert.match(ambiguous.checks.repo.detail, /Closedloop\.ai - Active Work/);
  assert.equal(remembered(env.home), null);

  const worktree = path.join(first, ".claude", "worktrees", "vibe-x");
  git(first, ["worktree", "add", "--quiet", "-b", "vibe/x", worktree], env.home);
  const chosen = runPreflight(env, ["--repo", worktree]);
  assert.equal(chosen.checks.repo.ok, true);
  assert.equal(remembered(env.home), first);

  // Later runs use the remembered choice without asking again.
  assert.equal(runPreflight(env).checks.repo.detail, first);
});

test("no checkout anywhere means clone", (t) => {
  const env = setup(t);
  const { checks } = runPreflight(env);
  assert.equal(checks.repo.ok, false);
  assert.equal(checks.repo.fix, "clone-repo");
});

test("the Node range comes from the checkout's package.json", (t) => {
  const env = setup(t, { nodeVersion: "v24.11.0" });
  makeCheckout({
    ...env,
    checkout: path.join(env.home, ...SPACED),
    files: { "package.json": '{"engines":{"node":">=26"}}\n' },
  });
  const { checks } = runPreflight(env);
  assert.equal(checks.node.ok, false);
  assert.equal(checks.node.fix, "install-node");
  assert.match(checks.node.detail, /v24\.11\.0 .* outside >=26/);
});

test("an old Node first on PATH fails even when the range is the default", (t) => {
  const env = setup(t, { nodeVersion: "v22.11.0" });
  const { checks } = runPreflight(env);
  assert.equal(checks.node.ok, false);
  assert.equal(checks.node.fix, "install-node");
  assert.match(checks.node.detail, /v22\.11\.0 .* outside \^24 \|\| >=26/);
});

test("a supported Node here but an old one in a new shell still fails", (t) => {
  const env = setup(t, { nodeVersion: "v24.11.0", freshNodeVersion: "v22.11.0" });
  const { checks } = runPreflight(env);
  assert.equal(checks.node.ok, false);
  assert.match(checks.node.detail, /a new shell runs v22\.11\.0/);
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

test("the PostHog check passes from the checkout's env file and fails plainly without a key", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout });

  const missing = runPreflight(env);
  assert.equal(missing.checks["posthog-key"].ok, false);
  assert.equal(missing.checks["posthog-key"].fix, "posthog-key-missing");
  assert.match(missing.checks["posthog-key"].detail, /could not be read/);

  const key = "phc_TestKey0123456789abcdefghijklmnopqrstu";
  mkdirSync(path.join(checkout, "apps", "app"), { recursive: true });
  writeFileSync(path.join(checkout, "apps", "app", ".env.local"), `NEXT_PUBLIC_POSTHOG_KEY=${key}\n`);
  const found = runPreflight(env);
  assert.equal(found.checks["posthog-key"].ok, true, found.checks["posthog-key"].detail);
  assert.match(found.checks["posthog-key"].detail, /^https:\/\/us\.i\.posthog\.com from .*\.env\.local$/);
  assert.doesNotMatch(found.stdout, new RegExp(key));
});

test("just is not a vibe prerequisite", (t) => {
  const env = setup(t);
  assert.equal(runPreflight(env).checks.just, undefined);
});

test("prototype preflight keeps common prerequisites and omits only the app PostHog check", (t) => {
  const env = setup(t);
  const checkout = path.join(env.home, ...SPACED);
  makeCheckout({ ...env, checkout });
  const prototype = runPreflight(env, ["--prototype", "--repo", checkout]);
  assert.equal(prototype.checks["posthog-key"], undefined);
  assert.equal(prototype.checks.repo.ok, true);
  assert.equal(prototype.checks.gh.ok, false, "common prerequisite failures remain visible");
  const app = runPreflight(env, ["--repo", checkout]);
  assert.equal(app.checks["posthog-key"].ok, false, "app sessions still require the real key");
});
