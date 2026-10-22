import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evidenceProblems, pullRequestFacts, requiredLanes, selectionProblems, STACKED_BASE_STATEMENT, templateHeadingProblems } from "./pr-facts.mjs";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const ROUTE = "apps/api/app/links/route.ts";
const TEST = "packages/api/src/links.test.ts";
const BASE = {
  [ROUTE]: "export async function POST() {\n  return Response.json({ ok: true });\n}\n",
  "packages/api/src/types/links.ts": "export type LinkKind = \"a\";\nexport const LINK_LIMIT = 10;\n",
  [TEST]: "it(\"limits\", () => {\n  expect(limit()).toBe(10);\n  expect(kind()).toBe(\"a\");\n});\n",
  "packages/api/src/old.test.ts": "it(\"old\", () => { expect(1).toBe(1); });\n",
  "packages/api/src/service.ts": "export function run() {}\n",
  "packages/api/src/helper.ts": "export const helper = 1;\n",
};
const PRS = [
  { number: 8900, title: "shares", headRefName: "b", files: [ROUTE] },
  { number: 8938, title: "imports", headRefName: "c", files: ["packages/api/src/helper.ts"] },
  { number: 8999, title: "unrelated", headRefName: "d", files: ["x.ts"] },
];
const COMPLETE_BODY = [
  `Overlaps #8900 and #8938. New 409 at ${ROUTE}:2.`,
  `Flipped ${TEST}:2, removed ${TEST}:2, deleted packages/api/src/old.test.ts.`,
  "Changed LinkKind, removed LINK_LIMIT.",
  "Say why POST vs DELETE in the PR. POST carries the edge.",
].join("\n");

const SOURCES = [ROUTE, "packages/api/src/types/links.ts", "packages/api/src/service.ts"];
const SELECTED = {
  testSelection: SOURCES.flatMap((file) => [{ file, selector: "code_tests_for", tests: [TEST] }, { file, selector: "e2e-reference", tests: [] }]),
  testRuns: [{ path: TEST, status: "passed", commit: "a".repeat(40), command: "vitest run" }],
};

