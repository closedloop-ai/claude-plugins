import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handoffGateProblem, mergeabilityProblem, recordHandoffGate, resolvePrBase, reviewFindingProblems } from "../skills/handoff/scripts/handoff-gate.mjs";
import { sourceIdentity } from "../skills/vibe/scripts/tested-head.mjs";
import { captureReviewReceipt, REVIEW_ROLES } from "../skills/handoff/scripts/review-receipts.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { createsPullRequest, prCreateGuard, vibeRepository } from "./pr-create-guard.mjs";
import { readHookSkill, recordHookSkill } from "./hook-session-scope.mjs";
import { pluginVersionPromptStart } from "./plugin-version-guard.mjs";

test("vibe PR creation requires a current handoff witness", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-pr-create-"));
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", worktree, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "vibe-session.json"), "{}\n");
  const transcript = path.join(gitDir, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /cache/vibe/skills/vibe" } })}\n`);
  const otherTranscript = path.join(gitDir, "other-transcript.jsonl");
  writeFileSync(otherTranscript, `${JSON.stringify({ type: "user", message: { content: "ordinary repository task" } })}\n`);
  const bodyFile = path.join(gitDir, "body.md");
  writeFileSync(bodyFile, "PR body\n");
  const event = { cwd: worktree, transcript_path: transcript, tool_input: { command: `gh pr create --base main --body-file ${bodyFile}` } };
  assert.equal(prCreateGuard(event)?.decision, "deny");
  assert.equal(prCreateGuard({ ...event, transcript_path: null })?.decision, "deny", "the recorded vibe worktree scopes a null-transcript hook");
  const receipts = REVIEW_ROLES.map((role, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const tracePath = path.join(gitDir, `${role}.jsonl`);
    writeFileSync(tracePath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__closedloop_graph__code_symbols" }] } })}\n${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
    const resultFile = path.join(gitDir, `${role}-result.json`);
    writeFileSync(resultFile, JSON.stringify({ runtime: "claude", agentName: role, status: "DONE", sessionId, requestId: `request-${index}`, tracePath, source: sourceIdentity(worktree), graphToolAliases: ["mcp__closedloop_graph__code_symbols"], data: { findings: [] } }));
    const outFile = path.join(gitDir, `${role}-receipt.json`);
    captureReviewReceipt({ worktree, resultFile, outFile, role });
    return outFile;
  });
  const mark = (inventory, selectedReceipts = receipts) => recordHandoffGate({ worktree, base: "main", body: bodyFile, runs: receipts[0], receipts: selectedReceipts }, {
    runScript: () => ({ status: 0, stdout: JSON.stringify(inventory), stderr: "" }),
  });
  assert.throws(() => mark({ ok: true, blocking: { prBody: true, prEvidence: true } }, []), /need exactly one current launcher receipt/);
  assert.throws(() => mark({ ok: true, blocking: { prBody: true, prEvidence: false } }), /did not pass body and verifier/);
  mark({ ok: true, blocking: { prBody: true, prEvidence: true } });
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile }), null);
  assert.equal(prCreateGuard(event), null);
  assert.equal(prCreateGuard({ cwd: path.dirname(worktree), transcript_path: transcript, tool_input: { command: `bash -lc 'cd ${worktree} && gh pr create --base main --body-file ${bodyFile}'` } }), null);
  assert.equal(prCreateGuard({ cwd: path.dirname(worktree), transcript_path: transcript, tool_input: { command: `pushd ${worktree} && gh pr create --base main --body-file ${bodyFile}` } }), null);
  assert.match(prCreateGuard({ cwd: path.dirname(worktree), transcript_path: transcript, tool_input: { command: `pushd ${worktree} && popd && gh pr create --base main --body-file ${bodyFile}` } })?.reason ?? "", /no vibe session record/);
  assert.match(prCreateGuard({ cwd: path.dirname(worktree), transcript_path: transcript, tool_input: { command: `cd ${worktree} && gh pr create --base wrong --body-file ${bodyFile}` } })?.reason ?? "", /base/);
  assert.match(prCreateGuard({ cwd: path.dirname(worktree), transcript_path: transcript, tool_input: { command: `gh pr create --base main --body-file ${bodyFile}` } })?.reason ?? "", /no vibe session record/);
  assert.match(prCreateGuard({ cwd: worktree, transcript_path: transcript, tool_input: { command: `ssh remote 'gh pr create --base main --body-file ${bodyFile}'` } })?.reason ?? "", /remote/);
  assert.match(prCreateGuard({ cwd: worktree, transcript_path: otherTranscript, tool_input: { command: `ssh remote 'gh pr create --base main --body-file ${bodyFile}'` } })?.reason ?? "", /remote/, "a recorded vibe worktree still scopes a stale transcript");
  assert.match(prCreateGuard({ cwd: worktree, transcript_path: transcript, tool_input: { command: `gh pr create --base main --body-file ${receipts[0]}` } })?.reason ?? "", /body file/);
  writeFileSync(bodyFile, "edited PR body\n");
  assert.match(prCreateGuard(event)?.reason ?? "", /body evidence changed/);
  writeFileSync(bodyFile, "PR body\n");
  assert.equal(prCreateGuard(event), null);
  const oldBase = execFileSync("git", ["-C", worktree, "rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const newerBase = execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit-tree", tree, "-p", oldBase], { input: "new base", encoding: "utf8" }).trim();
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/main", newerBase]);
  assert.match(prCreateGuard(event)?.reason ?? "", /stale for the PR base/);
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/main", oldBase]);
  assert.throws(() => mark({ ok: false }), /inventory/);
  assert.match(prCreateGuard(event)?.reason ?? "", /not passed/);
  mark({ ok: true, blocking: { prBody: true, prEvidence: true } });
  assert.equal(prCreateGuard(event), null);
  writeFileSync(path.join(worktree, "file.txt"), "changed\n");
  assert.match(prCreateGuard(event)?.reason ?? "", /stale/);
  assert.equal(createsPullRequest("env GH_TOKEN=x gh pr create --fill"), true);
  assert.equal(createsPullRequest("gh pr view 10"), false);
  assert.equal(mergeabilityProblem(worktree, "main"), null);
  assert.match(mergeabilityProblem(worktree, "HEAD") ?? "", /name the fetched default/);
  assert.match(mergeabilityProblem(worktree, "vibe/example") ?? "", /cannot be the current feature branch/);
  assert.equal(resolvePrBase(worktree).name, "main");
  const source = sourceIdentity(worktree);
  assert.deepEqual(reviewFindingProblems({ source, findings: [{ id: "F1", blocking: true, disposition: "waived" }] }, source), [
    "blocking review finding F1 remains on the current source",
  ]);
  assert.deepEqual(reviewFindingProblems({ source, findings: [{ id: "F1", blocking: false, evidence: "advisory" }] }, source), []);
  assert.deepEqual(reviewFindingProblems({ source: { ...source, treeSha256: "0".repeat(64) }, findings: [] }, source), [
    "review findings report must cover the current source and list findings",
  ]);
  execFileSync("git", ["-C", worktree, "checkout", "-qb", "base"]);
  writeFileSync(path.join(worktree, "file.txt"), "base-side\n");
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qam", "base-side"]);
  execFileSync("git", ["-C", worktree, "checkout", "-q", "vibe/example"]);
  writeFileSync(path.join(worktree, "file.txt"), "feature-side\n");
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qam", "feature-side"]);
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/base", "base"]);
  assert.match(mergeabilityProblem(worktree, "base") ?? "", /does not merge cleanly/);
  assert.ok(PRE_TOOL_USE_ROUTES.Bash.some(({ run }) => run === prCreateGuard));
});

