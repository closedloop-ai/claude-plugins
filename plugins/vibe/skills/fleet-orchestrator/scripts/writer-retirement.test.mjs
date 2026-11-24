import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { worktreePresence, writerRetirement } from "./writer-retirement.mjs";

const SCRIPT = fileURLToPath(new URL("./board.mjs", import.meta.url));
const REPO = "acme/app";
const NOW = "2026-11-20T00:10:00.000Z";
const LATER = "2026-11-20T00:11:00.000Z";

function fixture(t, states = {}, rows = {}) {
  const f = makeHome("vibe-retire-board-");
  t.after(f.cleanup);
  const fleet = path.join(f.root, "fleet-home");
  const dir = path.join(fleet, "programs", "retire");
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(path.join(fleet, "current"), "retire\n");
  const gh = path.join(f.root, "gh");
  const fake = path.join(f.root, "pr.json");
  const board = path.join(dir, "board.json");
  const writers = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, {
    repo: REPO, worktree: path.join(f.root, name), head: "old", updatedAt: NOW, ...row,
  }]));
  writeFileSync(fake, JSON.stringify(states));
  writeFileSync(gh, "#!" + process.execPath + "\n" + `const fs=require("node:fs"), [, , group, action, number, ...args]=process.argv;
const {states, repo} = {states: JSON.parse(fs.readFileSync(${JSON.stringify(fake)})), repo:${JSON.stringify(REPO)}};
if (group !== "pr" || action !== "view") process.exit(1);
const state = states[number]; if (!state || state === "UNAVAILABLE") process.exit(1);
if (args.includes("-q")) console.log("new");
else console.log(JSON.stringify({number:Number(number), url:"https://github.com/"+repo+"/pull/"+number, state}));
`, { mode: 0o700 });
  writeFileSync(board, JSON.stringify({ writers, log: [] }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, dir, ...args], {
    env: { ...process.env, HOME: f.home, BOARD_GH: gh }, encoding: "utf8", timeout: 19_000,
  });
  return { ...f, dir, gh, board, run, data: () => JSON.parse(readFileSync(board, "utf8")) };
}

test("prevention auto-retires exactly bound merged and closed writers before push or watcher warnings", (t) => {
  const f = fixture(t, { 41: "MERGED", 42: "CLOSED" }, { merged: { pr: "41" }, closed: { pr: "42" } });
  const result = f.run("status", "--pushed", "merged=new", "--now", NOW);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /PUSH-READY-UNKNOWN|UNREADY-COMMIT|STALE (?:merged|closed)/);
  const { writers, log } = f.data();
  for (const [name, state, number] of [["merged", "MERGED", 41], ["closed", "CLOSED", 42]]) {
    assert.deepEqual(writers[name].retiredPr, { number, repo: REPO, state, url: `https://github.com/${REPO}/pull/${number}` });
    assert.equal(writers[name].retiredAt, NOW);
  }
  assert.equal(log.length, 1);
  assert.match(readFileSync(path.join(f.dir, "board.md"), "utf8"), /\| merged \| acme\/app#41.*Retired \(pull request 41 merged/);
  assert.deepEqual(f.run("watch-exclusions").stdout.trim().split("\n"), ["writer merged", "pr acme/app 41", "writer closed", "pr acme/app 42"]);
  assert.doesNotMatch(f.run("watch-lines").stdout, /PUSH-READY-UNKNOWN|UNREADY-COMMIT|STALE/);
});

test("prevention preserves open or unknown PRs, an existing worktree, and an active session", (t) => {
  const f = fixture(t, { 41: "OPEN", 42: "UNAVAILABLE", 43: "MERGED", 44: "MERGED" }, {
    open: { pr: "41" }, unknown: { pr: "42" }, exists: { pr: "43" }, active: { pr: "44" },
  });
  mkdirSync(path.join(f.root, "exists"));
  writeFileSync(path.join(f.dir, "sessions", "active.json"), JSON.stringify({ cwd: path.join(f.root, "active"), threadId: "T" }));
  const result = f.run("status", "--now", NOW);
  assert.match(result.stdout, /PUSH-READY-UNKNOWN open/);
  assert.ok(Object.values(f.data().writers).every((row) => !row.retiredAt));
  assert.equal(f.run("watch-exclusions").stdout, "");
  assert.equal(f.run("writer", "active", "--retired", "--pr", "44").status, 2);
});

test("prevention explicit retirement is bound to one PR and preserves idempotent history", (t) => {
  const f = fixture(t, { 41: "MERGED" }, { worker: { pr: "41" } });
  const command = (...args) => f.run("writer", "worker", "--retired", ...args);
  assert.match(command("--pr", "42").stderr, /differs from the writer/);
  assert.equal(command("--pr", "41", "--now", NOW).status, 0);
  const initial = f.data();
  assert.equal(command("--pr", "41", "--now", LATER).status, 0);
  assert.deepEqual(f.data(), initial);
  assert.equal(f.run("writer", "worker", "--pr", "42").status, 2);
  assert.match(f.run("push-check", "worker", "--head", "0123456789").stdout, /writer retired/);
});

test("prevention never projects the local absent path as a remote worktree fact", (t) => {
  const f = fixture(t);
  const row = { pr: "42", repo: REPO, where: "remote", worktree: path.join(f.root, "absent") };
  assert.equal(worktreePresence(row, ""), "unknown");
  const result = writerRetirement({ dir: f.dir, name: "remote", row, at: NOW,
    readPull: () => ({ number: 42, url: "https://github.com/acme/app/pull/42", state: "MERGED" }) });
  assert.match(result.problem, /absence on its owning host is unverified/);
});
