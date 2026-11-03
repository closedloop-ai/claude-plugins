import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { lanesTouchedSince } from "./pre-pr-lanes.mjs";
import { git, makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-pr-lanes.mjs");
const UNIT = "pnpm --filter @repo/api test";
const LINT = "pnpm lint";
const REPORT = `IN THE TURBO GRAPH: 2 lanes\n    ${UNIT}\n    ${LINT}\n`;

function fixture(t) {
  const { root, home, cleanup } = makeHome("vibe-lanes-unaffected-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  const commit = (message, files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirpSync(path.dirname(path.join(worktree, file)));
      writeFileSync(path.join(worktree, file), text);
    }
    git(worktree, ["add", "-A"], home);
    git(worktree, ["commit", "--quiet", "-m", message], home);
    return git(worktree, ["rev-parse", "HEAD"], home).trim();
  };
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, REPORT);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const request = (boundary, files) => {
    const file = path.join(root, "impact.json");
    writeFileSync(file, JSON.stringify({ lastQa: { boundary }, evidence: { screens: [] }, laneSelections: { files } }));
    return file;
  };
  return { root, home, worktree, commit, report, run, request };
}

function mkdirpSync(dir) {
  spawnSync("mkdir", ["-p", dir]);
}

test("a lane the changes since an earlier fresh pass do not touch is reused as cached, never as a pass", (t) => {
  const { worktree, commit, report, run, request } = fixture(t);
  const first = commit("base", { "README.md": "docs\n", "apps/api/a.ts": "export const a = 1;\n", "apps/web/b.ts": "export const b = 1;\n" });
  for (const lane of [UNIT, LINT]) assert.equal(run("record", "--worktree", worktree, "--head", first, "--command", lane, "--result", "pass", "--report", report).status, 0);
  commit("docs only", { "README.md": "more docs\n" });
  const selections = { "README.md": [LINT], "apps/api/a.ts": [UNIT], "apps/web/b.ts": [LINT] };

  const off = run("check", "--worktree", worktree, "--report", report);
  assert.equal(off.status, 1, "off by default: a new tree has no record");
  assert.match(off.stdout, /^MISSING-LANE /m);

  const reused = run("check", "--worktree", worktree, "--report", report, "--reuse-unaffected", request(first, selections));
  assert.equal(reused.status, 0, reused.stdout + reused.stderr);
  assert.equal([...reused.stdout.matchAll(/^CACHED-LANE /gm)].length, 2, "a docs-only change touches no lane");
  assert.match(reused.stdout, /not a fresh run/);
  const records = JSON.parse(readFileSync(path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], "").trim() || "", "vibe-lane-results.json"), "utf8"));
  const cached = records.filter((record) => record.unaffectedSince);
  assert.deepEqual(cached.map((record) => record.result), ["cached", "cached"]);
  assert.ok(cached.every((record) => record.unaffectedSince === first && record.reusedFrom.head === first));
  assert.equal(run("check", "--worktree", worktree, "--report", report, "--reuse-unaffected", request(first, selections)).status, 0, "idempotent on a second check");
});

test("a lane a changed file names is not reused, and neither is any lane when a changed file names none", (t) => {
  const { worktree, commit, report, run, request } = fixture(t);
  const first = commit("base", { "README.md": "docs\n", "apps/api/a.ts": "export const a = 1;\n", "apps/web/b.ts": "export const b = 1;\n" });
  for (const lane of [UNIT, LINT]) run("record", "--worktree", worktree, "--head", first, "--command", lane, "--result", "pass", "--report", report);
  commit("api change", { "apps/api/a.ts": "export const a = 2;\n" });
  const selections = { "README.md": [LINT], "apps/api/a.ts": [UNIT], "apps/web/b.ts": [LINT] };
  const partial = run("check", "--worktree", worktree, "--report", report, "--reuse-unaffected", request(first, selections));
  assert.equal(partial.status, 1);
  assert.match(partial.stdout, new RegExp(`^MISSING-LANE ${UNIT.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "m"));
  assert.match(partial.stdout, new RegExp(`^CACHED-LANE ${LINT}`, "m"));
});

test("only a pass recorded at the boundary commit is reused, not one recorded at another head", (t) => {
  const { worktree, commit, report, run, request } = fixture(t);
  const first = commit("base", { "README.md": "docs\n", "apps/api/a.ts": "export const a = 1;\n" });
  const second = commit("docs", { "README.md": "docs 2\n" });
  const selections = { "README.md": [LINT], "apps/api/a.ts": [UNIT] };
  for (const lane of [UNIT, LINT]) run("record", "--worktree", worktree, "--head", second, "--command", lane, "--result", "pass", "--report", report);
  commit("docs 3", { "README.md": "docs 3\n" });
  const atOtherHead = run("check", "--worktree", worktree, "--report", report, "--reuse-unaffected", request(first, selections));
  assert.equal(atOtherHead.status, 1, "the pass was at the second commit, not the boundary");
  const atBoundary = run("check", "--worktree", worktree, "--report", report, "--reuse-unaffected", request(second, selections));
  assert.equal(atBoundary.status, 0);
});

test("lanesTouchedSince: outcome None touches nothing, a changed file without a lane entry proves nothing", () => {
  assert.deepEqual([...lanesTouchedSince({ laneSelections: {} }, { outcome: "None", changedFiles: ["README.md"] })], []);
  assert.deepEqual([...lanesTouchedSince({ laneSelections: { files: { "a.ts": [UNIT], "b.ts": [LINT, UNIT] } } }, { outcome: "Lanes only", changedFiles: ["a.ts", "b.ts"] })].sort(), [LINT, UNIT].sort());
  assert.equal(lanesTouchedSince({ laneSelections: { "a.ts": [UNIT] } }, { outcome: "Lanes only", changedFiles: ["a.ts", "c.tsx"] }), null);
  assert.equal(lanesTouchedSince({ laneSelections: { "a.ts": [] } }, { outcome: "Visual QA", changedFiles: ["a.ts"] }), null);
});