function session(t) {
  const fixture = makeHome("pr-facts-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: BASE });
  const created = runNode(SESSIONS, ["new", "--repo", checkout, "--slug", "links", "--summary", "links", "--mode", "seeded",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], fixture.home);
  assert.equal(created.status, 0, created.stderr);
  const wt = created.json.session.worktree;
  const write = (file, content) => writeFileSync(path.join(wt, file), content);
  write(ROUTE, "export async function POST() {\n  return Response.json({ error: \"managed\" }, { status: 409 });\n}\n");
  write("packages/api/src/types/links.ts", "export type LinkKind = \"a\" | \"b\";\n");
  write(TEST, "it(\"limits\", () => {\n  expect(limit()).toBe(20);\n});\n");
  write("packages/api/src/service.ts", "import { helper } from \"./helper\";\nexport function run() { return helper; }\n");
  unlinkSync(path.join(wt, "packages/api/src/old.test.ts"));
  const file = (name, content) => {
    const target = path.join(fixture.root, name);
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
    return target;
  };
  return { ...fixture, wt, file, base: git(wt, ["merge-base", "HEAD", "origin/main"], fixture.home) };
}

function facts({ wt, base }, extra = {}) {
  const include = new Set([ROUTE, "packages/api/src/types/links.ts", TEST, "packages/api/src/service.ts", "packages/api/src/old.test.ts"]);
  return pullRequestFacts({ worktree: wt, base, include, prs: PRS, ownBranch: "vibe/links", ticketText: "Say why POST vs DELETE in the PR.", ...extra });
}

test("facts name overlap by shared and imported file, assertion and export changes, refusals and asks", (t) => {
  const result = facts(session(t));
  assert.equal(result.serverOnly, true);
  assert.deepEqual(result.overlap.map((pr) => [pr.number, pr.sharedFiles, pr.importedFiles]), [
    [8900, [ROUTE], []], [8938, [], ["packages/api/src/helper.ts"]],
  ]);
  assert.deepEqual(result.assertionChanges.map((change) => [change.kind, change.path, change.line]), [
    ["flipped", TEST, 2], ["removed", TEST, 2], ["deleted-test-file", "packages/api/src/old.test.ts", undefined],
  ]);
  assert.deepEqual(result.contractChanges.map((change) => [change.kind, change.name]), [["changed", "LinkKind"], ["removed", "LINK_LIMIT"]]);
  assert.deepEqual(result.refusals, [{ path: ROUTE, line: 2, status: 409 }]);
  assert.deepEqual(result.asks, ["Say why POST vs DELETE in the PR."]);
});

test("the body gate refuses missing facts, uncited lines and a stacked base without its statement", (t) => {
  const s = session(t);
  assert.deepEqual(facts(s, { body: COMPLETE_BODY }).prBodyProblems, []);
  const empty = facts(s, { body: "Summary only." }).prBodyProblems.join("\n");
  for (const missing of ["#8900", "#8938", `${TEST}:2`, "old.test.ts", "LinkKind", "LINK_LIMIT", "409", "POST vs DELETE"]) {
    assert.ok(empty.includes(missing), missing);
  }
  assert.match(facts(s, { body: `${COMPLETE_BODY}\nSee ${ROUTE}:1.` }).prBodyProblems.join(), /route.ts:1 is not a changed line/);
  assert.match(facts(s, { body: COMPLETE_BODY, prBase: "vibe/dependency" }).prBodyProblems.join(), /add verbatim/);
  assert.deepEqual(facts(s, { body: `${COMPLETE_BODY}\n${STACKED_BASE_STATEMENT}`, prBase: "vibe/dependency" }).prBodyProblems, []);
  assert.match(facts(s, { body: COMPLETE_BODY, prs: null }).prBodyProblems.join(), /could not be read/);
  const local = facts(s, { body: `${COMPLETE_BODY}\n![after](/Users/x/file.png)\nLog in ~/foo\nPlan: .closedloop-ai/vibe-plans/r1.md` }).prBodyProblems;
  assert.deepEqual(local.map((problem) => problem.replace(/:.*/, "")), ["body line 5", "body line 6", "body line 7"]);
  assert.ok(local.every((problem) => !problem.includes("/Users/x") && !problem.includes("~/foo")), "never echoes the path");
});

test("evidence: lanes follow the diff, and unfinished, missing or stale runs block", () => {
  const changed = ["packages/app/list.tsx", "packages/app/list.stories.tsx"];
  assert.deepEqual(requiredLanes([ROUTE]), []);
  assert.deepEqual(["e2e/a.spec.ts", "e2e-web-smoke/b.spec.ts", "apps/desktop/test/e2e/c.spec.ts"].map((file) => requiredLanes([file])), [["e2e"], ["e2e"], ["e2e"]]);
  assert.deepEqual(requiredLanes(changed, ["card select"]), ["web-host", "desktop-host", "webkit-iphone", "chromium-pixel", "storybook-plays"]);
  const commit = "a".repeat(40);
  const runs = requiredLanes(changed, ["card select"]).map((lane) => ({ lane, status: "passed", command: "run", commit, outcome: "selected",
    ...(lane === "storybook-plays" ? { playVerdicts: [{ storyId: "cards--select", verdict: "PASS" }] } : {}) }));
  const file = { touchFlows: ["card select"], runs };
  assert.deepEqual(evidenceProblems(file, changed, commit), []);
  assert.match(evidenceProblems({ ...file, runs: runs.map((run, i) => (i === 2 ? { ...run, status: "running" } : run)) }, changed, commit).join(), /webkit-iphone: running/);
  assert.match(evidenceProblems({ ...file, runs: runs.slice(1) }, changed, commit).join(), /web-host: no run recorded/);
  assert.match(evidenceProblems(file, changed, "b".repeat(40)).join(), /not the published commit/);
  assert.match(evidenceProblems({ runs }, changed, commit).join(), /touchFlows/);
  const unjudged = runs.map((run) => (run.lane === "storybook-plays" ? { ...run, playVerdicts: undefined } : run));
  assert.match(evidenceProblems({ ...file, runs: unjudged }, changed, commit).join(), /storybook-plays: no playVerdicts/);
});

test("the inventory reports the facts and gates only the pull-request phase", (t) => {
  const s = session(t);
  const prs = s.file("prs.json", PRS);
  const ticket = s.file("ticket.md", "Say why POST vs DELETE in the PR.\n");
  const handoff = runNode(INVENTORY, ["--worktree", s.wt, "--phase", "handoff", "--ticket", ticket], s.home);
  assert.equal(handoff.json.serverOnly, true);
  assert.equal(handoff.json.overlap, null);
  assert.equal("prBody" in handoff.json.blocking, false);
  const run = (body) => runNode(INVENTORY, ["--worktree", s.wt, "--phase", "pull-request", "--ticket", ticket, "--prs-json", prs,
    "--body", s.file("body.md", body), "--runs", s.file("runs.json", { touchFlows: [], touchFlowsReason: "server only", runs: [], ...SELECTED }),
    "--commit", "a".repeat(40)], s.home);
  const failing = run("Summary only.");
  assert.equal(failing.status, 1);
  assert.equal(failing.json.blocking.prBody, false);
  const passing = run(COMPLETE_BODY);
  assert.equal(passing.json.blocking.prBody, true, JSON.stringify(passing.json.prBodyProblems));
  assert.equal(passing.json.blocking.prEvidence, true);
  assert.match(runNode(INVENTORY, ["--worktree", s.wt, "--phase", "handoff", "--body", ticket], s.home).json.error, /--phase pull-request/);
});

test("a body that drops a heading of the repo's pull request template is refused (#8960, #8967)", (t) => {
  const template = "## Summary\n\n## Breaking changes\n\n## Test plan\n";
  assert.deepEqual(templateHeadingProblems("## Summary\nx\n## Breaking changes\nNone\n## Test plan\nran it\n", template), []);
  assert.deepEqual(templateHeadingProblems("## Summary\nx\n## Breaking changes\nNone\nTest plan: ran it\n", template), ["template heading \"## Test plan\" is missing"]);
  assert.deepEqual(templateHeadingProblems("anything", ""), []);
  const s = session(t);
  assert.match(facts(s, { body: COMPLETE_BODY, template }).prBodyProblems.join(), /template heading "## Summary" is missing/);
});

test("test selection covers the whole branch diff, and every selected, required or edited test passed on the commit (#8963)", (t) => {
  const s = session(t);
  const commit = "a".repeat(40);
  const gate = (runs, requiredTests = []) => facts(s, { runs: { touchFlows: [], touchFlowsReason: "server only", runs: [], ...runs }, commit, requiredTests }).prEvidenceProblems;
  assert.deepEqual(gate(SELECTED), []);
  const empty = gate({});
  for (const file of SOURCES) {
    assert.ok(empty.some((problem) => problem.startsWith(`${file}: no import selection`)), file);
    assert.ok(empty.some((problem) => problem.startsWith(`${file}: no e2e by-reference selection`)), file);
  }
  assert.ok(empty.some((problem) => problem.startsWith(`${TEST}: selected but no passing run`)), "an edited spec is always selected");
  const unindexed = SELECTED.testSelection.map((entry) => (entry.file === "packages/api/src/service.ts" && entry.selector === "code_tests_for" ? { ...entry, tests: null } : entry));
  assert.match(gate({ ...SELECTED, testSelection: unindexed }).join(), /service\.ts: no import selection/);
  assert.deepEqual(gate({ ...SELECTED, testSelection: [...unindexed, { file: "packages/api/src/service.ts", selector: "related", tests: [] }] }), []);
  const emptyGraph = SELECTED.testSelection.map((entry) => (entry.selector === "code_tests_for" && entry.file === ROUTE ? { ...entry, tests: [] } : entry));
  assert.match(gate({ ...SELECTED, testSelection: emptyGraph }).join(), /route\.ts: no import selection/);
  assert.match(gate(SELECTED, [{ path: "e2e/links.spec.ts", reason: "names the endpoint" }]).join(), /e2e\/links\.spec\.ts: selected but no passing run/);
  assert.match(gate({ ...SELECTED, testRuns: [{ ...SELECTED.testRuns[0], commit: "b".repeat(40) }] }).join(), /links\.test\.ts: selected but no passing run/);
  assert.match(gate({ ...SELECTED, testRuns: [{ ...SELECTED.testRuns[0], status: "skipped" }] }).join(), /links\.test\.ts: selected but no passing run/);
  assert.match(selectionProblems({ testSelection: [{ file: ROUTE, selector: "guess", tests: [] }] }, [], [], commit).join(), /selector "guess"/);
});

test("a required test with flag states needs a passing run with the flag on and with it off", () => {
  const commit = "c".repeat(40);
  const required = [{ path: "apps/a/sessions.test.tsx", reason: "shared", flagStates: ["on", "off"] }];
  const run = (flag) => ({ path: "apps/a/sessions.test.tsx", status: "passed", commit, ...(flag ? { flag } : {}) });
  const problems = (testRuns) => selectionProblems({ testSelection: [], testRuns }, [], required, commit);
  assert.deepEqual(problems([run("on")]), [`apps/a/sessions.test.tsx: no passing run with the flag off on ${commit} (testRuns entry with flag: "off")`]);
  assert.equal(problems([run()]).length, 2, "a run that names no flag state counts for neither");
  assert.deepEqual(problems([run("on"), run("off")]), []);
});
