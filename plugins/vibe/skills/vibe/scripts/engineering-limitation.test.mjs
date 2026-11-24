import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifiedCredentialLimitation } from "./engineering-limitation.mjs";
import { readRecords } from "./pre-pr-lanes.mjs";
import { parseLaneCheck } from "./verify-run.mjs";
import { bodyProblems, evidenceProblems, targetedEvidenceProblems } from "../../handoff/scripts/pr-facts.mjs";

test("DT-07 F08 the lane gate and PR body share a verified engineer-only limitation; a failed run still blocks", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-credential-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, "repo");
  mkdirSync(worktree);
  const git = (...args) => execFileSync("git", ["-C", worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(worktree, "package.json"), JSON.stringify({ scripts: { smoke: ': "${FIXTURE_TEST_TOKEN:?required}" && exit 1' } }));
  writeFileSync(path.join(worktree, "AGENTS.md"), "Report test lanes with `pnpm test:lanes`.\n");
  git("add", "package.json", "AGENTS.md");
  git("commit", "-qm", "validation recipe");
  const report = path.join(dir, "report.txt");
  const command = "npm run smoke";
  writeFileSync(report, "OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    " + command + " (1 changed path)\n");
  const cli = fileURLToPath(new URL("./pre-pr-lanes.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.FIXTURE_TEST_TOKEN;
  const run = (action, extra = [], environment = env) => spawnSync(process.execPath, [cli, action, "--worktree", worktree, "--report", report, "--head", git("rev-parse", "HEAD"), ...extra], { encoding: "utf8", env: environment });
  const check = run("check");
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const [record] = readRecords(worktree);
  assert.equal(record.result, "not-run");
  const [pending] = parseLaneCheck(check.stdout).notRun;
  assert.deepEqual(pending, { lane: command, commit: record.head, laneKey: record.laneKey,
    reason: record.reason, engineeringCredential: record.engineeringCredential });
  const row = { lane: "e2e", status: record.result, command, commit: record.head, laneKey: record.laneKey, reason: record.reason, engineeringCredential: record.engineeringCredential };
  assert.ok(verifiedCredentialLimitation(row, record.source, [record], worktree));
  const facts = { overlap: [], assertionChanges: [], contractChanges: [], asks: [], refusals: [] };
  for (const key of ["runs", "testRuns"]) {
    const problems = body => bodyProblems(body, facts, [], "main", "", { [key]: [row] });
    assert.ok(problems("## Engineering review\nPending").some(problem => problem.includes("credential limitation")));
    assert.ok(!problems("## Engineering review\n" + row.reason).some(problem => problem.includes("credential limitation")));
  }
  const evidence = { source: record.source, touchFlows: [], touchFlowsReason: "test only", runs: [row], testRuns: [row],
    testSelection: [], rerunCycles: [], targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: record.head,
      impactKey: record.laneKey, entries: [], noTestsReason: "lane only", laneReport: { command: "pnpm test:lanes", matches: [{ name: "e2e", command }] } } };
  const host = () => evidenceProblems(evidence, ["e2e/smoke.spec.ts"], record.head, worktree);
  const targeted = () => targetedEvidenceProblems(evidence, record.head, worktree);
  assert.deepEqual(host(), []);
  assert.deepEqual(targeted(), []);
  assert.equal(run("run", ["--command", command], { ...env, FIXTURE_TEST_TOKEN: "fixture" }).status, 1);
  assert.equal(run("check").status, 1);
  assert.equal(verifiedCredentialLimitation(row, record.source, readRecords(worktree), worktree), false);
  assert.match(host().join(), /unfinished or failed/);
  assert.match(targeted().join(), /no passing run/);
});
