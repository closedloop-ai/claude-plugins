// Shared fixtures for the vibe and handoff script tests: a throwaway home
// folder and a symphony-alpha-like git checkout cloned from a local bare
// origin, so the scripts run end to end without the network.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SYMPHONY_REMOTE = "git@github.com:closedloop-ai/symphony-alpha.git";

export function makeHome(prefix) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function gitEnv(home) {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Vibe Test",
    GIT_AUTHOR_EMAIL: "vibe-test@example.com",
    GIT_COMMITTER_NAME: "Vibe Test",
    GIT_COMMITTER_EMAIL: "vibe-test@example.com",
  };
}

export function git(cwd, args, home) {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(home),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Creates a bare origin with one commit on main (the given files) and clones
 * it to `checkout`. The clone's origin URL is then pointed at `remoteUrl` for
 * fetch display while pushes and fetches still use the local bare repo.
 */
export function makeCheckout({ root, home, checkout, files = {}, remoteUrl = SYMPHONY_REMOTE }) {
  const origin = path.join(root, `origin-${Math.random().toString(16).slice(2)}.git`);
  const seed = path.join(root, `seed-${Math.random().toString(16).slice(2)}`);
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin], home);
  git(root, ["init", "--quiet", "--initial-branch=main", seed], home);
  const allFiles = { "README.md": "seed\n", ...files };
  for (const [file, content] of Object.entries(allFiles)) {
    const absolute = path.join(seed, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(seed, ["add", "-A"], home);
  git(seed, ["commit", "--quiet", "-m", "seed"], home);
  git(seed, ["push", "--quiet", origin, "main"], home);
  mkdirSync(path.dirname(checkout), { recursive: true });
  git(root, ["clone", "--quiet", origin, checkout], home);
  // The scripts identify symphony-alpha by this URL; insteadOf keeps the
  // network out of fetch and ls-remote.
  git(checkout, ["remote", "set-url", "origin", remoteUrl], home);
  git(checkout, ["config", `url.${origin}.insteadOf`, remoteUrl], home);
  return { origin, checkout };
}

export function runNode(script, args, home, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...gitEnv(home), ...extraEnv },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr };
}
