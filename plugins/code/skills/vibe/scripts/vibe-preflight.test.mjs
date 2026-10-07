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

function fakeNode(dir, version) {
  writeExecutable(path.join(dir, "node"), `echo ${version}`);
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
  if (freshNodeVersion) {
    fakeNode(freshBin, freshNodeVersion);
  }
  const shell = path.join(fixture.root, "login-shell");
  writeExecutable(shell, `PATH="${freshBin}:$PATH" exec /bin/bash -c "$2"`);
  return { ...fixture, bin, shell };
}

function runPreflight({ home, bin, shell }, args = []) {
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    env: { ...gitEnv(home), PATH: `${bin}:${SYSTEM_PATH}`, SHELL: shell },
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
  return { status: result.status, checks };
}

function remembered(home) {
  const file = path.join(home, ".codex", "vibe", "config.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).repo : null;
}

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

  const worktree = path.join(first, ".claude", "worktrees", "andy-x");
  git(first, ["worktree", "add", "--quiet", "-b", "andy/x", worktree], env.home);
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
