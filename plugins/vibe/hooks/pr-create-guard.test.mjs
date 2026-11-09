import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handoffGateProblem, mergeabilityProblem, recordHandoffGate, resolvePrBase, reviewFindingProblems } from "../skills/handoff/scripts/handoff-gate.mjs";
import { sourceIdentity } from "../skills/vibe/scripts/tested-head.mjs";
import { captureReviewReceipt, REVIEW_ROLES } from "../skills/handoff/scripts/review-receipts.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { createsPullRequest, prCreateGuard, vibeWorktree } from "./pr-create-guard.mjs";
import { readHookSkill, recordHookSkill } from "./hook-session-scope.mjs";
import { pluginVersionPromptStart } from "./plugin-version-guard.mjs";

test("PR guard separates payload words from direct and nested commands", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "pr-command-home-"));
  const vibe = mkdtempSync(path.join(tmpdir(), "pr-command-vibe-"));
  const ordinary = mkdtempSync(path.join(tmpdir(), "pr-command-ordinary-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(vibe, { recursive: true, force: true });
    rmSync(ordinary, { recursive: true, force: true }); });
  execFileSync("git", ["init", "-q", "-b", "vibe/example", vibe]);
  execFileSync("git", ["init", "-q", "-b", "fix/ordinary", ordinary]);
  recordHookSkill("fleet-pr", "vibe:fleet-orchestrator", home);
  const guard = (cwd, command) => prCreateGuard({ cwd, session_id: "fleet-pr", transcript_path: null,
    tool_input: { command } }, home);
  for (const command of [
    "cat > body.md <<'EOF'\ngh pr create --fill\nEOF",
    "git commit -F - <<'EOF'\ngh pr create --fill\nEOF",
    "cat > body.md <<'EOF'\n$(gh pr create --fill)\nEOF",
    "echo \"$(cat <<'EOF'\ngh pr create --fill\nEOF)\"",
    "printf '%s\\n' 'gh pr create --fill' > body.md",
    "echo 'gh pr create --fill' > body.md",
    "git commit -m 'gh pr create --fill was discussed'",
  ]) assert.equal(guard(vibe, command), null, command);
  for (const command of ["gh pr create --fill", "bash -c 'gh pr create --fill'",
    "sh -c 'gh pr create --fill'", "zsh -lc 'gh pr create --fill'", "eval 'gh pr create --fill'"]) {
    assert.equal(guard(vibe, command)?.decision, "deny", command);
  }
  assert.equal(guard(ordinary, `cd ${vibe} && gh pr create --fill`)?.decision, "deny");
  assert.equal(guard(vibe, "cat <<'EOF'\nbody text\nEOF\ngh pr create --fill")?.decision, "deny");
  assert.equal(guard(vibe, "cat <<EOF\n$(gh pr create --fill)\nEOF")?.decision, "deny");
  assert.equal(guard(vibe, "echo \"$(cat <<'EOF'\nbody text\nEOF\ngh pr create --fill)\"")?.decision, "deny");
  assert.equal(guard(vibe, 'echo "$(gh pr create --fill)"')?.decision, "deny");
  assert.equal(guard(vibe, "ssh host 'gh pr create --fill'")?.decision, "deny");
  assert.match(guard(vibe, 'cd "$UNKNOWN" && gh pr create --fill')?.reason ?? "", /UNKNOWN|unresolved/);
  assert.equal(guard(vibe, `W=${ordinary}; cd "$W" && gh pr create --fill`), null,
    "a concrete non-vibe target in a fleet conversation must pass");
  assert.equal(guard(vibe, `export W=${ordinary}; cd "$W" && gh pr create --fill`), null);
  assert.equal(guard(vibe, `ssh host 'echo done'; cd ${ordinary} && gh pr create --fill`), null,
    "an unrelated remote read cannot turn a later local PR into a remote call");
  assert.equal(prCreateGuard({ cwd: vibe, session_id: "unscoped", transcript_path: null,
    tool_input: { command: "gh pr create --fill" } }, home)?.decision, "deny",
  "a vibe branch is scoped even when no skill marker is active");
  for (const command of [
    `echo "$(gh pr create --fill)" && cd ${ordinary}`,
    `echo $(cd ${ordinary}) && gh pr create --fill`,
    `echo \`cd ${ordinary}\` && gh pr create --fill`,
    `bash -c 'cd ${ordinary}' && gh pr create --fill`,
    `sh -c 'cd ${ordinary}' && gh pr create --fill`,
    `zsh -lc 'cd ${ordinary}' && gh pr create --fill`,
    `(cd ${ordinary}); gh pr create --fill`,
    "(gh pr create --fill)",
    `cd ${ordinary} | cat; gh pr create --fill`,
    "echo safe | gh pr create --fill",
    "eval -- 'gh pr create --fill'",
    "CMD='gh pr create --fill'; eval \"$CMD\"",
    "export CMD='gh pr create --fill'; eval \"$CMD\"",
    "CMD=$(printf 'gh pr create --fill'); eval \"$CMD\"",
    "CMD=$(echo gh pr create --fill); eval \"$CMD\"",
    "CMD=$(echo -n gh pr create --fill); eval \"$CMD\"",
    "CMD=$(printf '%s%s' gh ' pr create --fill'); eval \"$CMD\"",
    "CMD=$(echo -e 'gh pr create --fill\\c ignored'); eval \"$CMD\"",
    "CMD=$(printf '%b ignored' 'gh pr create --fill\\c later'); eval \"$CMD\"",
    "CMD=$(printf '%s ' gh pr create --fill); eval \"$CMD\"",
    "CMD=$(printf '%b' 'g\\x68 pr create --fill'); eval \"$CMD\"",
    "CMD=$(printf '%c%s' g 'h pr create --fill'); eval \"$CMD\"",
    "CMD=$(printf '%4s pr create --fill' gh); eval \"$CMD\"",
    "CMD=$(printf '%*s pr create --fill' 4 gh); eval \"$CMD\"",
    "CMD=$(printf '%-4s pr create --fill' gh); eval \"$CMD\"",
    "CMD=$(printf '%4.2s pr create --fill' ghzz); eval \"$CMD\"",
    "CMD=$(printf '%*.*s pr create --fill' 4 2 ghzz); eval \"$CMD\"",
    "CMD=$(printf '%4b pr create --fill' 'g\\x68'); eval \"$CMD\"",
    "CMD=$(printf '%4c%s pr create --fill' g h); eval \"$CMD\"",
    "CMD=$(printf '%+4s pr create --fill' gh); eval \"$CMD\"",
    "CMD=$(printf '%02s pr create --fill' gh); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create --fill' ignored); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create --fill # %d' 1); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create --fill # %f' 1); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create --fill # %q' value); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create\\n--fill'); eval \"$CMD\"",
    "CMD=$(printf 'g\\x68 pr create --fill'); eval \"$CMD\"",
    "CMD=$(echo -e 'g\\x68 pr create --fill'); eval \"$CMD\"",
    "CMD=$(printf 'g\\0150 pr create --fill'); eval \"$CMD\"",
    "CMD=$(printf '\\u0067h pr create --fill'); eval \"$CMD\"",
    "export CMD=$(printf 'gh pr create --fill'); eval \"$CMD\"",
    "CMD='gh pr create --fill'; bash -c \"$CMD\"",
    "CMD='gh pr create --fill'; sh -c \"$CMD\"",
    "CMD='gh pr create --fill'; zsh -lc \"$CMD\"",
    "bash -c \"$(printf 'gh pr create --fill')\"",
    "sh -c \"$(printf 'gh pr create --fill')\"",
    "eval \"$(printf 'gh pr create --fill')\"",
    "GH=gh; \"$GH\" pr create --fill",
    "gh</dev/null pr create --fill",
    "gh 2>&1 pr create --fill",
    "gh 1>&2 pr create --fill",
    "gh 2>/tmp/gh.log pr create --fill",
    "gh>out.txt pr create --fill",
    "gh -R closedloop-ai/claude-plugins pr create --fill",
    "gh --repo=closedloop-ai/claude-plugins pr create --fill",
    "ssh -E /tmp/ssh.log host 'gh pr create --fill'",
    "ssh -B 127.0.0.1 host 'gh pr create --fill'",
    "# <<EOF\ngh pr create --fill",
    "echo $((1 << 2)); gh pr create --fill",
    "echo \"$((1 << 2))\"; gh pr create --fill",
    "echo $(( $(gh pr create --fill) + 1 ))",
    "gh " + "\\" + "\n" + "pr create --fill",
    "gh pr " + "\\" + "\n" + "create --fill",
  ]) assert.equal(guard(vibe, command)?.decision, "deny", command);
  for (const option of ["-I", "-w", "-c", "-e", "-m", "-O", "-P"]) {
    assert.equal(guard(vibe, `ssh ${option} value host 'gh pr create --fill'`)?.decision, "deny", option);
  }
  for (const command of [
    `cd ${ordinary} && echo "$(gh pr create --fill)"`,
    `(cd ${ordinary} && gh pr create --fill)`,
    "CMD='printf safe'; eval \"$CMD\"",
    "CMD=$(printf safe); eval \"$CMD\"",
    "CMD=$(echo safe); eval \"$CMD\"",
    "CMD=$(echo -n safe); eval \"$CMD\"",
    "CMD=$(echo -E safe); eval \"$CMD\"",
    "CMD=$(printf '%s%s' sa fe); eval \"$CMD\"",
    "CMD=$(echo -e 'safe\\c gh pr create'); eval \"$CMD\"",
    "CMD=$(printf '%b gh pr create' 'safe\\c'); eval \"$CMD\"",
    "CMD=$(printf '%s ' printf safe); eval \"$CMD\"",
    "CMD=$(printf '%b' 'safe\\x20word'); eval \"$CMD\"",
    "CMD=$(printf '%c%s' s afe); eval \"$CMD\"",
    "CMD=$(printf '%4s' safe); eval \"$CMD\"",
    "CMD=$(printf '%*s' 4 safe); eval \"$CMD\"",
    "CMD=$(printf '%4.2s' safe); eval \"$CMD\"",
    "CMD=$(printf '%*.*s' 4 2 safe); eval \"$CMD\"",
    "CMD=$(printf '%04s pr create --fill' gh); eval \"$CMD\"",
    "CMD=$(printf '' 'gh pr create --fill'); eval \"$CMD\"",
    "CMD=$(printf \"\" 'gh pr create --fill'); eval \"$CMD\"",
    "bash -c '' 'gh pr create --fill'",
    "sh -c \"\" 'gh pr create --fill'",
    "gh '' pr create --fill",
    "CMD=$(printf 'printf safe' ignored); eval \"$CMD\"",
    "CMD=$(printf 'printf safe # %d' 1); eval \"$CMD\"",
    "CMD=$(printf 'gh pr create%d' 1); eval \"$CMD\"",
    "CMD=$(printf 'safe\\x20data'); eval \"$CMD\"",
    "CMD=$(printf 'printf %%s safe'); eval \"$CMD\"",
    "CMD=$(cat ./cmd.txt); eval \"$CMD\"",
    "CMD='printf safe'; bash -c \"$CMD\"",
    "eval 'printf %s $HOME'",
    "bash -c \"$(cat ./cmd.txt)\"",
    "bash -c \"$(printf safe)\"",
    "eval \"$UNKNOWN\"",
    "eval -- 'printf safe'",
    "cat <<\\EOF\n$(gh pr create --fill)\nEOF",
    "cat <<E\"OF\"\n$(gh pr create --fill)\nEOF",
    "f() { gh pr create --fill; }",
    "f() { printf safe; }",
    "f; f() { gh pr create --fill; }",
    "function f { gh pr create --fill; }",
    "function f() { gh pr create --fill; }",
    "f; function f { gh pr create --fill; }",
    "f() { gh pr create --fill; } | cat; f",
    "bash -c 'f() { gh pr create --fill; }'; f",
    "f() { gh pr create --fill; }; bash -c 'f'",
    "cat <<'EOF'\nf() { gh pr create --fill; }\nEOF\nf",
  ]) assert.equal(guard(vibe, command), null, command);
  for (const command of [
    "cat <<\\EOF\n$(gh pr create --fill)\nEOF\ngh pr create --fill",
    "cat <<E\"OF\"\n$(gh pr create --fill)\nEOF\ngh pr create --fill",
  ]) assert.equal(guard(vibe, command)?.decision, "deny", command);
  assert.equal(guard(vibe, "f() { gh pr create --fill; }; f")?.decision, "deny");
  assert.equal(guard(vibe, "function f { gh pr create --fill; }; f")?.decision, "deny");
  assert.equal(guard(vibe, "function f() { gh pr create --fill; }; f")?.decision, "deny");
  assert.equal(guard(vibe, `f() { cd ${ordinary}; }; f; gh pr create --fill`), null);
  assert.equal(guard(vibe, `function f { cd ${ordinary}; }; f; gh pr create --fill`), null);
  const chain = (last) => Array.from({ length: 12 }, (_, index) =>
    `f${index}() { ${index === 11 ? last : `f${index + 1}`}; }`).join('; ') + '; f0';
  assert.equal(guard(vibe, chain('gh pr create --fill'))?.decision, 'deny');
  assert.equal(guard(vibe, chain('printf safe')), null);
  assert.equal(guard(vibe, 'f() { f; }; f'), null, 'a function cycle without PR work is not itself a PR');
  assert.equal(guard(vibe, 'f() { gh pr create --fill; f; }; f')?.decision, 'deny');
  const spaces = ' '.repeat(5000);
  assert.equal(guard(vibe, `CMD=$(printf '%s%s' '${spaces}' 'gh pr create --fill'); eval "$CMD"`)?.decision, 'deny');
  assert.equal(guard(vibe, `CMD=$(printf '%s%s' '${spaces}' safe); eval "$CMD"`), null);
  assert.match(guard(vibe, `ssh host 'export W=${ordinary}'; cd "$W" && gh pr create --fill`)?.reason ?? "", /unresolved.*W/);
  assert.equal(guard(vibe, `{ cd ${ordinary}; }; gh pr create --fill`), null);
  assert.equal(guard(vibe, `if true; then cd ${ordinary}; fi; gh pr create --fill`), null);
  assert.equal(guard(vibe, `if false; then cd ${ordinary}; fi; gh pr create --fill`)?.decision, "deny");
  assert.equal(guard(vibe, `cd ${ordinary} <<EOF\n$(gh pr create --fill)\nEOF`)?.decision, "deny");
});

