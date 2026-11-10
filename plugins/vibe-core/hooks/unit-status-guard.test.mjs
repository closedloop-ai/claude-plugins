import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { UPDATE_DOCUMENT_TOOL, unitStatusProblem } from "./unit-status-guard.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");

function fleetHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "unit-status-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = path.join(home, "programs", "p1");
  mkdirSync(path.join(program, "evidence"), { recursive: true });
  writeFileSync(path.join(home, "current"), "p1\n");
  writeFileSync(path.join(program, "board.json"), JSON.stringify({ writers: { w1: { pr: "7", repo: "o/r" } }, units: {
    "ISS-1": { tickets: ["ISS-1", "ISS-2"], writer: "w1" },
    "ISS-8": { tickets: ["ISS-8"], writer: "w1", closed: { pr: "o/r#6", at: "then" } },
  } }));
  const review = (record) => writeFileSync(path.join(program, "evidence", "unit-review-ISS-1.json"), JSON.stringify(record));
  return { home, review };
}

test("a fleet unit's ticket moves to IN_REVIEW or DONE only after the unit's recorded review passed", (t) => {
  const { home, review } = fleetHome(t);
  const move = (slug, status) => unitStatusProblem({ slug, status, cwd: home, home });
  assert.match(move("ISS-2", "IN_REVIEW"), /^ISS-2 stays IN_PROGRESS, not IN_REVIEW: unit ISS-1 has no recorded review/);
  assert.match(move("ISS-1", "DONE"), /not DONE/);
  assert.equal(move("ISS-2", "IN_PROGRESS"), null, "starting work is never held");
  assert.equal(move("ISS-3", "DONE"), null, "a ticket in no unit is not held");
  assert.equal(move("ISS-8", "DONE"), null, "a closed unit is finished");
  review({ ok: false, gaps: [{}], problems: [] });
  assert.match(move("ISS-2", "IN_REVIEW"), /unit ISS-1's review has 1 gaps and 0 problems/);
  review({ ok: true, tickets: ["ISS-1", "ISS-2"] });
  assert.equal(move("ISS-2", "IN_REVIEW"), null);
});

test("a vibe session delivering a unit needs its handoff gate's unit review before its tickets move", (t) => {
  const worktree = mkdtempSync(path.join(tmpdir(), "unit-status-session-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", worktree]);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const noHome = path.join(worktree, "no-fleet-home");
  const move = (slug) => unitStatusProblem({ slug, status: "IN_REVIEW", cwd: worktree, home: noHome });
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ticket: "ISS-5" }));
  assert.equal(move("ISS-5"), null, "a single-ticket session is not a unit");
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ticket: "ISS-5", memberTickets: ["ISS-6"] }));
  assert.match(move("ISS-6"), /this vibe session delivers a unit and its handoff gate has not passed the unit review/);
  assert.match(move("ISS-5") ?? "", /^ISS-5 stays IN_PROGRESS/);
  assert.equal(move("ISS-7"), null, "another ticket is not this session's");
  writeFileSync(path.join(gitDir, "vibe-handoff-gate.json"), JSON.stringify({ unitReviewPassed: false }));
  assert.notEqual(move("ISS-6"), null);
  writeFileSync(path.join(gitDir, "vibe-handoff-gate.json"), JSON.stringify({ unitReviewPassed: true }));
  assert.equal(move("ISS-6"), null);
});

test("the PreToolUse hook routes update-document to the guard and denies an unreviewed unit ticket's move", (t) => {
  const { home } = fleetHome(t);
  assert.deepEqual(PRE_TOOL_USE_ROUTES[UPDATE_DOCUMENT_TOOL].map(({ name }) => name), ["unit-status-guard"]);
  const run = (status) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: UPDATE_DOCUMENT_TOOL, cwd: home, tool_input: { documentId: "ISS-2", status } }),
    env: { ...process.env, FLEET_HOME: home }, encoding: "utf8",
  });
  const denied = JSON.parse(run("DONE").stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /ISS-2 stays IN_PROGRESS, not DONE/);
  assert.equal(run("IN_PROGRESS").stdout.trim(), "");
});
