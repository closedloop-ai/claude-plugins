// ISS-13532 T-1.1: replay the current Vibe gates on one exact symphony-alpha PR head.
// Usage: node tools/vibe-bench/fixtures/iss-13532-replay.mjs <checkout> <main-sha> <9366|9448>

import { execFileSync } from "node:child_process";
import { runDiffRules } from "../../../plugins/vibe/skills/handoff/scripts/diff-rules.mjs";
import { prBodyClaimProblems } from "../../../plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs";
import { pullRequestFacts } from "../../../plugins/vibe/skills/handoff/scripts/pr-facts.mjs";

const [worktree, base, number] = process.argv.slice(2);
const heads = { 9366: "05217c7b746001107dd6b66cfcd6bf0407c2f23c", 9448: "d3f0fd6a57897088d3e8f2c88bbd077d123dff41" };
if (!worktree || !/^[a-f0-9]{40}$/.test(base ?? "") || !heads[number]) {
  throw new Error("Usage: iss-13532-replay.mjs <checkout> <main-sha> <9366|9448>");
}
const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
if (head !== heads[number]) throw new Error(`PR ${number} checkout is at ${head}, expected ${heads[number]}`);
if (git("cat-file", "-t", base) !== "commit") throw new Error("the named main commit is unavailable");
const all = git("diff", "--name-only", base).split("\n").filter(Boolean);
const scope = all.filter((file) => /creation-owner-field|artifact-creation-dialog\.tsx$|documents-create-action\.tsx$|issue-creation-fields\.tsx$|add-artifact-dialog\.tsx$|issue-detail-design-preview\.tsx$|artifact-canvas-toolbar\.tsx$|issue-editor\.tsx$|use-documents\.ts$|use-artifact-activity-feed\.ts$|document-detail-header\.tsx$|breadcrumb-model\.ts$/.test(file));
const body = execFileSync("gh", ["pr", "view", number, "--repo", "closedloop-ai/symphony-alpha", "--json", "body", "--jq", ".body"], { encoding: "utf8" });
const diff = runDiffRules({ worktree, base, changeLog: "/dev/null", exclude: new Set(all.filter((file) => !scope.includes(file))) });
const facts = pullRequestFacts({ worktree, base, include: new Set(scope), prs: [], ownBranch: "", body, commit: head, template: "" });
const runs = { testRuns: [
  { lane: "web-e2e", command: "pnpm test:e2e", status: "not-run" },
  { lane: "desktop-e2e", command: "pnpm --dir apps/desktop test:e2e", status: "not-run" },
] };
const result = {
  pr: Number(number), head, symphonyMain: base, scope,
  diffRules: { ok: diff.ok, blocking: diff.blocking.map(({ rule, file, line }) => ({ rule, file, line })), requiredTests: diff.requiredTests.map((entry) => entry.path) },
  pullRequestFacts: { prBodyProblems: facts.prBodyProblems, requiredLanes: facts.requiredLanes },
  notRunBodyClaims: prBodyClaimProblems(body, runs),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
