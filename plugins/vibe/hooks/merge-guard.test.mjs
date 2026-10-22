import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mergeCalls, mergeProblem } from "./merge-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "merge-guard.mjs");

/** A gh stand-in: the signed-in login, and each PR number's author and branch. */
const fakeGh = (me, prs) => (args) => {
  if (args[0] === "api") return `${me}\n`;
  const pr = prs[args[2]?.startsWith("-") ? "current" : args[2]];
  return JSON.stringify({ author: { login: pr.author }, headRefName: pr.branch });
};

test("merging, enqueueing or arming auto-merge on another author's pull request is refused (#9169 was enqueued for its author)", () => {
  const gh = fakeGh("operator", { 9169: { author: "teammate", branch: "fix/their-work" }, 9160: { author: "operator", branch: "vibe/bulk" }, current: { author: "operator", branch: "vibe/x" } });
  assert.match(mergeProblem("gh pr merge 9169 --squash --auto -R acme/app", gh), /^pull request 9169 is teammate's \(branch fix\/their-work\), not operator's/);
  assert.match(mergeProblem("cd wt && gh pr merge --auto 9169", gh), /teammate's/);
  assert.equal(mergeProblem("gh pr merge 9160 --squash --auto", gh), null, "our own pull request");
  assert.equal(mergeProblem("gh pr merge --squash --auto", gh), null, "the current branch's own pull request");
  assert.equal(mergeProblem("MERGE_AUTHOR_OK=teammate gh pr merge 9169 --squash --auto", gh), null, "the operator approved it");
  assert.match(mergeProblem("MERGE_AUTHOR_OK=someone-else gh pr merge 9169 --auto", gh), /teammate's/);
  assert.equal(mergeProblem("gh pr view 9169 && git merge main", gh), null);
});

test("the repo and the target are read past value flags", () => {
  assert.deepEqual(mergeCalls("gh pr merge -t 'title' --repo=acme/app 12 --auto"), [{ target: "12", repo: "acme/app", allowed: null }]);
  assert.deepEqual(mergeCalls("gh pr merge --body-file b.md -R acme/app https://github.com/acme/app/pull/12"), [{ target: "https://github.com/acme/app/pull/12", repo: "acme/app", allowed: null }]);
});

test("the hook denies through the PreToolUse contract and stays silent when gh cannot answer", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = path.join(dir, "gh");
  writeFileSync(gh, '#!/usr/bin/env bash\nif [ "$1" = api ]; then echo operator; else echo \'{"author":{"login":"teammate"},"headRefName":"fix/x"}\'; fi\n', { mode: 0o755 });
  const run = (command, bin = gh) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", cwd: dir, tool_input: { command } }), encoding: "utf8", env: { ...process.env, MERGE_GUARD_GH: bin } });
  assert.equal(JSON.parse(run("gh pr merge 9169 --auto").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("git status").stdout, "");
  const broken = run("gh pr merge 9169 --auto", path.join(dir, "missing-gh"));
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, /^merge-guard: /);
  assert.ok(readFileSync(path.join(HERE, "hooks.json"), "utf8").includes("hooks/merge-guard.mjs"), "the hook is registered");
});