test("vibe PR creation requires a current handoff witness", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-pr-create-"));
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", worktree, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const origin = path.join(gitDir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  execFileSync("git", ["-C", worktree, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", worktree, "push", "-q", "origin", "HEAD:refs/heads/main"]);
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
  assert.equal(prCreateGuard({ ...event, tool_input: { command: `gh pr create -B=main -F=${bodyFile}` } }), null,
    "equals-attached short base and body forms use the same handoff witness");
  assert.equal(prCreateGuard({ ...event, tool_input: { command: `gh pr create -Bmain -F${bodyFile}` } }), null,
    "directly attached short base and body forms use the same witness");
  assert.match(prCreateGuard({ ...event, tool_input: { command: `gh pr create -Bwrong -F${bodyFile}` } })?.reason ?? "", /base/,
    "an attached short base cannot bypass the witnessed base");
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
  assert.equal(createsPullRequest("gh pr new --fill"), true, "the GitHub CLI's new alias is still PR creation");
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

// PR #371 reviews: a conversation that once loaded vibe or fleet was refused `gh pr create` in
// every repository for seven days, and then in every worktree of a repository where any other
// worktree kept an abandoned `active` session record.
test("a vibe-scoped conversation is refused a session-less PR only from a vibe/ branch or outside a repository", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hook-scope-home-"));
  const repo = (branch) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hook-scope-git-"));
    execFileSync("git", ["init", "-q", "-b", branch, dir]);
    execFileSync("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "base"]);
    return dir;
  };
  const linkedSession = (dir, record) => {
    const linked = path.join(dir, "..", `${path.basename(dir)}-wt`);
    execFileSync("git", ["-C", dir, "worktree", "add", "-q", "-b", `vibe/${path.basename(dir)}`, linked]);
    const gitDir = execFileSync("git", ["-C", linked, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify(record));
    return linked;
  };
  const create = (cwd) => ({ cwd, session_id: "scoped", transcript_path: null, tool_input: { command: "gh pr create --base main --body-file body.md" } });
  pluginVersionPromptStart({ session_id: "scoped", prompt: "/vibe:fleet-orchestrator resume" }, home);
  const unrelated = repo("main");
  assert.equal(vibeWorktree(unrelated), false);
  assert.equal(prCreateGuard(create(unrelated), home), null, "a repository with no vibe work is not vibe work");
  const shared = repo("main");
  const abandoned = linkedSession(shared, { status: "active", createdAt: "2026-10-16T00:00:00Z" });
  assert.equal(prCreateGuard(create(shared), home), null, "another worktree's old active record does not decide for this worktree");
  assert.match(prCreateGuard(create(abandoned), home)?.reason ?? "", /gh pr create refused/, "the worktree that owns the record still needs its handoff gate");
  assert.match(prCreateGuard(create(repo("vibe/new-page")), home)?.reason ?? "", /no vibe session record/, "a session-less vibe/ branch is vibe work");
  const notRepo = mkdtempSync(path.join(tmpdir(), "hook-scope-plain-"));
  assert.equal(vibeWorktree(notRepo), null);
  assert.match(prCreateGuard(create(notRepo), home)?.reason ?? "", /no vibe session record/, "outside a repository nothing proves the PR is unrelated");
  assert.equal(prCreateGuard({ ...create(shared), session_id: "unscoped" }, home), null, "an unscoped conversation is untouched");
});

