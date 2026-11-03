import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrationId, migrationProblems } from "./migration-publish.mjs";
import { git, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-publish.mjs");
const FOLDER = "packages/database/prisma/migrations/20261022000000_projection/migration.sql";
const TRIGGER = "CREATE OR REPLACE FUNCTION refresh() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\nCREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW EXECUTE FUNCTION refresh();\n";

test("migration ids come from the folder or the file name", () => {
  assert.equal(migrationId(FOLDER), "20261022000000_projection");
  assert.equal(migrationId("db/migrations/0042_add_index.sql"), "0042_add_index");
  assert.equal(migrationId("apps/api/lib/migrations.ts"), null);
  assert.equal(migrationId("docs/notes.sql"), null);
});

test("a new migration needs a test, and per-row work a measured scale test, before it is pushed", () => {
  const exists = (file) => file === "packages/database/__tests__/projection.test.ts";
  const plain = [{ path: FOLDER, sql: "CREATE INDEX i ON a(b);\n" }];
  assert.match(migrationProblems(plain, "", exists).join(), /no `Migration test: 20261022000000_projection/);
  const tested = "Migration test: 20261022000000_projection: packages/database/__tests__/projection.test.ts\n";
  assert.deepEqual(migrationProblems(plain, tested, exists), []);
  assert.match(migrationProblems(plain, tested.replace("projection.test.ts", "missing.test.ts"), exists).join(), /not a test file at HEAD/);
  const trigger = [{ path: FOLDER, sql: TRIGGER }];
  assert.match(migrationProblems(trigger, tested, exists).join(), /trigger, function or per-row work/);
  const unmeasured = `${tested}Scale test: 20261022000000_projection: packages/database/__tests__/projection.test.ts: looks fine\n`;
  assert.match(migrationProblems(trigger, unmeasured, exists).join(), /needs a test file at HEAD and a measurement/);
  const measured = `${tested}Scale test: 20261022000000_projection: packages/database/__tests__/projection.test.ts: 100k rows, 2.1 ms per insert\n`;
  assert.deepEqual(migrationProblems(trigger, measured, exists), []);
});

test("the command reads only migrations added since the last push and the session change log", (t) => {
  const home = makeHome("vibe-migration-publish-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  };
  put("packages/database/prisma/migrations/20261001000000_old/migration.sql", "CREATE TABLE a (b int);\n");
  git(checkout, ["add", "-A"], home.home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home.home);
  const since = git(checkout, ["rev-parse", "HEAD"], home.home);
  put(FOLDER, TRIGGER);
  git(checkout, ["add", "-A"], home.home);
  git(checkout, ["commit", "--quiet", "-m", "session"], home.home);
  const refused = runNode(SCRIPT, ["--worktree", checkout, "--since", since], home.home);
  assert.equal(refused.status, 1);
  assert.deepEqual(refused.json.migrations, [FOLDER]);
  assert.equal(refused.json.problems.length, 2);
  put("packages/database/__tests__/projection.test.ts", "test();\n");
  git(checkout, ["add", "-A"], home.home);
  git(checkout, ["commit", "--quiet", "-m", "test"], home.home);
  const log = path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], home.home), "vibe-changes.md");
  writeFileSync(log, "Migration test: 20261022000000_projection: packages/database/__tests__/projection.test.ts\nScale test: 20261022000000_projection: packages/database/__tests__/projection.test.ts: 100,000 rows, 2 ms per insert\n");
  const passed = runNode(SCRIPT, ["--worktree", checkout, "--since", since], home.home);
  assert.equal(passed.status, 0, JSON.stringify(passed.json));
});

test("a migration the branch got by merging main is main's, not the session's (ISS-13321)", (t) => {
  const home = makeHome("vibe-migration-publish-main-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  const run = (args) => git(checkout, args, home.home);
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  };
  put("README.md", "base\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "base"]);
  const since = run(["rev-parse", "HEAD"]);
  run(["checkout", "--quiet", "-b", "vibe/session"]);
  put("apps/app/page.tsx", "export const page = 1;\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "session"]);
  run(["checkout", "--quiet", "main"]);
  const fromMain = "packages/database/prisma/migrations/20261028000000_from_main/migration.sql";
  put(fromMain, "ALTER TABLE a ADD COLUMN c int;\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "ISS-13130: a migration on main"]);
  run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  run(["checkout", "--quiet", "vibe/session"]);
  run(["merge", "--quiet", "--no-edit", "main"]);
  const merged = runNode(SCRIPT, ["--worktree", checkout, "--since", since], home.home);
  assert.equal(merged.status, 0, JSON.stringify(merged.json));
  assert.deepEqual(merged.json.migrations, []);
  put(FOLDER, "CREATE TABLE p (q int);\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "session migration"]);
  const own = runNode(SCRIPT, ["--worktree", checkout, "--since", since], home.home);
  assert.equal(own.status, 1);
  assert.deepEqual(own.json.migrations, [FOLDER], "the session's own migration still needs its test");
});
