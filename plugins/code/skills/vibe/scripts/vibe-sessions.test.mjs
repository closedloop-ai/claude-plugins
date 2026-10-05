import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-sessions.mjs");
const SPACED_CHECKOUT = ["Documents", "Closedloop.ai - Active Work", "symphony-alpha"];

function rememberRepo(home, repo) {
  const dir = path.join(home, ".codex", "vibe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ repo }, null, 2)}\n`);
}

function setup(t) {
  const fixture = makeHome("vibe-sessions-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, ...SPACED_CHECKOUT);
  makeCheckout({ root: fixture.root, home: fixture.home, checkout });
  return { ...fixture, checkout };
}

function recordFile(worktree, home) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-session.json");
}

test("repo reports a missing remembered checkout instead of guessing", (t) => {
  const { home } = setup(t);
  const result = runNode(SCRIPT, ["repo"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /vibe-preflight\.sh/);
});

test("repo, list, and new use the remembered checkout, including a path with spaces", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);

  const repo = runNode(SCRIPT, ["repo"], home);
  assert.equal(repo.json.repo, checkout);

  const created = runNode(
    SCRIPT,
    ["new", "--slug", "board-chips", "--summary", "Board chips", "--scope", "draft"],
    home
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.session.worktree, path.join(checkout, ".claude", "worktrees", "andy-board-chips"));
  assert.deepEqual(created.json.session.localFixes, []);

  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    listed.json.sessions.map((session) => [session.slug, session.localFixes]),
    [["board-chips", []]]
  );
});

test("--repo wins over the remembered checkout", (t) => {
  const { root, home, checkout } = setup(t);
  const other = path.join(root, "elsewhere", "symphony-alpha");
  makeCheckout({ root, home, checkout: other });
  rememberRepo(home, checkout);
  const result = runNode(SCRIPT, ["repo", "--repo", other], home);
  assert.equal(result.json.repo, other);
});

test("local-fix records paths per ticket, merges repeats, and list reports them", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const { json } = runNode(
    SCRIPT,
    ["new", "--slug", "fix-me", "--summary", "Fix me", "--scope", "draft"],
    home
  );
  const worktree = json.session.worktree;

  const first = runNode(
    SCRIPT,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-1", "--path", "scripts/b.sh", "--path", "./apps/app/a.ts"],
    home
  );
  assert.equal(first.status, 0, first.stderr);
  runNode(SCRIPT, ["local-fix", "--worktree", worktree, "--ticket", "ISS-1", "--path", "scripts/b.sh", "--path", "scripts/c.sh"], home);
  runNode(SCRIPT, ["local-fix", "--worktree", worktree, "--ticket", "ISS-2", "--path", "apps/api/d.ts"], home);

  const record = JSON.parse(readFileSync(recordFile(worktree, home), "utf8"));
  assert.deepEqual(
    record.localFixes.map((fix) => [fix.ticket, fix.paths]),
    [
      ["ISS-1", ["apps/app/a.ts", "scripts/b.sh", "scripts/c.sh"]],
      ["ISS-2", ["apps/api/d.ts"]],
    ]
  );
  assert.equal(record.summary, "Fix me");

  // touch keeps the fixes it does not know about.
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--summary", "Renamed"], home);
  const listed = runNode(SCRIPT, ["list"], home);
  assert.deepEqual(
    listed.json.sessions[0].localFixes.map((fix) => fix.ticket),
    ["ISS-1", "ISS-2"]
  );
});

test("local-fix rejects paths outside the worktree and missing inputs", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const { json } = runNode(
    SCRIPT,
    ["new", "--slug", "guarded", "--summary", "Guarded", "--scope", "draft"],
    home
  );
  const worktree = json.session.worktree;
  const cases = [
    [["--ticket", "ISS-1", "--path", "/etc/hosts"], /relative to the worktree/],
    [["--ticket", "ISS-1", "--path", "../outside.ts"], /relative to the worktree/],
    [["--ticket", "ISS-1"], /--path is required/],
    [["--path", "scripts/a.sh"], /--ticket is required/],
    [["--ticket", "not a slug", "--path", "scripts/a.sh"], /ClosedLoop slug/],
  ];
  for (const [args, message] of cases) {
    const result = runNode(SCRIPT, ["local-fix", "--worktree", worktree, ...args], home);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.json.error, message);
  }
  const record = JSON.parse(readFileSync(recordFile(worktree, home), "utf8"));
  assert.deepEqual(record.localFixes, []);
});
