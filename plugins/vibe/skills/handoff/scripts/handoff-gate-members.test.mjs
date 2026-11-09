import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gatePath, handoffGateProblem, recordHandoffGate } from "./handoff-gate.mjs";
import { captureReviewReceipt, REVIEW_ROLES } from "./review-receipts.mjs";
import { sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { prCreateGuard } from "../../../hooks/pr-create-guard.mjs";

const passingInventory = { ok: true, blocking: { prBody: true, prEvidence: true } };
const TITLE = "ISS-123, ISS-124: Group header counts";

function fixture(t) {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-gate-members-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "vibe/unit", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  git("add", ".");
  git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base");
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const origin = path.join(gitDir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("fetch", "-q", "origin");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ memberTickets: ["ISS-124"] }));
  const file = (name, text) => {
    const target = path.join(gitDir, name);
    writeFileSync(target, text);
    return target;
  };
  const receipts = REVIEW_ROLES.map((role, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const tracePath = file(`${role}.jsonl`, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__closedloop_graph__code_symbols" }] } })}\n${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
    const resultFile = file(`${role}-result.json`, JSON.stringify({ runtime: "claude", agentName: role, status: "DONE", sessionId, requestId: `request-${index}`, tracePath,
      source: sourceIdentity(worktree), graphToolAliases: ["mcp__closedloop_graph__code_symbols"], data: { findings: [] } }));
    const outFile = path.join(gitDir, `${role}-receipt.json`);
    captureReviewReceipt({ worktree, resultFile, outFile, role });
    return outFile;
  });
  const met = (id) => `| ${id} | MET | script | pnpm test |\n`;
  const cells = (ids) => JSON.stringify({ surfaces: ["web"], inputs: ["*"], flags: [], rows: ids.map((criterion) => ({ criterion, surface: "web", input: "*", evidence: "not input-driven: unit test" })) });
  return {
    gitDir,
    worktree,
    receipts,
    body: file("body.md", "Delivers ISS-123 and ISS-124.\n"),
    ticket: file("ticket.md", "- Acceptance criteria:\n  - [ ] Rows reorder\n"),
    member: file("member.md", "- Acceptance criteria:\n  - [ ] The group header shows its count\n"),
    audit: (ids) => file("audit.md", ids.map(met).join("")),
    matrix: (ids) => file("matrix.json", cells(ids)),
  };
}

test("the gate runs the real criteria audit over each member ticket it is given (ISS-13924)", (t) => {
  const { gitDir, worktree, receipts, body, ticket, member, audit, matrix } = fixture(t);
  const inventoryArgs = [];
  // The criteria audit runs for real; only the inventory, which needs a whole repository, is stubbed.
  const runScript = (command, args, options) => {
    if (args[0].endsWith("criteria-audit.mjs")) return spawnSync(command, args, options);
    inventoryArgs.push(args);
    return { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" };
  };
  const gate = (members, ids, title = "ISS-123, ISS-124: Group header counts") =>
    recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members, title }, { runScript });

  assert.throws(() => gate([`ISS-124=${member}`], ["AC-1"]), /acceptance criteria audit failed[\s\S]*ISS-124:AC-1: not audited/,
    "a member's unmet criterion fails the gate");
  assert.throws(() => gate([], ["AC-1"]), /member ISS-124 is recorded on the session but has no --member body/,
    "a recorded member the gate was not given fails it");
  assert.deepEqual(inventoryArgs, [], "no inventory runs once the audit fails");

  gate([`ISS-124=${member}`], ["AC-1", "ISS-124:AC-1"]);
  assert.deepEqual(inventoryArgs[0].filter((arg, index, all) => all[index - 1] === "--ticket"), [ticket, member], "the inventory reads the member's asks too");
  assert.equal(JSON.parse(readFileSync(gatePath(worktree), "utf8")).evidence.members[0].path, member);
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
  writeFileSync(member, "- Acceptance criteria:\n  - [ ] The group header shows its count\n  - [ ] A new criterion\n");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), "handoff member ticket evidence changed");
  writeFileSync(member, "- Acceptance criteria:\n  - [ ] The group header shows its count\n");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
  // vibe-sessions.mjs touch --member-ticket after the gate passed
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ memberTickets: ["ISS-124", "ISS-125"] }));
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), "the session's member tickets changed since the handoff gate");
});

test("with member tickets the gate needs a PR title, and the title and body must name every member", (t) => {
  const { worktree, receipts, body, ticket, member, audit, matrix } = fixture(t);
  const runScript = (command, args, options) => (args[0].endsWith("criteria-audit.mjs") ? spawnSync(command, args, options)
    : { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" });
  const ids = ["AC-1", "ISS-124:AC-1"];
  const gate = (title) => recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members: [`ISS-124=${member}`], title }, { runScript });
  assert.throws(() => gate(undefined), /pass --title so the gate checks the PR names them/);
  assert.throws(() => gate("ISS-123: Group header counts"), /the PR title does not name member ticket ISS-124/);
  writeFileSync(body, "Delivers ISS-123 and ISS-1240.\n");
  assert.throws(() => gate("ISS-123, ISS-124: Group header counts"), /the PR body does not name member ticket ISS-124/);
  writeFileSync(body, "Delivers ISS-123 and ISS-124.\n");
  gate("ISS-123, ISS-124: Group header counts");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
});

test("at PR creation the hook refuses a title that leaves a member ticket unnamed, or no title", (t) => {
  const { worktree, receipts, body, ticket, member, audit, matrix } = fixture(t);
  const runScript = (command, args, options) => (args[0].endsWith("criteria-audit.mjs") ? spawnSync(command, args, options)
    : { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" });
  const ids = ["AC-1", "ISS-124:AC-1"];
  recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members: [`ISS-124=${member}`], title: TITLE }, { runScript });
  const create = (titleArgs) => prCreateGuard({ cwd: worktree, transcript_path: null, tool_input: { command: `gh pr create --base main ${titleArgs} --body-file ${body}` } });
  assert.equal(create(`--title "${TITLE}"`), null);
  assert.equal(create(`--title="${TITLE}"`), null);
  assert.equal(create(`-t "${TITLE}"`), null);
  assert.match(create('--title "ISS-123: Group header counts"')?.reason ?? "", /the PR title does not name member ticket ISS-124/);
  assert.match(create("--fill")?.reason ?? "", /pass --title so the gate checks the PR names them/);
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body }) === null, false, "without a title the gate is not satisfied");
});
