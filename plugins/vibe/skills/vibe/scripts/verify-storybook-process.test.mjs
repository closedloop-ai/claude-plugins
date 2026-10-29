import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";
import { processInfo } from "./session-processes.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-storybook-process.mjs");

test("a verifier starts Storybook with a birth witness and stops only that recorded process", (t) => {
  const fixture = makeHome("vibe-verify-storybook-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout: worktree });
  mkdirSync(path.join(worktree, "apps", "storybook"), { recursive: true });
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  const fakePnpm = path.join(bin, "pnpm");
  writeFileSync(fakePnpm, "#!/bin/sh\nexec node -e 'setInterval(() => {}, 1000)' storybook\n");
  chmodSync(fakePnpm, 0o700);
  const start = runNode(SCRIPT, ["start", "--worktree", worktree, "--port", "6120"], fixture.home,
    { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(start.status, 0, start.stderr);
  const pid = start.json.pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } });
  assert.ok(processInfo(pid));
  const privateDir = git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home);
  const ledger = path.join(privateDir, "vibe-verify-storybook-6120.json");
  const saved = JSON.parse(readFileSync(ledger, "utf8"));
  assert.match(saved.stack.storybookIdentity, /^[a-f0-9]{64}$/);

  writeFileSync(ledger, JSON.stringify({ ...saved, stack: { ...saved.stack, storybookIdentity: "0".repeat(64) } }));
  const refused = runNode(SCRIPT, ["stop", "--worktree", worktree, "--port", "6120"], fixture.home);
  assert.equal(refused.status, 1);
  assert.ok(processInfo(pid), "a mismatched birth witness must not signal the process");
  writeFileSync(ledger, JSON.stringify(saved));
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree, "--port", "6120"], fixture.home);
  assert.equal(stopped.status, 0, JSON.stringify(stopped.json));
  assert.equal(stopped.json.results[0].result, "stopped");
  assert.equal(processInfo(pid), null);
});
