import { realpathSync } from "node:fs";
import { completeCapturePng } from "../../../lib/vibe/scripts/required-visual-qa.mjs";
import { encodePng } from "./png-diff.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { visualQaBodySection } from "../../../lib/vibe/scripts/required-visual-qa.mjs";
import { recordHandoffGate, visualQaGate } from "./handoff-gate.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { bindProviderInProcess, seedAlignedDecisionTable } from "../../vibe/scripts/test-fixtures.mjs";

const { captureReviewReceipt, REVIEW_ROLES } = await vibeCore("lib/handoff/scripts/review-receipts.mjs");
const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { prCreateGuard } = await vibeCore("hooks/pr-create-guard.mjs");
const { gatePath, handoffGateProblem } = await vibeCore("lib/handoff/scripts/handoff-gate-check.mjs");

// The bound provider declares the repository's UI paths (recipes.areas.ui) the gate reads through the session.
bindProviderInProcess(after);

const runScript = () => ({ status: 0, stdout: JSON.stringify({ ok: true, blocking: { prBody: true, prEvidence: true } }), stderr: "" });

/** A vibe worktree whose branch changes `changed` over a pushed main, with review receipts for that source. */
function fixture(t, changed) {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-gate-visual-qa-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "vibe/visual", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const gitDir = git("rev-parse", "--absolute-git-dir");
  execFileSync("git", ["init", "--bare", "-q", path.join(gitDir, "origin.git")]);
  git("remote", "add", "origin", path.join(gitDir, "origin.git"));
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("fetch", "-q", "origin");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const commit = (file) => {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), `${file}\n`);
    git("add", ".");
    git("commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  const heads = changed.map(commit);
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ ticket: "ISS-123" }));
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
  const body = file("body.md", "Delivers ISS-123.\n");
  const findings = (value) => {
    const png = "fixture-preview.png";
    file(png, encodePng({ width: 1, height: 1, data: Buffer.alloc(4) }));
    const record = { ...value, rounds: [{ id: "fixture", head: value.head, runtime: "web", captures: [{
      png, surface: "web", target: "/", viewport: "1280x800", theme: "light", paths: changed,
      overflow: { width: 1280, height: 800, checkedContainers: 1, entries: [] },
    }] }] };
    const currentBody = readFileSync(body, "utf8").split("\n## Visual QA\n", 1)[0].trimEnd();
    writeFileSync(body, currentBody + "\n\n" + visualQaBodySection(record) + "\n");
    return file("findings.json", JSON.stringify(record));
  };
  const gate = (visualQa) => recordHandoffGate({ worktree, base: "main", body, runs: receipts[0], receipts, visualQa }, { runScript });
  // The hook reads the binding as the harness hands it: the chat id on the event.
  const create = (prefix = "") => prCreateGuard({ cwd: worktree, session_id: process.env.CLAUDE_CODE_SESSION_ID, transcript_path: null, tool_input: { command: `${prefix}gh pr create --base main --title "ISS-123: Header" --body-file ${body}` } });
  return { worktree, git, heads, body, findings, gate, create };
}

test("a UI diff opens no pull request without visual QA findings for its current tree", (t) => {
  const { worktree, heads, findings, gate, create } = fixture(t, ["apps/app/header.tsx", "apps/app/footer.tsx"]);
  const head = heads.at(-1);
  assert.throws(() => gate(undefined), /visual QA is required \(2 changed file\(s\) under the repository's UI paths[\s\S]*no visual QA findings file/);
  assert.equal(existsSync(gatePath(worktree)), false, "no witness is written");
  assert.match(create()?.reason ?? "", /handoff gate has not passed/);

  assert.throws(() => gate(findings({ head: heads[0], findings: [] })), /ran on [0-9a-f]{40}, not the current source/, "findings for an older tree are refused");
  assert.throws(() => gate(findings({ head, findings: [{ id: "F1", summary: "clipped", route: "/", viewport: "1280", selector: "h1", touchedSurface: true }] })),
    /F1: a finding on a touched surface needs disposition/);

  const passing = findings({ head, findings: [{ id: "F1", summary: "Header clips the title", touchedSurface: true, disposition: "ticket: ISS-900" }] });
  gate(passing);
  const witness = JSON.parse(readFileSync(gatePath(worktree), "utf8"));
  assert.equal(witness.visualQa.required, true);
  assert.equal(witness.visualQa.findings.path, passing);
  assert.equal(create(), null, "the hook lets the gated PR open");

  writeFileSync(passing, JSON.stringify({ head, findings: [] }));
  assert.match(create()?.reason ?? "", /visual QA is required \(2 changed file\(s\)[^)]*\): handoff visual QA findings changed since the gate/, "the hook refuses findings edited after the gate");
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: path.join(path.dirname(passing), "body.md"), title: "ISS-123: Header" }), null,
    "the refusal is the visual QA check, not the rest of the witness");
  rmSync(passing);
  assert.match(create()?.reason ?? "", /visual QA findings could not be verified/, "the hook refuses findings deleted after the gate");
});

