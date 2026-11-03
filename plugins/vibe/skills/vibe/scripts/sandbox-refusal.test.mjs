import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isSandboxRefusal } from "./sandbox-refusal.mjs";
import { makeHome } from "./test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = { CODEX_SANDBOX_NETWORK_DISABLED: "1" };

/** A home whose ~/.codex the run cannot write, as Codex's default sandbox refuses it. */
function lockedHome(t) {
  const fixture = makeHome("vibe-sandbox-refusal-");
  const codex = path.join(fixture.home, ".codex");
  mkdirSync(codex, { recursive: true });
  chmodSync(codex, 0o500);
  t.after(() => { chmodSync(codex, 0o700); fixture.cleanup(); });
  return fixture;
}

function run(script, args, home, env = {}) {
  return spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, ...env } });
}

test("only a refused write inside Codex's sandbox asks for an escalated rerun (ISS-13321)", () => {
  const refused = Object.assign(new Error("EPERM: operation not permitted, mkdir '/home/.codex/vibe'"), { code: "EPERM" });
  assert.equal(isSandboxRefusal(refused, SANDBOX), true);
  assert.equal(isSandboxRefusal(refused, {}), false, "outside Codex's sandbox it is an ordinary failure");
  assert.equal(isSandboxRefusal(new Error("ENOENT: no such file"), SANDBOX), false);
});

test("session-questions reports a refused write for an escalated rerun, never a generic failure (ISS-13321)", (t) => {
  const { home } = lockedHome(t);
  const args = ["ask", "--key", "copy", "--question", "Which words?", "--default", "keep the current words", "--deadline-minutes", "10"];
  const sandboxed = run("session-questions.mjs", args, home, SANDBOX);
  assert.equal(sandboxed.status, 1);
  const output = JSON.parse(sandboxed.stdout);
  assert.deepEqual([output.ok, output.escalate, output.justification], [false, true, "Save the questions for this vibe session"]);
  const plain = JSON.parse(run("session-questions.mjs", args, home).stdout);
  assert.equal(plain.escalate, undefined);
  assert.match(plain.error, /EACCES|EPERM|permission/i);
});

test("image-head reports a refused record for an escalated rerun (ISS-13321)", (t) => {
  const { home } = lockedHome(t);
  const args = ["record", "--project", "cl-e2e", "--worktree", home, "--head", "a".repeat(40), "--records",
    path.join(home, ".codex", "vibe", "locks", "e2e-images"), "--", "docker", "compose", "up", "--build"];
  const sandboxed = run("image-head.mjs", args, home, SANDBOX);
  assert.equal(sandboxed.status, 1);
  assert.equal(JSON.parse(sandboxed.stdout).escalate, true);
});
