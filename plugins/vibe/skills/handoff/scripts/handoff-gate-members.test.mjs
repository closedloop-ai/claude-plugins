import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { parseRunsEvidence, recordHandoffGate } from "./handoff-gate.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { captureReviewReceipt, REVIEW_ROLES } = await vibeCore("lib/handoff/scripts/review-receipts.mjs");
const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { prCreateGuard } = await vibeCore("hooks/pr-create-guard.mjs");
const { gatePath, handoffGateProblem } = await vibeCore("lib/handoff/scripts/handoff-gate-check.mjs");
import { bindProviderInProcess, seedAlignedDecisionTable } from "../../vibe/scripts/test-fixtures.mjs";

// These read live tracker tickets, so they run bound to the ClosedLoop provider (spawned scripts inherit it).
bindProviderInProcess(after);

const passingInventory = { ok: true, blocking: { prBody: true, prEvidence: true } };
const TITLE = "ISS-123, ISS-124: Group header counts";

test("verifier evidence rejects duplicate importer keys before JSON parsing can overwrite them", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-gate-duplicate-importers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "runs.json");
  writeFileSync(file, '{"qaImpactRequest":{"graphImporters":{"importers":[{"file":"src/a.ts","importers":["src/a.stories.tsx"]}],"importers":[]}}}');
  assert.throws(() => parseRunsEvidence(file), /duplicate JSON key importers/);
  writeFileSync(file, '{"qaImpactRequest":{"graphImporters":{"importers":[{"file":"src/a.ts","importers":["src/a.stories.tsx"]}]}}}');
  assert.equal(parseRunsEvidence(file).qaImpactRequest.graphImporters.importers.length, 1);
  writeFileSync(file, '{"qaImpactRequest":{"graphImporters":{"importers":[],"impor\\u0074ers":[{"file":"src/a.ts","paths":[]}]}}}');
  assert.throws(() => parseRunsEvidence(file), /duplicate JSON key importers/);
});

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
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ticket: "ISS-123", memberTickets: ["ISS-124"] }));
  seedAlignedDecisionTable(worktree);
  const file = (name, text) => {
    const target = path.join(gitDir, name);
    writeFileSync(target, text);
    return target;
  };
  const receipts = REVIEW_ROLES.map((role, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const tracePath = file(`${role}.jsonl`, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__closedloop_graph__code_symbols" }] } })}\n${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
    const resultFile = file(`${role}-result.json`, JSON.stringify({ runtime: "claude", agentName: role, status: "DONE", sessionId, requestId: `request-${index}`, tracePath, worktree: realpathSync(worktree),
      source: sourceIdentity(worktree), graphToolAliases: ["mcp__closedloop_graph__code_symbols"], data: { findings: [] } }));
    const outFile = path.join(gitDir, `${role}-receipt.json`);
    captureReviewReceipt({ worktree, resultFile, outFile, role });
    return outFile;
  });
  const met = (id) => `| ${id} | MET | script | pnpm test |\n`;
  writeFileSync(path.join(gitDir, "sessions-web.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const reviewRows = (ids) => ids.flatMap((criterion) => [
    { criterion, part: "code", verdict: "MET", ref: "file.txt:1" },
    { criterion, part: "visual", verdict: "MET", page: "Sessions", surface: "Web", capture: "sessions-web.png" },
  ]);
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
    review: (ids) => file("review.json", JSON.stringify({ pages: ["Sessions"], surfaces: ["Web"], listQueries: [], rows: reviewRows(ids) })),
  };
}

test("the gate runs the real criteria audit over each member ticket it is given, with the unit's review of the completed work", (t) => {
  const { gitDir, worktree, receipts, body, ticket, member, audit, matrix, review } = fixture(t);
  const inventoryArgs = [];
  // The criteria audit runs for real; only the inventory, which needs a whole repository, is stubbed.
  const runScript = (command, args, options) => {
    if (args[0].endsWith("criteria-audit.mjs")) return spawnSync(command, args, options);
    inventoryArgs.push(args);
    return { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" };
  };
  const gate = (members, ids, title = "ISS-123, ISS-124: Group header counts", reviewed = ids) =>
    recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members, title, review: review(reviewed) }, { runScript });

  assert.throws(() => gate([`ISS-124=${member}`], ["AC-1"]), /acceptance criteria audit failed[\s\S]*ISS-124:AC-1: not audited/,
    "a member's unmet criterion fails the gate");
  assert.throws(() => gate([], ["AC-1"]), /member ISS-124 is recorded on the session but has no --member body/,
    "a recorded member the gate was not given fails it");
  assert.throws(() => recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(["AC-1", "ISS-124:AC-1"]), matrix: matrix(["AC-1", "ISS-124:AC-1"]), members: [`ISS-124=${member}`], title: TITLE }, { runScript }),
    /this session delivers a unit \(member tickets or a PRD\); pass --review/, "a unit's gate needs the review of the completed work");
  assert.throws(() => gate([`ISS-124=${member}`], ["AC-1", "ISS-124:AC-1"], TITLE, ["AC-1"]),
    /GAP ISS-124 AC-1: no code review row \(file:line\); no visual QA capture for Sessions on Web/, "a member criterion without code review and visual QA fails the gate");
  assert.deepEqual(inventoryArgs, [], "no inventory runs once the audit fails");

  gate([`ISS-124=${member}`], ["AC-1", "ISS-124:AC-1"]);
  assert.ok(inventoryArgs[0].includes("--bound-inputs"), "the inventory authenticates all supplied documents");
  const checkedRuns = inventoryArgs[0][inventoryArgs[0].indexOf("--runs-sha256") + 1];
  assert.match(checkedRuns, /^[0-9a-f]{64}$/, "child inventory receives the fingerprint of the authenticated runs");
  assert.deepEqual(inventoryArgs[0].filter((arg, index, all) => all[index - 1] === "--ticket"), [ticket, member], "the inventory reads the member's asks too");
  const witness = JSON.parse(readFileSync(gatePath(worktree), "utf8"));
  assert.equal(witness.evidence.members[0].path, member);
  assert.equal(witness.unitReviewPassed, true);
  assert.equal(witness.evidence.review.path, path.join(gitDir, "review.json"));
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
  writeFileSync(member, "- Acceptance criteria:\n  - [ ] The group header shows its count\n  - [ ] A new criterion\n");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), "handoff member ticket evidence changed");
  writeFileSync(member, "- Acceptance criteria:\n  - [ ] The group header shows its count\n");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
  const reviewed = readFileSync(path.join(gitDir, "review.json"), "utf8");
  writeFileSync(path.join(gitDir, "review.json"), reviewed.replace("file.txt:1", "file.txt:2"));
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), "handoff review evidence changed");
  writeFileSync(path.join(gitDir, "review.json"), reviewed);
  // vibe-sessions.mjs touch --member-ticket after the gate passed
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ticket: "ISS-123", memberTickets: ["ISS-124", "ISS-125"] }));
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), "the session's member tickets changed since the handoff gate");
});

