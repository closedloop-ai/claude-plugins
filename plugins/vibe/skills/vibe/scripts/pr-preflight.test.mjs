import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { claimedCheckProblems, claimProblems, E2eKind, e2eClaimProblems, followUpTicketProblems, testedCommitProblems, titleProblems, workspacePackages } from "./pr-preflight.mjs";
import { visualBaselineLedgerProblems } from "../../handoff/scripts/visual-baseline-ledger.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { bindProviderInProcess } from "./test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pr-preflight.mjs");

test("a title over 72 characters with the ' (#n)' suffix fails, as the metadata gate does (#9188 at 73)", () => {
  const title = (length) => `ISS-12901: ${"x".repeat(length - 11)}`;
  assert.match(titleProblems(title(65), { pr: 9188 }).join(), /title is 73 characters/);
  assert.deepEqual(titleProblems(title(64), { pr: 9188 }), []);
  assert.match(titleProblems(title(64)).join(), /title is 73 characters/, "before the PR exists the suffix counts five digits");
});

test("an identical or matching claim needs its measured count (#9186 was about 3,900 pixels off)", () => {
  assert.equal(claimProblems("Regenerated baseline is pixel-identical to CI.").length, 1);
  assert.equal(claimProblems("Snapshot matches the Linux render.").length, 1);
  assert.equal(claimProblems("No visual diff against main.").length, 1);
  assert.deepEqual(claimProblems("Regenerated baseline is pixel-identical to CI: 0 of 1,048,576 pixels differ."), []);
  assert.deepEqual(claimProblems("Matches CI within 0.02% (210 pixels differ, threshold 0.1%)."), []);
  assert.deepEqual(claimProblems("Fixes the star column header."), []);
  assert.deepEqual(claimProblems("The empty state matches the design and the ticket's wording."), [], "only result comparisons need a count");
});

test("the command fails a 73-character title and passes a fitting one", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, "body.md");
  writeFileSync(body, "## Summary\n- Fix the reds.\n");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const long = run("--title", "x".repeat(65), "--pr", "9188", "--body-file", body);
  assert.equal(long.status, 1);
  assert.equal(JSON.parse(long.stdout).ok, false);
  assert.equal(run("--title", "x".repeat(64), "--pr", "9188", "--body-file", body).status, 0);
});

test("a changed visual baseline needs a counted, sourced element ledger (#9188)", (t) => {
  const file = "e2e/__screenshots__/visual-regression.spec.ts/branches-desktop.png";
  assert.match(visualBaselineLedgerProblems("The checkbox is plausibly intended.\n", [file]).join(), /needs exactly one/);
  const incomplete = [
    `Baseline inventory: ${file}: Branches: 3 new elements`,
    `Baseline element: ${file}: Branches: star column: ISS-12918 AC-2`,
    `Baseline element: ${file}: Branches: header select-all checkbox: plausibly intended`,
  ].join("\n");
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /declares 3 new elements but lists 2/);
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /plausibly intended/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-baseline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), "old");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "base"]);
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(dir, file), "new");
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-am", "baseline"]);
  const body = path.join(dir, "body.md");
  writeFileSync(body, incomplete);
  const failed = spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  writeFileSync(body, `${incomplete}\nBaseline element: ${file}: Branches: avatar style: ISS-12576 ruling\n`.replace("header select-all checkbox: plausibly intended", "header select-all checkbox: ISS-100 AC-3"));
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" }).status, 0);
});

function repoWithOrigin(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-preflight-commits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const commit = (file, text, message) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
    git("add", "--", file);
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const base = commit("story.tsx", "base\n", "base");
  git("update-ref", "refs/remotes/origin/main", base);
  git("switch", "--quiet", "-c", "feature");
  return { dir, git, commit, base };
}