test("AC-1 AC-4 AC-5 AC-7 AC-9 AC-10: a failing vibe gate accepts only a ticketed reason in the PR body", (t) => {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-pr-override-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ branch: "vibe/example", liveTicket: "ISS-13855" }));
  const body = path.join(worktree, "body.md");
  const event = { cwd: worktree, tool_input: { command: `gh pr create --base main --body-file ${body}` } };

  writeFileSync(body, "## Change\nPR guard repair.\n");
  assert.match(prCreateGuard(event)?.reason ?? "", /handoff gate has not passed/, "a recorded session still needs the gate without an override");
  assert.match(prCreateGuard({ cwd: worktree, tool_input: { command: `gh pr new --body-file ${body}` } })?.reason ?? "", /handoff gate has not passed/,
    "the new alias keeps the failing Vibe gate");

  writeFileSync(body, "Vibe gate override: ISS-13855: handoff gate bug refuses the verified PR source.\n");
  assert.equal(prCreateGuard(event), null, "a dedicated ticketed reason is an explicit, auditable exception");
  assert.equal(prCreateGuard({ cwd: worktree, tool_input: { command: `gh pr new -F${body}` } }), null,
    "the new alias accepts the same ticketed body only through its parsed body file");
  assert.equal(prCreateGuard({ cwd: worktree, tool_input: { command: `gh pr create -F=${body}` } }), null,
    "an equals-attached short body file carries the ticketed override");
  assert.equal(prCreateGuard({ cwd: worktree, tool_input: { command: `gh pr create -F${body}` } }), null,
    "a directly attached short body file carries the ticketed override");
  const cloudReceipt = path.join(gitDir, "cloud-worker-iss-13855.json");
  writeFileSync(cloudReceipt, "{}\n");
  assert.match(prCreateGuard(event)?.reason ?? "", /cloud import requires a Vibe-created linked worktree/,
    "the override does not bypass cloud import readiness");
  rmSync(cloudReceipt);

  writeFileSync(body, "Vibe gate override: ISS-13855:   \n");
  assert.equal(prCreateGuard(event)?.decision, "deny", "an empty reason cannot override");
  writeFileSync(body, "Vibe gate override: handoff gate bug refuses the verified PR source.\n");
  assert.equal(prCreateGuard(event)?.decision, "deny", "a reason without a ticket cannot override");
  writeFileSync(body, "ISS-13855 is mentioned elsewhere.\nVibe gate override: handoff gate bug refuses the verified PR source.\n");
  assert.equal(prCreateGuard(event)?.decision, "deny", "a nearby ticket mention is not the override declaration");
  writeFileSync(body, "ISS-13855: handoff gate bug refuses the verified PR source.\n");
  assert.equal(prCreateGuard(event)?.decision, "deny", "a ticket and reason without the explicit marker cannot override");
  assert.equal(prCreateGuard({ cwd: worktree, tool_input: { command: "gh pr create --base main" } })?.decision, "deny", "no submitted body file cannot override");
  writeFileSync(body, "Vibe gate override: ISS-13855: handoff gate bug refuses the verified PR source.\n");
  const linkedBody = path.join(worktree, "body-link.md");
  symlinkSync(body, linkedBody);
  assert.equal(prCreateGuard({ cwd: worktree, tool_input: { command: `gh pr create --body-file ${linkedBody}` } })?.decision, "deny",
    "a symlinked body is not the checked regular file");
  writeFileSync(body, `Vibe gate override: ISS-13855: ${"x".repeat(65536)}\n`);
  assert.equal(prCreateGuard(event)?.decision, "deny", "an oversized body is not read as an override");
});

