import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CACHED_RESULT, cachedRecord, findReusable, laneCacheKey, Provenance, scopeHash } from "./lane-cache.mjs";
import { git, makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-pr-lanes.mjs");
const INPUTS = { command: "pnpm test:lane", tree: "t".repeat(40), base: "b".repeat(40), config: ["node 24"], scope: "s".repeat(64) };

test("the key is a deterministic hash and changes with every input", () => {
  const key = laneCacheKey(INPUTS);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(laneCacheKey({ ...INPUTS }), key);
  assert.equal(laneCacheKey({ ...INPUTS, command: " pnpm test:lane " }), key, "whitespace around the command is not an input");
  assert.equal(laneCacheKey({ ...INPUTS, config: ["node 24", "a"] }) === laneCacheKey({ ...INPUTS, config: ["a", "node 24"] }), true, "config order is not an input");
  for (const change of [{ command: "pnpm test:other" }, { tree: "u".repeat(40) }, { base: "c".repeat(40) }, { config: [] }, { config: ["node 22"] }, { scope: "x".repeat(64) }]) {
    assert.notEqual(laneCacheKey({ ...INPUTS, ...change }), key, JSON.stringify(change));
  }
  assert.throws(() => laneCacheKey({ ...INPUTS, tree: "" }), /needs tree/);
});

test("only a fresh pass with a key is reusable; a cached, failed, main-preexisting or key-less record never is", () => {
  const key = laneCacheKey(INPUTS);
  const fresh = { command: INPUTS.command, head: "h1", result: "pass", provenance: Provenance.Fresh, cacheKey: key, at: "t" };
  assert.equal(findReusable([fresh], key), fresh);
  assert.equal(findReusable([{ ...fresh, result: "fail" }], key), undefined);
  assert.equal(findReusable([{ ...fresh, result: "main-preexisting" }], key), undefined);
  assert.equal(findReusable([{ ...fresh, cacheKey: undefined }], key), undefined);
  assert.equal(findReusable([{ ...fresh, result: CACHED_RESULT, provenance: Provenance.Cached }], key), undefined);
  assert.equal(findReusable([{ ...fresh, result: "pass", provenance: Provenance.Cached }], key), undefined, "a cached record is never a source");
  assert.equal(findReusable([fresh], null), undefined);
  assert.equal(findReusable([fresh], laneCacheKey({ ...INPUTS, scope: "y".repeat(64) })), undefined);
});

test("a cached record is never a pass", () => {
  const record = cachedRecord({ command: "c", head: "h2", key: "k", source: { head: "h1", at: "t" } });
  assert.equal(record.result, CACHED_RESULT);
  assert.notEqual(record.result, "pass");
  assert.equal(record.provenance, Provenance.Cached);
  assert.deepEqual(record.reusedFrom, { head: "h1", at: "t" });
});

function session(t) {
  const { root, home, cleanup } = makeHome("vibe-lane-cache-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "a.txt"), "one\n");
  git(worktree, ["add", "a.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const base = git(worktree, ["rev-parse", "HEAD"], home).trim();
  writeFileSync(path.join(worktree, "b.txt"), "change\n");
  git(worktree, ["add", "b.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "change"], home);
  // Two reports naming the same lane with different detail text: main's own selection (the report's laneKey) differs, the cache key does not.
  const reportA = path.join(root, "lanes-a.txt");
  const reportB = path.join(root, "lanes-b.txt");
  writeFileSync(reportA, "    pnpm test:lane (1 changed path(s))\n");
  writeFileSync(reportB, "    pnpm test:lane (2 changed path(s))\n");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const head = () => git(worktree, ["rev-parse", "HEAD"], home).trim();
  const records = () => JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  const check = (report, ...extra) => run("check", "--worktree", worktree, "--report", report, "--base", base, ...extra);
  const fresh = (...extra) => run("record", "--worktree", worktree, "--head", head(), "--command", "pnpm test:lane", "--result", "pass", "--report", reportA, "--base", base, ...extra);
  return { worktree, home, base, run, head, records, check, fresh, reportA, reportB };
}

test("a fresh pass records its provenance and key, and --reuse-cache covers a lane main's own selection misses, recorded and printed as cached", (t) => {
  const s = session(t);
  const first = s.head();
  assert.equal(s.fresh().status, 0);
  assert.equal(s.records()[0].provenance, "fresh");
  assert.match(s.records()[0].cacheKey, /^[0-9a-f]{64}$/);
  const plain = s.check(s.reportB);
  assert.equal(plain.status, 1, "another report's selection has no pass");
  assert.match(plain.stdout, /^MISSING-LANE pnpm test:lane:/m);
  const reused = s.check(s.reportB, "--reuse-cache");
  assert.equal(reused.status, 0, reused.stdout + reused.stderr);
  assert.match(reused.stdout, new RegExp(`^CACHED-LANE pnpm test:lane \\(reused from ${first.slice(0, 12)}: .*not a fresh run\\)$`, "m"));
  assert.match(reused.stdout, /1 lanes, 0 missing, 1 cached/);
  const stored = s.records().find((record) => record.result === "cached");
  assert.equal(stored.provenance, "cached");
  assert.equal(stored.reusedFrom.head, first);
  assert.equal(s.check(s.reportB).status, 1, "a cached record is not a pass for a check that did not opt in");
});

test("a changed tree, base, config or scope invalidates the cached result", (t) => {
  const s = session(t);
  assert.equal(s.fresh("--config", "node 24").status, 0);
  const cached = (...extra) => s.check(s.reportB, "--reuse-cache", "--config", "node 24", ...extra);
  assert.equal(cached().status, 0);
  assert.equal(s.check(s.reportB, "--reuse-cache", "--config", "node 22").status, 1, "config changed");
  assert.equal(s.check(s.reportB, "--reuse-cache").status, 1, "config dropped");
  const otherBase = git(s.worktree, ["rev-parse", "HEAD"], s.home).trim();
  assert.equal(cached("--base", otherBase).status, 1, "base changed");
  writeFileSync(path.join(s.worktree, "b.txt"), "edited\n");
  git(s.worktree, ["commit", "--quiet", "-am", "content change"], s.home);
  assert.equal(cached().status, 1, "tree and scope changed");
});

test("a failed run or a run with no resolvable base is never reused", (t) => {
  const s = session(t);
  assert.equal(s.run("record", "--worktree", s.worktree, "--head", s.head(), "--command", "pnpm test:lane", "--result", "fail", "--report", s.reportA, "--base", s.base).status, 1);
  assert.equal(s.check(s.reportB, "--reuse-cache").status, 1);
  const noBase = s.run("record", "--worktree", s.worktree, "--head", s.head(), "--command", "pnpm test:lane", "--result", "pass", "--report", s.reportA);
  assert.equal(noBase.status, 0);
  assert.equal(s.records().at(-1).cacheKey, undefined, "no origin/main and no --base: no key is stored");
  assert.equal(s.check(s.reportB, "--reuse-cache").status, 1);
});

test("scopeHash is stable for the same changes and differs when a changed blob differs", (t) => {
  const s = session(t);
  const one = scopeHash(s.worktree, s.base);
  assert.equal(scopeHash(s.worktree, s.base), one);
  writeFileSync(path.join(s.worktree, "b.txt"), "other\n");
  git(s.worktree, ["commit", "--quiet", "-am", "edit"], s.home);
  assert.notEqual(scopeHash(s.worktree, s.base), one);
  assert.equal(scopeHash(s.worktree, s.head()), "empty");
});
