import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chatEnv, run, tempRoot } from './fleet-home-test-fixture.mjs';

test("AC-089 settled one-writer closure prints the verified PR state and ends its program", t => {
  const root = tempRoot(t);
  const home = path.join(root, "fleet");
  const env = { ...chatEnv("single-ticket"), PATH: root + path.delimiter + process.env.PATH };
  assert.equal(run(["start", "p", "--shape", "one-writer", "--home", home], env).status, 0);
  writeFileSync(path.join(home, "programs/p/terminal-prs.txt"), "sample/repo 7\n");
  const gh = path.join(root, "gh");
  writeFileSync(gh, "#!/bin/sh\necho OPEN\n", { mode: 0o700 });
  assert.notEqual(run(["close", "--settled", "--home", home], env).status, 0);
  assert.ok(existsSync(path.join(home, "current")));
  writeFileSync(gh, "#!/bin/sh\necho MERGED\n");
  const board = path.join(home, "programs/p/board.json");
  writeFileSync(board, JSON.stringify({writers: {current: {status: "done", worktree: root}}}));
  assert.match(run(["close", "--settled", "--home", home], env).stderr, /current.*handoff/i);
  writeFileSync(board, JSON.stringify({writers: {}}));
  const closed = run(["close", "--settled", "--home", home], env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /sample\/repo#7 merged; this session can be closed/);
  assert.equal(existsSync(path.join(home, "current")), false);
});

test("settled closure leaves the completed handoff's successor watcher alone", t => {
  const root = tempRoot(t), home = path.join(root, "fleet");
  const env = { ...chatEnv("outgoing-owner") };
  assert.equal(run(["start", "p", "--shape", "no-writer", "--home", home], env).status, 0);
  const dir = path.join(home, "programs/p"), stamp = "2026-10-10T12:00:00Z";
  writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ outgoingChat: "outgoing-owner", writtenAt: stamp, completedAt: stamp }));
  const successor = JSON.stringify({ pid: 2147483647, startedAt: "2026-10-10T12:01:00Z" });
  writeFileSync(path.join(dir, "watcher.json"), successor);
  const closed = run(["close", "--settled", "--home", home], env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(readFileSync(path.join(dir, "watcher.json"), "utf8"), successor);
});

test("a predecessor's completed handoff grants no closure to the successor", t => {
  const home = path.join(tempRoot(t), "fleet");
  const env = chatEnv("new-owner");
  assert.equal(run(["start", "p", "--shape", "no-writer", "--home", home], env).status, 0);
  const handoff = { outgoingChat: "old-owner", writtenAt: "2026-10-10T12:00:00Z", completedAt: "2026-10-10T12:00:00Z" };
  writeFileSync(path.join(home, "programs/p/handoff.json"), JSON.stringify(handoff));
  assert.match(run(["close", "--settled", "--home", home], env).stderr, /No completed handoff or terminal PR/);
  assert.ok(existsSync(path.join(home, "current")));
});