test("a named tested commit must be the head or an ancestor equal to it on changed paths (PR #9732 cited e8696cbc10)", (t) => {
  const { dir, git, commit, base } = repoWithOrigin(t);
  const tested = commit("story.tsx", "tested\n", "feature");
  assert.deepEqual(testedCommitProblems(`Checks at head ${tested.slice(0, 10)} pass. Main is ${base.slice(0, 10)}.`, dir), [], "the head itself and a main citation pass");
  commit("notes.md", "unrelated\n", "notes");
  assert.deepEqual(testedCommitProblems(`Checks at ${tested.slice(0, 10)} pass.`, dir).length, 1, "notes.md is a changed path the tested commit lacks");

  // A main merge that changes a file the pull request also changes, after the tested commit, invalidates it.
  const fresh = repoWithOrigin(t);
  const ran = fresh.commit("story.tsx", "tested\n", "feature");
  fresh.git("switch", "--quiet", "main");
  const mainOnly = fresh.commit("version.json", "12.2.1\n", "main release");
  fresh.git("update-ref", "refs/remotes/origin/main", mainOnly);
  fresh.git("switch", "--quiet", "feature");
  fresh.git("merge", "--quiet", "--no-ff", "-m", "Merge main", "main");
  assert.deepEqual(testedCommitProblems(`Lanes ran at ${ran.slice(0, 10)}.`, fresh.dir), [], "a merge that only brings main's files keeps the PR's paths equal");
  writeFileSync(path.join(fresh.dir, "story.tsx"), "resolved in a merge\n");
  fresh.git("commit", "--quiet", "-am", "Merge main");
  assert.match(testedCommitProblems(`Lanes ran at ${ran.slice(0, 10)}.`, fresh.dir).join(), /1 changed path differs .*story\.tsx/);

  // A rewritten commit that is not on HEAD's history, and one that never existed here.
  git("reset", "--quiet", "--hard", base);
  commit("story.tsx", "rewritten\n", "rewritten");
  assert.match(testedCommitProblems(`Checks at head ${tested.slice(0, 10)}.`, dir).join(), /not the pushed head .* or one of its ancestors/);
  assert.match(testedCommitProblems("Checks at head e8696cbc10 pass.", dir).join(), /cannot resolve/);
  assert.deepEqual(testedCommitProblems("Story id live-issues-v-2, 1879 stories, ISS-13897 and https://x.test/deadbeef1 are not commits.", dir), []);
});

test("a check claimed for a workspace package needs that package's script (PR #9732 claimed storybook typecheck)", (t) => {
  const { dir, git } = repoWithOrigin(t);
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "scripts"\n\nsupportedArchitectures:\n  os:\n    - linux\n');
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "root", scripts: { lint: "biome" } }));
  for (const [dirName, scripts] of [["apps/app", { typecheck: "tsc", test: "vitest" }], ["apps/storybook", { test: "vitest", build: "storybook build" }], ["scripts", { test: "vitest" }]]) {
    mkdirSync(path.join(dir, dirName), { recursive: true });
    writeFileSync(path.join(dir, dirName, "package.json"), JSON.stringify({ name: path.basename(dirName) === "app" ? "@repo/app" : path.basename(dirName), scripts }));
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "workspace");
  assert.deepEqual([...workspacePackages(dir).keys()].sort(), ["@repo/app", "root", "scripts", "storybook"]);
  assert.match(claimedCheckProblems("- Checks: Biome, source gates and typecheck (`@repo/app`, `storybook`) pass.", dir).join(), /typecheck for `storybook`, which has no "typecheck" script/);
  assert.equal(claimedCheckProblems("- Checks: Biome, source gates and typecheck (`@repo/app`, `storybook`) pass.", dir).length, 1);
  assert.deepEqual(claimedCheckProblems("- Typecheck covers `@repo/app`, and the `storybook` and `scripts` test lanes pass.", dir), []);
  assert.deepEqual(claimedCheckProblems("- Lanes from `pnpm test:lanes` passed: `storybook`, `test:lint`.", dir), [], "a check word inside backticks claims nothing");
  assert.deepEqual(claimedCheckProblems("- Typecheck for `storybook` is not wired; it has no script.", dir), [], "a line with no pass claim is not checked");
  assert.deepEqual(claimedCheckProblems("```\ntypecheck `storybook` passed\n```", dir), []);
});

