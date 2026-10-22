import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrationOf, migrationOrderProblems } from "./migration-order.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-order.mjs");
const DIR = "db/prisma/migrations";

function repo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-migration-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const add = (name) => {
    mkdirSync(path.join(dir, DIR, name), { recursive: true });
    writeFileSync(path.join(dir, DIR, name, "migration.sql"), `-- ${name}\n`);
  };
  git("init", "--quiet", "-b", "main");
  add("20261001000000_first");
  git("add", "-A");
  git("commit", "--quiet", "-m", "first");
  return { dir, git, add };
}

test("a migration path is any timestamped entry directly under a migrations folder", () => {
  assert.deepEqual(migrationOf("apps/x/prisma/migrations/20261021000000_a/migration.sql"), { dir: "apps/x/prisma/migrations", entry: "20261021000000_a", stamp: "20261021000000" });
  assert.deepEqual(migrationOf("migrations/20261021_a.sql"), { dir: "migrations", entry: "20261021_a.sql", stamp: "20261021" });
  assert.equal(migrationOf("db/migrations/README.md"), null);
  assert.equal(migrationOf("src/migrations-helper/20261021000000.ts"), null);
});

test("a branch migration that sorts before main's newest blocks, and a later rename passes", (t) => {
  const { dir, git, add } = repo(t);
  git("checkout", "--quiet", "-b", "feature");
  add("20261010000000_branch");
  git("add", "-A");
  git("commit", "--quiet", "-m", "branch migration");
  git("checkout", "--quiet", "main");
  add("20261015000000_main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "newer main migration");
  git("checkout", "--quiet", "feature");

  const late = migrationOrderProblems(dir, "main");
  assert.equal(late.checked, true);
  assert.equal(late.problems.length, 1);
  assert.match(late.problems[0], /20261010000000_branch sorts before or with main's newest 20261015000000/);
  const cli = spawnSync(process.execPath, [SCRIPT, "--worktree", dir, "--main", "main"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).ok, false);

  git("mv", `${DIR}/20261010000000_branch`, `${DIR}/20261016000000_branch`);
  git("commit", "--quiet", "-m", "re-mint");
  assert.deepEqual(migrationOrderProblems(dir, "main").problems, []);
});

test("main's own migrations, a folder main lacks and a missing main ref are not problems", (t) => {
  const { dir, git, add } = repo(t);
  git("checkout", "--quiet", "-b", "feature");
  mkdirSync(path.join(dir, "other", "migrations", "20200101000000_new"), { recursive: true });
  writeFileSync(path.join(dir, "other", "migrations", "20200101000000_new", "migration.sql"), "-- new\n");
  add("20261020000000_branch");
  git("add", "-A");
  git("commit", "--quiet", "-m", "branch");
  assert.deepEqual(migrationOrderProblems(dir, "main").problems, []);
  const missing = migrationOrderProblems(dir, "origin/main");
  assert.equal(missing.checked, false);
  assert.match(missing.reason, /not available/);
});

test("vibe-sessions main-sync-push refuses before pushing while a branch migration sorts too early", (t) => {
  const { dir, git, add } = repo(t);
  git("checkout", "--quiet", "-b", "feature");
  add("20261010000000_branch");
  git("add", "-A");
  git("commit", "--quiet", "-m", "branch migration");
  git("checkout", "--quiet", "main");
  add("20261015000000_main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "newer main migration");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("checkout", "--quiet", "feature");
  const sessions = path.join(path.dirname(SCRIPT), "vibe-sessions.mjs");
  const result = spawnSync(process.execPath, [sessions, "main-sync-push", "--worktree", dir], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, "NEEDS_CHANGE");
  assert.match(json.error, /Nothing was pushed: .*20261010000000_branch sorts before or with main's newest 20261015000000/);
});
