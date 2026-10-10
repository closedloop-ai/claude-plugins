// Shared fixtures for the vibe and handoff script tests: a throwaway home
// folder and a symphony-alpha-like git checkout cloned from a local bare
// origin, so the scripts run end to end without the network.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function runNode(script, args, home, extraEnv = {}, input) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...gitEnv(home), ...extraEnv },
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr };
}

/** Existing dispatch contract cases obtain genuine prepared/check/push state, never forged PASS metadata. */
export function mainSyncAdmission(worktree, home, root) {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(scripts, "../../..");
  const state = path.join(scripts, "dist/writer-state.mjs");
  const sessions = path.join(scripts, "vibe-sessions.mjs");
  const metadata = git(worktree, ["rev-parse", "--absolute-git-dir"], home);
  const bin = path.join(root, "main-sync-bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pnpm"), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args[1] === 'node') {
  fs.readFileSync('README.md', 'utf8');
  process.stdout.write(JSON.stringify({commands:[]}));
} else if (args.includes('--dry=json')) {
  process.stdout.write(JSON.stringify({tasks:[{taskId:'fixture#' + args[1],package:'fixture'}]}));
} else {
  fs.readFileSync('README.md', 'utf8');
  process.stdout.write('synthetic committed fixture check completed\n');
}
`, { mode: 0o700 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const invoke = (script, args, input) => {
    const result = runNode(script, args, home, env, input);
    if (result.status !== 0) throw new Error(JSON.stringify(result.json));
    return result.json;
  };
  let sequence = 0;
  const turn = (action, primaryOwner, requestId, continuations) => {
    const grant = { worktree, agentRoot: pluginRoot, agentName: primaryOwner ? "vibe-change-worker" : "vibe-environment-worker",
      workerId: primaryOwner?.workerId ?? `node-dispatch-helper-${++sequence}`,
      requestId: primaryOwner?.requestId ?? requestId ?? `node-dispatch-${sequence}`, mode: "record", recordAction: action,
      exclusiveRecordTurn: true, ...(primaryOwner ? { primaryOwner: { workerId: primaryOwner.workerId, lease: primaryOwner.lease } } : {}),
      ...(primaryOwner?.transactionId ? { mainSyncTransactionId: primaryOwner.transactionId } : {}),
      ...(continuations ? { mainSyncRequestContinuations: continuations } : {}) };
    if (!grant.mainSyncTransactionId && action !== "create") {
      grant.mainSyncTransactionId = JSON.parse(readFileSync(path.join(metadata, "vibe-main-sync.json"), "utf8")).transactionId;
    }
    const acquired = invoke(state, ["acquire-record"], grant);
    const context = { runtime: "codex", worktree, agentName: grant.agentName, workerId: grant.workerId,
      requestId: grant.requestId, mode: "record", recordAction: action, lease: acquired.lease,
      ...(grant.mainSyncTransactionId ? { mainSyncTransactionId: grant.mainSyncTransactionId } : {}),
      ...(continuations ? { mainSyncRequestContinuations: continuations } : {}) };
    return { context, finish: () => invoke(state, ["release-record"], { ...grant, lease: acquired.lease,
      stoppedTurn: { runtime: "codex", workerId: grant.workerId, requestId: grant.requestId, lease: acquired.lease, state: "completed" } }) };
  };
  const prepare = turn("create");
  let transactionId;
  try { transactionId = invoke(path.join(scripts, "commit-worktree.mjs"), ["--prepare-main-sync", "--worktree", worktree],
    { context: prepare.context }).mainSync.transactionId; }
  finally { prepare.finish(); }
  const primary = { worktree, workerId: "node-dispatch-primary", requestId: "node-dispatch-validation" };
  invoke(state, ["register"], { worktree, workerId: primary.workerId, runtime: "codex", agentRoot: pluginRoot,
    agentName: "vibe-change-worker", capabilities: [] });
  invoke(state, ["enqueue"], { ...primary, input: "Validate committed dispatch fixture" });
  const claimed = invoke(state, ["claim"], primary);
  const validation = turn("progress", { ...primary, lease: claimed.turn.lease, transactionId });
  try { invoke(sessions, ["main-sync-validate", "--worktree", worktree], { context: validation.context }); }
  finally { validation.finish(); }
  invoke(state, ["finish"], { ...primary, lease: claimed.turn.lease, status: "DONE", stoppedTurn: {
    runtime: "codex", workerId: primary.workerId, requestId: primary.requestId, lease: claimed.turn.lease, state: "completed" } });
  const continuationId = "node-dispatch-current-operation";
  const publish = turn("redeploy", undefined, undefined, [{ runtime: "codex", requestId: continuationId, recordAction: "flags" }]);
  try { invoke(sessions, ["main-sync-push", "--worktree", worktree], { context: publish.context }); }
  finally { publish.finish(); }
  const consumer = turn("flags", undefined, continuationId);
  return { run: (args) => runNode(sessions, args, home, env, { context: consumer.context }), finish: consumer.finish };
}

/** A synthetic checker with the same narrow initializer extension point. */
export function portableSurfaceChecker(entries = []) {
  return [
    'const infrastructurePattern = /^@repo\\/design-system$/;',
    "const portableSurfaceAllowlist = new Set([",
    ...entries.map((entry) => `  ${JSON.stringify(entry)},`),
    "]);",
    "export const accepts = (specifier) => portableSurfaceAllowlist.has(specifier);",
    "",
  ].join("\n");
}
