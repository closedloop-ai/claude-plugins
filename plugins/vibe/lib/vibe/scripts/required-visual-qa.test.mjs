import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { changedPaths, dispositionProblems, visualQaFindingsProblems, visualQaRequired } from "./required-visual-qa.mjs";
import { sessionBinding } from "./provider.mjs";
import { bindProviderInProcess } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

// The bound provider declares the repository's UI paths (recipes.areas.ui); with no binding none are declared.
bindProviderInProcess(after);

function repo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-visual-qa-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
    git("add", ".");
    git("commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  return { git, commit };
}

function findingsFile(t, value) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-visual-qa-findings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "findings.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("a changed file under the repository's UI paths, a story included, needs visual QA; other paths do not", () => {
  const binding = sessionBinding(null);
  const ui = visualQaRequired(binding, ["apps/app/components/header.tsx", "README.md", "apps/storybook/stories/header.stories.tsx"]);
  assert.equal(ui.required, true);
  assert.deepEqual(ui.paths, ["apps/app/components/header.tsx", "apps/storybook/stories/header.stories.tsx"]);
  const server = visualQaRequired(binding, ["apps/api/routes/list.ts"]);
  assert.equal(server.required, false);
  assert.match(server.reason, /no changed file/);
});

test("a repository that declares no UI paths needs no visual QA, and says why", () => {
  const verdict = visualQaRequired(null, ["apps/app/components/header.tsx", "src/App.tsx"]);
  assert.equal(verdict.required, false);
  assert.match(verdict.reason, /declares no UI paths/);
});

test("findings cover a head when their head has its tree and every touched finding has a disposition", (t) => {
  const { git, commit } = repo(t);
  const qa = commit("apps/app/page.tsx", "one\n");
  const runner = (...args) => git(...args);
  assert.deepEqual(visualQaFindingsProblems(findingsFile(t, { head: qa, findings: [] }), qa, runner), []);
  git("commit", "-q", "--allow-empty", "-m", "same tree");
  assert.deepEqual(visualQaFindingsProblems(findingsFile(t, { head: qa, findings: [] }), git("rev-parse", "HEAD"), runner), [],
    "a commit with the same tree is the same source");
  const later = commit("apps/app/page.tsx", "two\n");
  assert.match(visualQaFindingsProblems(findingsFile(t, { head: qa, findings: [] }), later, runner)[0], /ran on .*not the current source/,
    "findings for an older tree are stale");
  assert.match(visualQaFindingsProblems(findingsFile(t, { head: qa.slice(0, 12), findings: [] }), qa, runner)[0], /full head/);
  assert.match(visualQaFindingsProblems(null, later, runner)[0], /no visual QA findings file \(pass --visual-qa <findings\.json>\)/);
  const open = findingsFile(t, { head: later, findings: [{ id: "F1", summary: "clipped", route: "/x", viewport: "1280", selector: "h1", touchedSurface: true }] });
  assert.match(visualQaFindingsProblems(open, later, runner)[0], /F1: a finding on a touched surface needs disposition/);
  const fixed = findingsFile(t, { head: later, findings: [{ id: "F1", touchedSurface: true, disposition: `fixed: ${qa}` }] });
  assert.deepEqual(visualQaFindingsProblems(fixed, later, runner), []);
});

test("without a repository the findings head must be the declared head", (t) => {
  const head = "a".repeat(40);
  assert.deepEqual(visualQaFindingsProblems(findingsFile(t, { head, findings: [] }), head.slice(0, 12)), []);
  assert.match(visualQaFindingsProblems(findingsFile(t, { head: "b".repeat(40), findings: [] }), head)[0], /not the current source/);
  assert.match(visualQaFindingsProblems(findingsFile(t, { head, findings: [] }), "aaa")[0], /not the current source/, "a short prefix proves nothing");
});

test("a ticket disposition must be a work item of the bound tracker, or a GitHub issue without one", () => {
  const finding = { id: "F1", touchedSurface: true };
  assert.deepEqual(dispositionProblems([{ ...finding, disposition: "ticket: ISS-12" }]), []);
  assert.equal(dispositionProblems([{ ...finding, disposition: "ticket: #12" }]).length, 1);
  assert.deepEqual(dispositionProblems([{ ...finding, disposition: "ticket: #12" }], null), []);
});

test("changed paths are the merge-base diff", (t) => {
  const { git, commit } = repo(t);
  const base = commit("README.md", "base\n");
  commit("apps/app/page.tsx", "ui\n");
  assert.deepEqual(changedPaths((...args) => git(...args), base, "HEAD"), ["apps/app/page.tsx"]);
});