test("a promised follow-up ticket needs its slug (PR #9732: 'A ticket for the shared style follows')", () => {
  assert.equal(followUpTicketProblems("Not fixed here. A ticket for the shared style follows.").length, 1);
  assert.equal(followUpTicketProblems("- A follow-up ticket tracks the split.").length, 1);
  assert.equal(followUpTicketProblems("We will file a separate cleanup ticket.").length, 1);
  assert.equal(followUpTicketProblems("An issue will be filed for the CSS.").length, 1);
  assert.deepEqual(followUpTicketProblems("A ticket for the shared style follows: ISS-13948."), []);
  assert.deepEqual(followUpTicketProblems("Follow-ups (advisory, not changed here):\n- The header comment is a design follow-up."), []);
});

test("E2E statements in the body must match the lane receipts at the source (ISS-13947 class 5)", () => {
  const none = { passed: new Set(), notRun: new Set() };
  const desktopNotRun = { passed: new Set([E2eKind.Web]), notRun: new Set([E2eKind.Desktop]) };
  assert.match(e2eClaimProblems("- Web E2E passed locally.", none).join(), /web E2E as passed with no passing lane receipt/);
  assert.match(e2eClaimProblems("- E2E passed.", none).join(), /E2E as passed with no passing lane receipt/);
  assert.match(e2eClaimProblems("- Web and Desktop E2E passed. Nothing else to say.", desktopNotRun).join(), /Desktop E2E as passed, but its lane is recorded not run/);
  assert.match(e2eClaimProblems("- Web E2E passed.", desktopNotRun).join(), /Desktop E2E is recorded not run at this source; say plainly/);
  assert.deepEqual(e2eClaimProblems("- Web E2E passed.\n- Desktop E2E has not run: this Mac has no displayless Electron harness.", desktopNotRun), []);
  assert.deepEqual(e2eClaimProblems("- Desktop E2E has not run. No CI runs it before merge.", { passed: new Set(), notRun: new Set([E2eKind.Desktop]) }), []);
  assert.deepEqual(e2eClaimProblems("- E2E has not run, and no green run exists.", { passed: new Set(), notRun: new Set([E2eKind.Web]) }), [], "a negated clause is a not-run statement, not a pass claim");
  assert.deepEqual(e2eClaimProblems("- Unit tests passed.", none), []);
});

test("the command reads the session's lane receipts at the current source", (t) => {
  const { dir, git } = repoWithOrigin(t);
  const head = git("rev-parse", "HEAD");
  const body = path.join(dir, ".git", "body.md");
  const run = () => spawnSync(process.execPath, [SCRIPT, "--title", "ISS-1: Fix it", "--body-file", body, "--worktree", dir], { encoding: "utf8" });
  writeFileSync(body, "## Test plan\n- Desktop E2E passed.\n");
  assert.equal(run().status, 1, "no receipt backs the pass claim");
  const source = sourceIdentity(dir, head);
  const lane = "pnpm --filter desktop test:e2e";
  writeFileSync(path.join(dir, ".git", "vibe-lane-results.json"), JSON.stringify([{ command: lane, head, source, result: "pass" }]));
  assert.equal(run().status, 0, JSON.stringify(run().stdout));
  writeFileSync(path.join(dir, ".git", "vibe-lane-results.json"), JSON.stringify([{ command: lane, head, source, result: "not-run", reason: "no harness" }]));
  assert.match(JSON.parse(run().stdout).problems.join(), /recorded not run/);
  writeFileSync(body, "## Test plan\n- Desktop E2E has not run: no displayless harness here.\n");
  assert.equal(run().status, 0, "a not-run lane named as not run still opens a ready PR (ISS-13321)");
  writeFileSync(body, "## Test plan\n- Checks at head e8696cbc10 pass.\n- Desktop E2E has not run.\n");
  assert.match(JSON.parse(run().stdout).problems.join(), /e8696cbc10, which this checkout cannot resolve/);
});