test("the hook judges the diff itself: a witness without findings opens a non-UI PR and refuses a UI one", (t) => {
  const plain = fixture(t, ["README.md"]);
  plain.gate(undefined);
  const file = gatePath(plain.worktree);
  const { visualQa, ...older } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(visualQa.required, false);
  writeFileSync(file, `${JSON.stringify(older)}\n`);
  assert.equal(plain.create(), null, "a gate older than the visual QA check still opens a PR that changes no UI path");

  const ui = fixture(t, ["apps/app/header.tsx"]);
  ui.gate(ui.findings({ head: ui.heads[0], findings: [] }));
  const witness = gatePath(ui.worktree);
  const { visualQa: bound, ...unbound } = JSON.parse(readFileSync(witness, "utf8"));
  assert.equal(bound.required, true);
  writeFileSync(witness, `${JSON.stringify(unbound)}\n`);
  assert.match(ui.create()?.reason ?? "", /visual QA is required \(1 changed file\(s\)[^)]*\): the handoff gate bound no visual QA findings/);
});

test("an override covers only the checks it names, and never visual QA unless it names it (a 41-file UI PR opened under an unrelated override)", (t) => {
  const { worktree, git, body, create } = fixture(t, ["apps/app/header.tsx"]);
  assert.equal(existsSync(gatePath(worktree)), false);
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: tool false positives on lint.\n");
  assert.match(create()?.reason ?? "", /handoff gate has not passed/, "a bare override covers nothing");
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: handoff gate: tool false positives on lint.\n");
  assert.match(create()?.reason ?? "", /visual QA is required \(1 changed file\(s\)[^)]*\): the handoff gate bound no visual QA findings[\s\S]*visual QA: <reason>/,
    "an override naming other checks leaves visual QA enforced");
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: handoff gate, visual QA: the capture tool cannot sign in here.\n");
  assert.equal(create(), null, "naming visual QA with a reason overrides it");
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: handoff gate, visual check: tool false positives.\n");
  assert.match(create()?.reason ?? "", /handoff gate has not passed/, "a line with a name that is no check covers nothing");
  git("update-ref", "-d", "refs/remotes/origin/main");
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: handoff gate: tool false positives on lint.\n");
  assert.match(create()?.reason ?? "", /visual QA is required \(the guard cannot read the PR diff, so it is treated as changing UI\)/,
    "a diff the guard cannot read is treated as changing UI");
});

test("an override path has no gate witness, so it takes visual QA findings named inline, as gh pr merge does", (t) => {
  const { git, heads, body, findings, create } = fixture(t, ["apps/app/header.tsx"]);
  rmSync(path.join(git("rev-parse", "--absolute-git-dir"), "vibe-session.json"));
  writeFileSync(body, "Delivers ISS-123.\nVibe gate override: ISS-900: session record: the session record was lost.\n");
  assert.match(create()?.reason ?? "", /visual QA is required \(1 changed file\(s\)[^)]*\): no visual QA findings were named[\s\S]*VISUAL_QA_FINDINGS=<findings\.json> gh pr create/,
    "the override path names the inline way forward");
  const named = findings({ head: heads[0], findings: [] });
  assert.equal(create(`VISUAL_QA_FINDINGS=${named} `), null, "findings named inline for the PR head satisfy visual QA");
  writeFileSync(named, JSON.stringify({ head: "0".repeat(40), findings: [] }));
  assert.match(create(`VISUAL_QA_FINDINGS=${named} `)?.reason ?? "", /visual QA is required \(1 changed file\(s\)[^)]*\): (?!no visual QA findings were named)/,
    "findings for another head are refused");
  assert.match(create("VISUAL_QA_FINDINGS=$UNSET_FINDINGS ")?.reason ?? "", /no visual QA findings were named/, "a value the guard cannot read names nothing");
});

test("a diff outside the UI paths passes without findings and records why", (t) => {
  const { worktree, gate, create } = fixture(t, ["apps/api/route.ts"]);
  gate(undefined);
  const { visualQa } = JSON.parse(readFileSync(gatePath(worktree), "utf8"));
  assert.deepEqual(visualQa, { required: false, reason: "no changed file is under the repository's UI paths", findings: null });
  assert.equal(create(), null);
});

test("a repository with no declared UI paths passes with the reason", (t) => {
  const { worktree, git, heads } = fixture(t, ["apps/app/header.tsx"]);
  const verdict = visualQaGate(worktree, git("rev-parse", "origin/main"), heads[0], undefined, null);
  assert.equal(verdict.required, false);
  assert.match(verdict.reason, /declares no UI paths/);
  assert.deepEqual(verdict.problems, []);
});

test("uncommitted UI changes are never covered by findings for the commit", (t) => {
  const { worktree, git, heads, findings } = fixture(t, ["apps/app/header.tsx"]);
  const covered = findings({ head: heads[0], findings: [] });
  assert.deepEqual(visualQaGate(worktree, git("rev-parse", "origin/main"), heads[0], covered).problems, []);
  writeFileSync(path.join(worktree, "apps/app/header.tsx"), "edited\n");
  assert.match(visualQaGate(worktree, git("rev-parse", "origin/main"), heads[0], covered).problems[0], /uncommitted UI changes \(apps\/app\/header\.tsx\)/);
});

test("a visual capture has a complete raster", () => {
  const png = encodePng({ width: 1, height: 1, data: Buffer.alloc(4) });
  assert.equal(completeCapturePng(png), true);
  assert.equal(completeCapturePng(png.subarray(0, 8)), false);
  assert.equal(completeCapturePng(png.subarray(0, -1)), false);
});
