import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CACHED_RESULT, cachedRecord, findReusable, laneCacheKey, Provenance, scopeHash } from "./lane-cache.mjs";
import { STAGING_IDENTITY_KEY } from "./pre-pr-lanes.mjs";
import { sourceIdentity } from "./tested-head.mjs";
import { git, makeHome, mockLaneReporter } from "./test-fixtures.mjs";

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
  writeFileSync(reportA, "OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    pnpm test:lane (1 changed path(s))\n");
  writeFileSync(reportB, "OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    pnpm test:lane (2 changed path(s))\n");
  const reporter = mockLaneReporter(root, readFileSync(reportA, "utf8"));
  const env = { ...process.env, HOME: home, PATH: reporter.path };
  delete env[STAGING_IDENTITY_KEY];
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  const head = () => git(worktree, ["rev-parse", "HEAD"], home).trim();
  const records = () => JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  const check = (report, ...extra) => run("check", "--phase", "first-candidate", "--worktree", worktree, "--report", report, "--base", base, ...extra);
  const fresh = (...extra) => run("record", "--phase", "first-candidate", "--worktree", worktree, "--head", head(), "--command", "pnpm test:lane", "--result", "pass", "--report", reportA, "--base", base, ...extra);
  return { root, worktree, home, base, reporter, run, head, records, check, fresh, reportA, reportB };
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
  rmSync(path.join(s.worktree, ".git", "vibe-lane-selection.json"));
  assert.equal(s.check(s.reportB).status, 1, "a cached record is not a pass for a check that did not opt in");
  writeFileSync(path.join(s.worktree, ".git", "vibe-lane-results.json"),
    `${JSON.stringify(s.records().filter((record) => record.result !== "pass"), null, 2)}\n`);
  assert.equal(s.check(s.reportB, "--reuse-cache").status, 1,
    "a cached row cannot remain usable after its fresh source is gone");
});

test("a cache reuse keeps the unavailable E2E lane's not-run record", (t) => {
  const s = session(t);
  assert.equal(s.fresh().status, 0);
  const report = path.join(s.root, "mixed-lanes.txt");
  writeFileSync(report, "OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    pnpm test:lane\n    pnpm test:e2e\n");
  writeFileSync(s.reporter.canonical, readFileSync(report, "utf8"));
  const checked = s.run("check", "--phase", "first-candidate", "--worktree", s.worktree,
    "--report", report, "--reuse-cache", "--base", s.base);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /CACHED-LANE pnpm test:lane/);
  assert.match(checked.stdout, /NOT-RUN-LANE pnpm test:e2e/);
  assert.deepEqual(s.records().filter((record) => record.command === "pnpm test:e2e").map((record) => record.result), ["not-run"]);
  assert.deepEqual(s.records().filter((record) => record.command === "pnpm test:lane" && record.result === "cached").map((record) => record.provenance), ["cached"]);
});

test("both reuse modes retain their cached lanes and an unavailable E2E record", (t) => {
  const s = session(t);
  const lint = "pnpm lint";
  const web = "pnpm test:e2e";
  const report = path.join(s.root, "first-lanes.txt");
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    pnpm test:lane\n    ${lint}\n`);
  writeFileSync(s.reporter.canonical, readFileSync(report, "utf8"));
  writeFileSync(path.join(s.worktree, "README.md"), "docs before\n");
  git(s.worktree, ["add", "README.md"], s.home);
  git(s.worktree, ["commit", "--quiet", "-m", "docs before"], s.home);
  const first = s.head();
  for (const command of ["pnpm test:lane", lint]) assert.equal(s.run("record", "--phase", "first-candidate", "--worktree", s.worktree,
    "--head", first, "--command", command, "--result", "pass", "--report", report, "--base", s.base).status, 0);
  assert.equal(s.run("check", "--phase", "first-candidate", "--worktree", s.worktree, "--report", report).status, 0);
  writeFileSync(path.join(s.worktree, "README.md"), "docs after\n");
  git(s.worktree, ["add", "README.md"], s.home);
  git(s.worktree, ["commit", "--quiet", "-m", "docs only"], s.home);
  const source = sourceIdentity(s.worktree);
  const selected = (name, commands) => {
    const file = path.join(s.root, name);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, source, producer: "code_tests_for_changes", boundary: first,
      fileCoverage: [{ file: "README.md", status: "tests_found", tests: ["README.test.mjs"], commands }],
      lanes: commands.map((command) => ({ command, reason: `selected ${command}` })) }));
    return file;
  };
  const priorSelection = selected("prior-selection.json", ["pnpm test:lane"]);
  assert.equal(s.run("record", "--phase", "followup", "--worktree", s.worktree, "--head", s.head(),
    "--command", "pnpm test:lane", "--result", "pass", "--code-tests", priorSelection, "--base", s.base).status, 0);
  const impact = path.join(s.root, "impact.json");
  writeFileSync(impact, JSON.stringify({ lastQa: { boundary: first }, evidence: { screens: [] },
    laneSelections: { files: { "README.md": [lint] } } }));
  const checked = s.run("check", "--phase", "followup", "--worktree", s.worktree,
    "--code-tests", selected("selected.json", ["pnpm test:lane", lint, web]),
    "--reuse-cache", "--base", s.base, "--reuse-unaffected", impact);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal([...checked.stdout.matchAll(/^CACHED-LANE /gm)].length, 2);
  assert.match(checked.stdout, /NOT-RUN-LANE pnpm test:e2e/);
  assert.deepEqual(s.records().filter((record) => record.result === "cached").map((record) => record.command).sort(), ["pnpm test:lane", lint].sort());
  assert.deepEqual(s.records().filter((record) => record.command === web).map((record) => record.result), ["not-run"]);
});

test("a changed tree, base, config or scope invalidates the cached result", (t) => {
  const s = session(t);
  assert.equal(s.fresh("--config", "node 24").status, 0);
  const cached = (...extra) => s.check(s.reportB, "--reuse-cache", "--config", "node 24", ...extra);
  assert.equal(cached().status, 0);
  rmSync(path.join(s.worktree, ".git", "vibe-lane-selection.json"));
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
  assert.equal(s.run("record", "--phase", "first-candidate", "--worktree", s.worktree, "--head", s.head(), "--command", "pnpm test:lane", "--result", "fail", "--report", s.reportA, "--base", s.base).status, 1);
  assert.equal(s.check(s.reportB, "--reuse-cache").status, 1);
  const noBase = s.run("record", "--phase", "first-candidate", "--worktree", s.worktree, "--head", s.head(), "--command", "pnpm test:lane", "--result", "pass", "--report", s.reportA);
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