test("AC-2 AC-6: an explicit proven non-vibe PR head is allowed from a vibe conversation", (t) => {
  const worktree = mkdtempSync(path.join(tmpdir(), "vibe-pr-head-"));
  const home = mkdtempSync(path.join(tmpdir(), "vibe-pr-head-home-"));
  const ordinaryRepo = mkdtempSync(path.join(tmpdir(), "ordinary-pr-head-"));
  const ordinaryOtherWorktree = `${ordinaryRepo}-other`;
  const otherWorktree = `${worktree}-owned`;
  const unrelatedWorktree = `${worktree}-unrelated`;
  t.after(() => { rmSync(otherWorktree, { recursive: true, force: true });
    rmSync(unrelatedWorktree, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    rmSync(ordinaryOtherWorktree, { recursive: true, force: true });
    rmSync(ordinaryRepo, { recursive: true, force: true }); });
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "file.txt"), "base\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  execFileSync("git", ["-C", worktree, "branch", "fix/ordinary"]);
  execFileSync("git", ["-C", worktree, "branch", "fix/unrelated"]);
  execFileSync("git", ["-C", worktree, "remote", "add", "origin", "https://github.com/owner/local-repo.git"]);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ branch: "vibe/example" }));
  recordHookSkill("fleet-head", "vibe:fleet-orchestrator", home);
  const event = (head) => ({ cwd: worktree, session_id: "fleet-head", tool_input: { command: `gh pr create --head ${head} --base main --body-file body.md` } });

  assert.equal(prCreateGuard(event("fix/ordinary"), home), null, "the explicit local head has no vibe session");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh -R owner/local-repo pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "a repository override verified against origin retains the non-vibe allowance");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh -R=owner/local-repo pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "the short equals repository form resolves the same target");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "GH_REPO=owner/other-repo gh -R owner/local-repo pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "an explicit repository flag takes precedence over GH_REPO");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "GH_REPO= gh pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "an empty GH_REPO does not override the local repository");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "GH_REPO=owner/local-repo gh --repo= pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "an empty explicit repository flag falls back to GH_REPO");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh -R owner/other-repo -R owner/local-repo pr create --head fix/ordinary --body-file body.md" } }, home),
    null, "the last explicit repository flag is the PR target");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh -R owner/local-repo -R owner/other-repo pr create --head fix/ordinary --body-file body.md" } }, home)?.decision,
    "deny", "a final mismatched repository flag cannot borrow earlier local proof");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh -R owner/other-repo pr create --head fix/ordinary --body-file body.md" } }, home)?.decision,
    "deny", "a different --repo target cannot borrow the local branch proof");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "GH_REPO=owner/other-repo gh pr create --head fix/ordinary --body-file body.md" } }, home)?.decision,
    "deny", "a different GH_REPO target cannot borrow the local branch proof");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create --head=fix/ordinary --body-file body.md" } }, home), null,
    "the equals form resolves the same proven head");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create -H fix/ordinary --body-file body.md" } }, home), null,
    "the short head form resolves the same proven head");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create -H=fix/ordinary --body-file body.md" } }, home), null,
    "the equals-attached short head form resolves the same proven head");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create -Hfix/ordinary --body-file body.md" } }, home), null,
    "the directly attached short head form resolves the same proven head");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create --head fix/ordinary --body '-H=vibe/new'" } }, home), null,
    "body text that resembles a short flag is data, not a later head override");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create --head= --body-file body.md" } }, home)?.decision,
    "deny", "an explicitly empty head is not proof of non-vibe ownership");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: { command: "gh pr create --head --body-file body.md" } }, home)?.decision,
    "deny", "a valueless head is not proof of non-vibe ownership");
  assert.equal(prCreateGuard(event("missing/ordinary"), home)?.decision, "deny", "an unverified branch is not proof of non-vibe ownership");
  assert.equal(prCreateGuard(event("vibe/example"), home)?.decision, "deny", "the owning vibe head remains gated");
  assert.equal(prCreateGuard({ ...event("fix/ordinary"), tool_input: {
    command: "gh pr create --head fix/ordinary --body-file body.md; gh pr create --head vibe/example --body-file body.md",
  } }, home)?.decision, "deny", "one unsafe Vibe head refuses the whole multi-PR Bash event");
  execFileSync("git", ["-C", worktree, "worktree", "add", "-q", unrelatedWorktree, "fix/unrelated"]);
  const unrelatedGitDir = execFileSync("git", ["-C", unrelatedWorktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(unrelatedGitDir, "vibe-session.json"), "{invalid");
  assert.equal(prCreateGuard(event("fix/ordinary"), home), null,
    "a corrupt marker on a different worktree does not decide the selected ordinary head");
  execFileSync("git", ["-C", worktree, "worktree", "add", "-q", otherWorktree, "fix/ordinary"]);
  const otherGitDir = execFileSync("git", ["-C", otherWorktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(otherGitDir, "vibe-session.json"), JSON.stringify({ branch: "fix/ordinary" }));
  assert.equal(prCreateGuard(event("fix/ordinary"), home)?.decision, "deny", "a recorded session on the selected head stays gated even without a vibe/ prefix");
  writeFileSync(path.join(otherGitDir, "vibe-session.json"), JSON.stringify({ branch: "vibe/previous" }));
  assert.equal(prCreateGuard(event("fix/ordinary"), home), null,
    "a stale session marker for a different branch does not own this non-vibe head");
  writeFileSync(path.join(otherGitDir, "vibe-session.json"), "{invalid");
  assert.equal(prCreateGuard(event("fix/ordinary"), home)?.decision, "deny",
    "a corrupt marker on the selected head does not prove it is unrelated to Vibe");
  execFileSync("git", ["init", "-q", "-b", "fix/ordinary", ordinaryRepo]);
  writeFileSync(path.join(ordinaryRepo, "file.txt"), "base\n");
  execFileSync("git", ["-C", ordinaryRepo, "add", "."]);
  execFileSync("git", ["-C", ordinaryRepo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  execFileSync("git", ["-C", ordinaryRepo, "branch", "vibe/new"]);
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create --head vibe/new --body-file body.md" } }, home)?.decision,
    "deny", "an explicit session-less vibe head is gated without a conversation marker");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create -H=vibe/new -F=body.md" } }, home)?.decision,
    "deny", "an equals-attached Vibe head cannot bypass an unscoped guard");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr new -H=vibe/new -F=body.md" } }, home)?.decision,
    "deny", "the new alias cannot bypass an unscoped Vibe head");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create -Hvibe/new -Fbody.md" } }, home)?.decision,
    "deny", "a directly attached Vibe head cannot bypass an unscoped guard");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "GH_REPO=owner/other-repo gh pr create --head vibe/new" } }, home)?.decision,
    "deny", "a Vibe-named head remains scoped when repository proof is uncertain");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create --head owner:vibe/new" } }, home)?.decision,
    "deny", "a remote Vibe-named head remains scoped even without a local branch");
  execFileSync("git", ["-C", ordinaryRepo, "branch", "fix/claimed"]);
  execFileSync("git", ["-C", ordinaryRepo, "branch", "fix/unrelated"]);
  execFileSync("git", ["-C", ordinaryRepo, "branch", "fix/corrupt"]);
  execFileSync("git", ["-C", ordinaryRepo, "worktree", "add", "-q", ordinaryOtherWorktree, "fix/unrelated"]);
  const ordinaryOtherGitDir = execFileSync("git", ["-C", ordinaryOtherWorktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(ordinaryOtherGitDir, "vibe-session.json"), JSON.stringify({ branch: "fix/claimed" }));
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create --head fix/claimed --body-file body.md" } }, home)?.decision,
    "deny", "a session record claiming an un-checked-out head is uncertain even without conversation scope");
  execFileSync("git", ["-C", ordinaryOtherWorktree, "checkout", "-q", "fix/corrupt"]);
  writeFileSync(path.join(ordinaryOtherGitDir, "vibe-session.json"), "{invalid");
  assert.equal(prCreateGuard({ cwd: ordinaryRepo, tool_input: { command: "gh pr create --head fix/corrupt --body-file body.md" } }, home)?.decision,
    "deny", "a corrupt selected-head marker is uncertain even without conversation scope");
});
