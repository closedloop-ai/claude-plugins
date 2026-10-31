import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";
import { processInfo } from "./session-processes.mjs";
import { withVerifyStorybook } from "./verify-storybook-process.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-storybook-process.mjs");

test("an owned static Storybook build server closes after success and failure", async (t) => {
  const fixture = makeHome("vibe-verify-static-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout: worktree });
  const staticDir = path.join(worktree, "apps", "storybook", "storybook-static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "ready");
  const served = await withVerifyStorybook(worktree, 6123, async (url) => (await fetch(url)).text(), { staticDir });
  assert.equal(served, "ready");
  const record = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home), "vibe-verify-storybook-6123.json");
  assert.equal(existsSync(record), false);
  await assert.rejects(withVerifyStorybook(worktree, 6124, async () => { throw new Error("comparison failed"); }, { staticDir }), /comparison failed/);
  assert.equal(existsSync(path.join(path.dirname(record), "vibe-verify-storybook-6124.json")), false);
});

test("SIGINT stops a pending owned base server before another handler can exit 130", async () => {
  const signals = new EventEmitter();
  const events = [];
  signals.on("SIGINT", () => events.push("caller exit"));
  const ready = new Promise(() => {});
  const running = withVerifyStorybook("fake-base", 6125, async () => {}, {
    signalEmitter: signals,
    startOwned: async () => { events.push("base started"); return { pid: 2_147_480_000 }; },
    waitReady: async () => ready,
    stopOwnedSync: () => { events.push("base stopped"); },
    stopOwned: async () => { events.push("base stopped"); },
    setExitCode: (code) => { events.push(`exit ${code}`); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGINT");
  await assert.rejects(running, /SIGINT/);
  assert.deepEqual(events, ["base started", "base stopped", "exit 130", "caller exit"]);
});

test("SIGINT during base startup waits for its owned stop before replaying exit", async () => {
  const signals = new EventEmitter();
  const events = [];
  signals.on("SIGINT", () => events.push("caller exit"));
  let completeStart;
  const running = withVerifyStorybook("fake-base", 6126, async () => {}, {
    signalEmitter: signals,
    startOwned: () => new Promise((resolve) => { completeStart = resolve; }),
    stopOwnedSync: () => { events.push("sync stop"); },
    stopOwned: async () => { events.push("base stopped"); },
    waitReady: async () => { throw new Error("must not wait after interrupt"); },
    setExitCode: (code) => { events.push(`exit ${code}`); },
  });
  signals.emit("SIGINT");
  completeStart({ pid: 2_147_480_001 });
  await assert.rejects(running, /SIGINT/);
  assert.deepEqual(events, ["exit 130", "base stopped", "caller exit"]);
});

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