test("with member tickets the gate needs a PR title while the body names every member", (t) => {
  const { worktree, receipts, body, ticket, member, audit, matrix, review } = fixture(t);
  const runScript = (command, args, options) => (args[0].endsWith("criteria-audit.mjs") ? spawnSync(command, args, options)
    : { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" });
  const ids = ["AC-1", "ISS-124:AC-1"];
  const gate = (title) => recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members: [`ISS-124=${member}`], title, review: review(ids) }, { runScript });
  assert.throws(() => gate(undefined), /pass --title so the gate checks the PR names them/);
  gate("ISS-123: Group header counts");
  writeFileSync(body, "Delivers ISS-123 and ISS-1240.\n");
  assert.throws(() => gate("ISS-123, ISS-124: Group header counts"), /the PR body does not name member ticket ISS-124/);
  writeFileSync(body, "Delivers ISS-123 and ISS-124.\n");
  gate("ISS-123, ISS-124: Group header counts");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body, title: TITLE }), null);
});

test("at PR creation the hook accepts a lead-only title but still requires a title", (t) => {
  const { worktree, receipts, body, ticket, member, audit, matrix, review } = fixture(t);
  const runScript = (command, args, options) => (args[0].endsWith("criteria-audit.mjs") ? spawnSync(command, args, options)
    : { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" });
  const ids = ["AC-1", "ISS-124:AC-1"];
  recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids), members: [`ISS-124=${member}`], title: TITLE, review: review(ids) }, { runScript });
  const create = (titleArgs) => prCreateGuard({ cwd: worktree, transcript_path: null, tool_input: { command: `gh pr create --base main ${titleArgs} --body-file ${body}` } });
  assert.equal(create(`--title "${TITLE}"`), null);
  assert.equal(create(`--title="${TITLE}"`), null);
  assert.equal(create(`-t "${TITLE}"`), null);
  assert.equal(create(`-t"${TITLE}"`), null, "gh accepts a joined short flag");
  assert.equal(create('-t"ISS-123: Group header counts"'), null);
  assert.equal(create('--title "ISS-123: Group header counts"'), null);
  assert.match(create("--fill")?.reason ?? "", /pass --title so the gate checks the PR names them/);
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body }) === null, false, "without a title the gate is not satisfied");
});

test("an active session's gate refuses a body without one Delivery placement line before it records anything", (t) => {
  const { gitDir, worktree, receipts, body, ticket, member, audit, matrix, review } = fixture(t);
  const record = JSON.parse(readFileSync(path.join(gitDir, "vibe-session.json"), "utf8"));
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ...record, status: "active" }));
  const inventoryArgs = [];
  const runScript = (command, args, options) => {
    if (args[0].endsWith("criteria-audit.mjs")) return spawnSync(command, args, options);
    inventoryArgs.push(args);
    return { status: 0, stdout: JSON.stringify(passingInventory), stderr: "" };
  };
  const ids = ["AC-1", "ISS-124:AC-1"];
  const gate = () => recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, ticket, audit: audit(ids), matrix: matrix(ids),
    members: [`ISS-124=${member}`], title: TITLE, review: review(ids) }, { runScript });
  assert.throws(gate, /record one Delivery placement line/);
  assert.deepEqual(inventoryArgs, [], "nothing runs before the body is final");
  writeFileSync(body, "Delivers ISS-123 and ISS-124.\nDelivery placement: unit ISS-123\nDelivery placement: unrelated: twice\n");
  assert.throws(gate, /record one Delivery placement line/, "two placement lines are not one");
  writeFileSync(body, "Delivers ISS-123 and ISS-124.\nDelivery placement: unit ISS-123\n");
  gate();
  assert.equal(inventoryArgs.length, 1);
});