test("null transcript uses only an active exact-session marker or recorded vibe worktree", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hook-scope-home-"));
  const ordinary = mkdtempSync(path.join(tmpdir(), "hook-scope-repo-"));
  const event = { cwd: ordinary, session_id: "session-a", transcript_path: null, tool_input: { command: "gh pr create --base main --body-file body.md" } };
  assert.equal(prCreateGuard(event, home), null, "ordinary repo without active skill stays untouched");
  pluginVersionPromptStart({ session_id: "session-a", prompt: "$vibe build the requested screen" }, home);
  assert.equal(readHookSkill("session-a", home), "vibe");
  assert.match(prCreateGuard(event, home)?.reason ?? "", /no vibe session record/);
  assert.equal(prCreateGuard({ ...event, session_id: "session-b" }, home), null, "another session cannot borrow the marker");
  recordHookSkill("session-a", "other:skill", home);
  assert.equal(prCreateGuard(event, home), null, "a later unrelated skill clears scope");
  recordHookSkill("session-a", "vibe:fleet-orchestrator", home, new Date("2020-01-01T00:00:00Z"));
  assert.equal(readHookSkill("session-a", home), null);
  assert.equal(prCreateGuard(event, home), null, "stale marker does not scope the session");
});

// PR #371 review: a conversation that once loaded vibe or fleet was refused `gh pr create` in
// every repository for seven days.
test("a vibe-scoped conversation is refused a session-less PR only in a repository with live vibe work", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hook-scope-home-"));
  const repo = (branch) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hook-scope-git-"));
    execFileSync("git", ["init", "-q", "-b", branch, dir]);
    execFileSync("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "base"]);
    return dir;
  };
  const linkedSession = (dir, status) => {
    const linked = path.join(dir, "..", `${path.basename(dir)}-wt`);
    execFileSync("git", ["-C", dir, "worktree", "add", "-q", "-b", `vibe/${path.basename(dir)}`, linked]);
    const gitDir = execFileSync("git", ["-C", linked, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ status }));
  };
  const create = (cwd) => ({ cwd, session_id: "scoped", transcript_path: null, tool_input: { command: "gh pr create --base main --body-file body.md" } });
  pluginVersionPromptStart({ session_id: "scoped", prompt: "/vibe:fleet-orchestrator resume" }, home);
  const unrelated = repo("main");
  assert.equal(vibeRepository(unrelated), false);
  assert.equal(prCreateGuard(create(unrelated), home), null, "a repository with no vibe work is not vibe work");
  const ended = repo("main");
  linkedSession(ended, "handed-off");
  assert.equal(prCreateGuard(create(ended), home), null, "a repository whose vibe sessions were handed off");
  const live = repo("main");
  linkedSession(live, "active");
  assert.match(prCreateGuard(create(live), home)?.reason ?? "", /no vibe session record/, "another worktree's active session makes the repository vibe work");
  assert.match(prCreateGuard(create(repo("vibe/new-page")), home)?.reason ?? "", /no vibe session record/, "a vibe/ branch is vibe work");
  const notRepo = mkdtempSync(path.join(tmpdir(), "hook-scope-plain-"));
  assert.equal(vibeRepository(notRepo), null);
  assert.match(prCreateGuard(create(notRepo), home)?.reason ?? "", /no vibe session record/, "outside a repository nothing proves the PR is unrelated");
  assert.equal(prCreateGuard({ ...create(live), session_id: "unscoped" }, home), null, "an unscoped conversation is untouched");
});
