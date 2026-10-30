import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityProbeProblems, ciCheckProblems, evidenceProblems, knownMainFailureProblems, pullRequestFacts, requiredLanes, selectionProblems, STACKED_BASE_STATEMENT, targetedEvidenceProblems, templateHeadingProblems } from "./pr-facts.mjs";
import { NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";
import { qaImpactRequest } from "./qa-impact.mjs";
import { sourceIdentity } from '../../vibe/scripts/tested-head.mjs';

test('precommit evidence binds to identical published content without rewriting tested HEAD', t => {
  const { root, home, cleanup } = makeHome('precommit-evidence-binding-');
  t.after(cleanup);
  const wt = path.join(root, 'repo');
  mkdirSync(wt);
  writeFileSync(path.join(wt, 'notes.md'), 'base');
  git(wt, ['init', '--quiet'], home);
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(wt, ['rev-parse', 'HEAD'], home);
  writeFileSync(path.join(wt, 'notes.md'), 'checked candidate');
  const source = sourceIdentity(wt);
  const evidence = { source, touchFlows: [], touchFlowsReason: 'docs only', runs: [], testSelection: [], testRuns: [], rerunCycles: [],
    e2eCapability: structuredClone(SELECTED.e2eCapability),
    targetedInventory: { actor: 'read-only', source: 'working-tree', commit: base,
      laneReport: { command: 'pnpm test:lanes', matches: [] }, entries: [], noTestsReason: 'docs only' } };
  const gate = () => pullRequestFacts({ worktree: wt, base, include: new Set(['notes.md']), ownBranch: 'main', runs: evidence,
    commit: git(wt, ['rev-parse', 'HEAD'], home) }).prEvidenceProblems;
  assert.deepEqual(gate(), [], 'the dirty candidate is checked before its first commit');
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'one push-ready commit'], home);
  assert.deepEqual(gate(), [], 'only identical content can carry the accepted source evidence');
  assert.equal(evidence.targetedInventory.commit, base);
  assert.equal(evidence.source.head, base);
  writeFileSync(path.join(wt, 'notes.md'), 'unchecked post-verification change');
  assert.match(gate().join('\n'), /source.*(?:changed|match|identity)/i);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SCHEMA = path.join(HERE, "pr-evidence-schema.mjs");
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
  targetedInventory: {
    actor: "read-only", source: "final-committed-diff", commit: "a".repeat(40), laneReport: { command: "pnpm test:lanes", matches: [] },
    entries: [{ kind: "vitest", path: TEST, cases: ["limits"], command: "vitest run" }],
  },
  rerunCycles: [],
  e2eCapability: {
    selectedTier: "A",
    container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
    native: { available: true, forbidden: false }, remote: { available: false },
  },
  testRuns: [{ path: TEST, cases: ["limits"], status: "passed", commit: "a".repeat(40), command: "vitest run" }],
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

test("overlap retrieves a complete file list when gh pr diff rejects a large PR", (t) => {
  const fixture = makeHome("pr-overlap-large-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  const script = path.join(bin, "gh");
  writeFileSync(script, `#!/bin/sh
case "$1 $2" in
  "pr list") printf '%s\\n' '[{"number":9191,"title":"Large PR","headRefName":"feature/large","files":${JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ path: `src/file-${i}.ts` })))} }]' ;;
  "pr diff") echo 'HTTP 422: diff exceeds 300 files' >&2; exit 1 ;;
  "api repos/closedloop-ai/symphony-alpha/pulls/9191") printf '%s\\n' '320' ;;
  "api --paginate") i=0; while [ "$i" -lt 320 ]; do printf 'src/file-%s.ts\\n' "$i"; i=$((i+1)); done ;;
  *) exit 3 ;;
esac
`);
  chmodSync(script, 0o700);
  const code = `import { loadOpenPrs } from ${JSON.stringify(new URL("./pr-facts.mjs", import.meta.url).href)}; console.log(JSON.stringify({ prs: loadOpenPrs() }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fixture.root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(child.status, 0, child.stderr);
  const prs = JSON.parse(child.stdout).prs;
  assert.equal(prs[0].files.length, 320);
  assert.equal(prs[0].unavailableReason, undefined);
  writeFileSync(script, readFileSync(script, "utf8").replace("'320'", "'3205'").replace("-lt 320", "-lt 3000"));
  const capped = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fixture.root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(capped.status, 0, capped.stderr);
  assert.deepEqual(JSON.parse(capped.stdout).prs[0].files, []);
  assert.equal(JSON.parse(capped.stdout).prs[0].unavailableReason, "GitHub file API exposes 3000 of 3205 changed files");
});

test("an API-capped overlap is disclosed without claiming no overlap", (t) => {
  const s = session(t);
  const reason = "GitHub file API exposes 3000 of 3205 changed files";
  const prs = [{ number: 9191, title: "Very large PR", headRefName: "feature/large", files: [], unavailableReason: reason }];
  const missing = facts(s, { body: COMPLETE_BODY, prs }).prBodyProblems.join("\n");
  assert.match(missing, /Overlap unavailable: #9191/);
  const disclosed = facts(s, { body: `${COMPLETE_BODY}\nOverlap unavailable: #9191 (${reason})`, prs });
  assert.deepEqual(disclosed.prBodyProblems, []);
  assert.deepEqual(disclosed.overlap, []);
  assert.deepEqual(disclosed.overlapUnavailable, [{ number: 9191, title: "Very large PR", reason }]);
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
  const laneKey = "1".repeat(16);
  const runs = requiredLanes(changed, ["card select"]).map((lane) => ({ lane, status: "passed", command: "run", commit, laneKey, outcome: "selected",
    ...(lane === "storybook-plays" ? { playVerdicts: [{ storyId: "cards--select", verdict: "PASS" }] } : {}) }));
  const file = { touchFlows: ["card select"], runs, qaImpact: { laneKey } };
  assert.deepEqual(evidenceProblems(file, changed, commit), []);
  assert.match(evidenceProblems({ ...file, runs: runs.map((run, i) => (i === 2 ? { ...run, status: "running" } : run)) }, changed, commit).join(), /webkit-iphone: running/);
  assert.match(evidenceProblems({ ...file, runs: runs.slice(1) }, changed, commit).join(), /web-host: no run recorded/);
  assert.match(evidenceProblems(file, changed, "b".repeat(40)).join(), /recomputed/);
  assert.deepEqual(evidenceProblems({ ...file, qaImpact: { laneKey: "2".repeat(16) } }, changed, commit), [], "a trusted-only stored key is ignored at the current head");
  assert.match(evidenceProblems({ runs }, changed, commit).join(), /touchFlows/);
  const unjudged = runs.map((run) => (run.lane === "storybook-plays" ? { ...run, playVerdicts: undefined } : run));
  assert.match(evidenceProblems({ ...file, runs: unjudged }, changed, commit).join(), /storybook-plays: no playVerdicts/);
});

test("older lane and inventory evidence requires a recomputed impact key", (t) => {
  const fixture = makeHome("pr-facts-impact-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "wt");
  git(fixture.root, ["init", "--quiet", "--initial-branch=main", worktree], fixture.home);
  mkdirSync(path.join(worktree, "e2e"), { recursive: true });
  const spec = "e2e/changed.spec.ts";
  writeFileSync(path.join(worktree, spec), "export const value = 1;\n");
  git(worktree, ["add", "-A"], fixture.home);
  git(worktree, ["commit", "--quiet", "-m", "base"], fixture.home);
  const boundary = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  writeFileSync(path.join(worktree, spec), "export const value = 2;\n");
  git(worktree, ["commit", "--quiet", "-am", "change spec"], fixture.home);
  const final = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const command = "pnpm test:e2e";
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { [spec]: [command] } }, config: { docs: [] } };
  const laneKey = qaImpactRequest(worktree, request).laneKey;
  const old = "0".repeat(40);
  const run = { lane: "e2e", command, outcome: "passed", status: "passed", commit: old };
  const lanes = { touchFlows: [], touchFlowsReason: "spec only", runs: [run] };
  assert.match(evidenceProblems(lanes, [spec], final, worktree).join(), /recomputed/);
  assert.match(evidenceProblems({ ...lanes, qaImpactRequest: request }, [spec], final, worktree).join(), /scope missing/);
  assert.deepEqual(evidenceProblems({ ...lanes, qaImpactRequest: request, runs: [{ ...run, laneKey }] }, [spec], final, worktree), []);

  const targeted = { testSelection: [], qaImpactRequest: request,
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: old, impactKey: laneKey,
      laneReport: { command: "pnpm test:lanes", matches: [{ name: "e2e", command }] }, entries: [], noTestsReason: "lane only" },
    testRuns: [{ ...run, laneKey }], rerunCycles: [] };
  assert.deepEqual(targetedEvidenceProblems(targeted, final, worktree), []);
  const trustedOnly = { ...targeted, qaImpactRequest: undefined };
  assert.match(targetedEvidenceProblems(trustedOnly, final, worktree).join(), /recomputed/);
});

test("the inventory reports the facts and gates only the pull-request phase", (t) => {
  const s = session(t);
  const prs = s.file("prs.json", PRS);
  const ticket = s.file("ticket.md", "Say why POST vs DELETE in the PR.\n");
  const handoff = runNode(INVENTORY, ["--worktree", s.wt, "--phase", "handoff", "--ticket", ticket], s.home);
  assert.equal(handoff.json.serverOnly, true);
  assert.equal(handoff.json.overlap, null);
  assert.equal("prBody" in handoff.json.blocking, false);
  const run = (body, evidence = SELECTED) => runNode(INVENTORY, ["--worktree", s.wt, "--phase", "pull-request", "--ticket", ticket, "--prs-json", prs,
    "--body", s.file("body.md", body), "--runs", s.file("runs.json", { touchFlows: [], touchFlowsReason: "server only", runs: [], ...evidence }),
    "--commit", "a".repeat(40)], s.home);
  const failing = run("Summary only.");
  assert.equal(failing.status, 1);
  assert.equal(failing.json.blocking.prBody, false);
  const passing = run(COMPLETE_BODY);
  assert.equal(passing.json.blocking.prBody, true, JSON.stringify(passing.json.prBodyProblems));
  assert.equal(passing.json.blocking.prEvidence, true);
  const noTargetedArtifact = run(COMPLETE_BODY, { testSelection: SELECTED.testSelection, testRuns: SELECTED.testRuns });
  assert.equal(noTargetedArtifact.json.blocking.prEvidence, false);
  assert.match(noTargetedArtifact.json.prEvidenceProblems.join(), /targeted inventory.*missing/);
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
  assert.ok(empty.some((problem) => problem.startsWith(`${TEST}: selected but no passing`)), "an edited spec is always selected");
  const unindexed = SELECTED.testSelection.map((entry) => (entry.file === "packages/api/src/service.ts" && entry.selector === "code_tests_for" ? { ...entry, tests: null } : entry));
  assert.match(gate({ ...SELECTED, testSelection: unindexed }).join(), /service\.ts: no import selection/);
  assert.deepEqual(gate({ ...SELECTED, testSelection: [...unindexed, { file: "packages/api/src/service.ts", selector: "related", tests: [] }] }), []);
  const emptyGraph = SELECTED.testSelection.map((entry) => (entry.selector === "code_tests_for" && entry.file === ROUTE ? { ...entry, tests: [] } : entry));
  assert.match(gate({ ...SELECTED, testSelection: emptyGraph }).join(), /route\.ts: no import selection/);
  assert.match(gate(SELECTED, [{ path: "e2e/links.spec.ts", reason: "names the endpoint" }]).join(), /e2e\/links\.spec\.ts: selected but no passing/);
  assert.match(gate({ ...SELECTED, testRuns: [{ ...SELECTED.testRuns[0], commit: "b".repeat(40) }] }).join(), /links\.test\.ts: selected but no passing/);
  assert.match(gate({ ...SELECTED, testRuns: [{ ...SELECTED.testRuns[0], status: "skipped" }] }).join(), /links\.test\.ts: selected but no passing/);
  assert.match(selectionProblems({ testSelection: [{ file: ROUTE, selector: "guess", tests: [] }] }, [], [], commit).join(), /selector "guess"/);
});

test("a required test with flag states needs a passing run with the flag on and with it off", () => {
  const commit = "c".repeat(40);
  const required = [{ path: "apps/a/sessions.test.tsx", reason: "shared", flagStates: ["on", "off"] }];
  const run = (flag) => ({ path: "apps/a/sessions.test.tsx", status: "passed", commit, ...(flag ? { flag } : {}) });
  const problems = (testRuns) => selectionProblems({ testSelection: [], testRuns }, [], required, commit);
  assert.deepEqual(problems([run("on")]), [`apps/a/sessions.test.tsx: no passing run with the flag off for ${commit} (testRuns entry with flag: "off")`]);
  assert.equal(problems([run()]).length, 2, "a run that names no flag state counts for neither");
  assert.deepEqual(problems([run("on"), run("off")]), []);
});

test("a pull request inventory and lane runs follow qa-impact scope instead of the final commit", () => {
  const commit = "d".repeat(40);
  const laneKey = "4".repeat(16);
  const entry = { kind: "vitest", path: TEST, cases: ["limits"], command: `pnpm --filter api exec vitest run ${TEST} -t limits` };
  const complete = {
    targetedInventory: {
      actor: "read-only",
      source: "final-committed-diff",
      commit,
      impactKey: laneKey,
      laneReport: { command: "pnpm test:lanes", matches: [] },
      entries: [entry],
    },
    testSelection: [{ file: ROUTE, selector: "code_tests_for", tests: [TEST] }],
    testRuns: [{ path: TEST, cases: ["limits"], command: entry.command, status: "passed", commit }],
    rerunCycles: [],
  };
  assert.deepEqual(targetedEvidenceProblems(complete, commit), []);
  assert.match(targetedEvidenceProblems({}, commit).join(), /targeted inventory.*missing/);
  assert.match(targetedEvidenceProblems({ ...complete, targetedInventory: { ...complete.targetedInventory, actor: "writer" } }, commit).join(), /read-only/);
  assert.match(targetedEvidenceProblems({ ...complete, testRuns: [] }, commit).join(), /no passing targeted run/);
});

test("the verifier's object-shaped selection and path-only inventory fail closed instead of crashing", (t) => {
  const s = session(t);
  const commit = "d".repeat(40);
  const actualVerifierShape = {
    testSelection: { codeTestsFor: { [ROUTE]: ["links.test.ts"] } },
    targetedInventory: { vitest: [TEST], storybook: [], webE2eSpecs: [], desktopE2eSpecs: [] },
    testRuns: [{ lane: "api", command: "pnpm --filter api test", commit, status: "pass" }],
  };
  const result = facts(s, { body: COMPLETE_BODY, runs: actualVerifierShape, commit });
  assert.match(result.prEvidenceProblems.join("\n"), /testSelection must be an array/);
  assert.match(result.prEvidenceProblems.join("\n"), /targetedInventory.*final committed diff/);
  assert.match(result.prEvidenceProblems.join("\n"), /targetedInventory.*exact entries/);
});

test("selection evidence never silently drops a nonarray or malformed test list", () => {
  const commit = "d".repeat(40);
  assert.match(selectionProblems({ testSelection: { codeTestsFor: { [ROUTE]: [TEST] } } }, [], [], commit).join(), /testSelection must be an array/);
  assert.match(selectionProblems({ testSelection: [{ file: ROUTE, selector: "code_tests_for", tests: { path: TEST } }] }, [], [], commit).join(), /tests must be an array/);
});

test("edited web and Desktop e2e specs can be carried only by exact not-run CI evidence", () => {
  const commit = "f".repeat(40);
  const web = "e2e/org-issues-list.spec.ts";
  const desktop = "apps/desktop/test/e2e/issues-list.spec.ts";
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='' pnpm --dir apps/desktop test:e2e" };
  const ciOwner = { [web]: "e2e-test.yml:e2e", [desktop]: "desktop-e2e-validation.yml:desktop-e2e/validated" };
  const records = [
    { path: web, status: "not-run", commit, reason: NOT_RUN_NO_IDENTITY,
      ciOwner: ciOwner[web], selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" },
    { path: desktop, status: "not-run", commit, reason: NOT_RUN_NO_DESKTOP_HARNESS,
      ciOwner: ciOwner[desktop], selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" },
  ];
  const evidence = {
    testSelection: [{ file: ROUTE, selector: "e2e-reference", tests: [web, desktop] }],
    testRuns: [...records, { lane: lane.name, command: lane.command, status: "not-run", commit, reason: NOT_RUN_NO_DESKTOP_HARNESS }],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [lane] },
      entries: [web, desktop].map((spec) => ({ kind: "e2e", path: spec, cases: ["changed name"], command: "not run locally" })) },
    e2eCapability: { selectedTier: null, container: { dockerPresent: false, dockerReachable: false,
      memoryGiB: 0, diskGiB: 0, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
      native: { available: false }, remote: { available: false }, unavailableSpecs: [web, desktop], ciCoverage: Object.values(ciOwner) },
  };
  const changed = [web, desktop].map((path) => ({ path, status: "M" }));
  const check = (candidate) => selectionProblems(candidate, changed, [], commit);
  assert.deepEqual(check(evidence), []);
  assert.deepEqual(targetedEvidenceProblems({ ...evidence, rerunCycles: [] }, commit), []);
  assert.match(targetedEvidenceProblems({ ...evidence, rerunCycles: [], testRuns: evidence.testRuns.filter((run) => run.path !== web) }, commit).join(),
    /unavailable E2E needs an exact not-run spec record/);
  for (const changedEvidence of [
    { ...evidence, testRuns: evidence.testRuns.filter((run) => run.path !== web) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === web ? { ...run, commit: "a".repeat(40) } : run) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === web ? { ...run, ciOwner: "unknown" } : run) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === desktop ? { ...run, reason: "machine busy" } : run) },
    { ...evidence, testRuns: evidence.testRuns.filter((run) => run.lane !== lane.name) },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, unavailableSpecs: [desktop] } },
  ]) assert.match(check(changedEvidence).join(), /selected but no passing or carried run/);
});

test("Tier A Docker can be ready while five selected specs lack required identity or displayless execution", () => {
  const commit = "f".repeat(40);
  const web = ["e2e/gated-route-shells.spec.ts", "e2e/org-issues-list.spec.ts", "e2e/shell-sidebar-v2-route-matrix.spec.ts"];
  const desktop = ["apps/desktop/test/e2e/issues-list.spec.ts", "apps/desktop/test/e2e/labs-signed-in-only-nav.spec.ts"];
  const specs = [...web, ...desktop];
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='' DESKTOP_E2E_CHANGED_SPECS='' pnpm --dir apps/desktop test:e2e" };
  const missingPrerequisites = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];
  const displaylessLimitation = "no supported displayless Linux Electron harness";
  const capability = {
    selectedTier: "A",
    probedCommit: commit,
    container: { dockerPresent: true, dockerReachable: true, memoryGiB: 23.4, diskGiB: 936,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "docker version; docker info; dagger version; df",
      runnable: false, notRunnableReason: missingPrerequisites.join(", "),
      secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } },
    native: { available: false }, remote: { available: false },
    desktopHarness: { available: false, reason: displaylessLimitation, probe: "macOS has no Linux Xvfb/dbus/keyring harness" },
    unavailableSpecs: specs, ciCoverage: ["e2e-test.yml:e2e", "desktop-e2e-validation.yml:desktop-e2e/validated"],
  };
  const runs = [
    ...web.map((path) => ({ path, kind: "e2e", status: "not-run", commit, selectedTier: "A", missingPrerequisites,
      reason: NOT_RUN_NO_IDENTITY, ciOwner: "e2e-test.yml:e2e", selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" })),
    ...desktop.map((path) => ({ path, kind: "e2e", status: "not-run", commit, selectedTier: "A", displaylessLimitation,
      reason: NOT_RUN_NO_DESKTOP_HARNESS, ciOwner: "desktop-e2e-validation.yml:desktop-e2e/validated",
      selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" })),
    { lane: lane.name, command: lane.command, status: "not-run", commit, reason: NOT_RUN_NO_DESKTOP_HARNESS },
  ];
  const evidence = {
    touchFlows: [], touchFlowsReason: "no changed touch flow", runs: [], testRuns: runs, rerunCycles: [],
    testSelection: [{ file: ROUTE, selector: "e2e-reference", tests: specs }],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [lane] },
      entries: specs.map((path) => ({ kind: "e2e", path, cases: ["changed name"], command: "not run locally" })) },
    e2eCapability: capability,
  };
  const changed = specs.map((path) => ({ path, status: "M" }));
  assert.deepEqual(selectionProblems(evidence, changed, [], commit), []);
  assert.deepEqual(targetedEvidenceProblems(evidence, commit), []);
  assert.deepEqual(evidenceProblems(evidence, specs, commit), []);
  const rejects = (candidate) => assert.match(selectionProblems(candidate, changed, [], commit).join(), /selected but no passing or carried run/);
  rejects({ ...evidence, testRuns: runs.filter((run) => run.path !== web[0]) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, commit: "a".repeat(40) } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, selectedTier: null } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, ciOwner: "unknown" } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, reason: "generic missing secrets" } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, selectionSource: "guess" } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === web[0] ? { ...run, missingPrerequisites: ["LIVEBLOCKS_SECRET"] } : run) });
  rejects({ ...evidence, testRuns: runs.map((run) => run.path === desktop[0] ? { ...run, displaylessLimitation: "" } : run) });
  rejects({ ...evidence, testRuns: runs.filter((run) => run.lane !== "desktop-e2e") });
  rejects({ ...evidence, e2eCapability: { ...capability, container: { ...capability.container, command: "" } } });
  rejects({ ...evidence, e2eCapability: { ...capability, probedCommit: "a".repeat(40) } });
  rejects({ ...evidence, e2eCapability: { ...capability, container: { ...capability.container,
    secretsSet: { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } } } });
  rejects({ ...evidence, e2eCapability: { ...capability, container: { ...capability.container,
    runnable: true, secretsSet: { CLERK_SECRET_KEY: true, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: true, DEVOPS_CLOSEDLOOP_APP_PWD: true } } } });
  rejects({ ...evidence, e2eCapability: { ...capability, desktopHarness: { ...capability.desktopHarness, available: true } } });
});

test("the PR gate rejects a claimed no-Docker carry when its live read-only probe sees Tier A", (t) => {
  const s = session(t);
  const commit = "a".repeat(40);
  const current = {
    probedCommit: commit,
    container: { dockerPresent: true, dockerReachable: true, memoryGiB: 23.4, diskGiB: 936,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "docker info",
      secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } },
    desktopHarness: { available: false, reason: "no supported displayless Linux Electron harness", probe: "darwin" },
  };
  const claimed = { ...current, selectedTier: null,
    container: { ...current.container, dockerPresent: false, dockerReachable: false, memoryGiB: 0 } };
  const runs = { ...SELECTED, touchFlows: [], touchFlowsReason: "server only", runs: [], e2eCapability: claimed,
    testRuns: [...SELECTED.testRuns, { path: "e2e/org-issues-list.spec.ts", status: "not-run", commit }] };
  const result = facts(s, { runs, commit, probeCapability: () => current });
  assert.match(result.prEvidenceProblems.join("\n"), /Docker runtime probe differs from the current machine/);
  const truthful = { ...runs, e2eCapability: { ...current, selectedTier: "A" } };
  assert.deepEqual(capabilityProbeProblems(truthful, s.wt, commit, () => current), []);
  assert.match(capabilityProbeProblems({ ...truthful, e2eCapability: { ...truthful.e2eCapability, probedCommit: undefined } },
    s.wt, commit, () => current).join(), /not bound to the final committed HEAD/);
  assert.match(capabilityProbeProblems({ ...truthful, e2eCapability: { ...truthful.e2eCapability,
    container: { ...current.container, secretsSet: { ...current.container.secretsSet, CLERK_SECRET_KEY: true } } } },
    s.wt, commit, () => current).join(), /identity-key presence differs/);
});

test("the verifier's private shape check rejects path-only evidence and accepts exact entries", (t) => {
  const s = session(t);
  const invalid = s.file("invalid-pr-evidence.json", {
    testSelection: { codeTestsFor: { [ROUTE]: ["links.test.ts"] } },
    targetedInventory: { vitest: [TEST] }, testRuns: [],
  });
  const rejected = runNode(SCHEMA, ["--file", invalid], s.home);
  assert.equal(rejected.status, 1);
  assert.match(rejected.json.problems.join("\n"), /testSelection must be an array/);
  assert.match(rejected.json.problems.join("\n"), /targetedInventory needs exact entries/);
  const accepted = runNode(SCHEMA, ["--file", s.file("valid-pr-evidence.json", SELECTED)], s.home);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.json));
  assert.deepEqual(accepted.json.problems, []);
});

test("after a fix only failed and newly reached targets may be rerun", () => {
  const before = "1".repeat(40);
  const after = "2".repeat(40);
  const sameHash = "a".repeat(64);
  const entry = (path, extra = {}) => ({ kind: "vitest", path, cases: [path], command: `vitest ${path}`, ...extra });
  const evidence = {
    testSelection: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: after,
      fileHashes: { "src/passed.ts": sameHash },
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [
        entry("passed.test.ts", { resultCommit: before, carriedTo: after, carryReason: "the isolated fix cannot reach this module",
          coveredFiles: [{ path: "src/passed.ts", sha256: sameHash }] }),
        entry("failed.test.ts"),
      ] },
    testRuns: [
      { path: "passed.test.ts", cases: ["passed.test.ts"], command: "vitest passed.test.ts", status: "passed", commit: before },
      { path: "failed.test.ts", cases: ["failed.test.ts"], command: "vitest failed.test.ts", status: "passed", commit: after },
    ],
    rerunCycles: [{ fromCommit: before, toCommit: after, failed: ["failed.test.ts"], newlyReached: [], rerun: ["failed.test.ts"] }],
  };
  assert.deepEqual(targetedEvidenceProblems(evidence, after), []);
  const broad = { ...evidence, rerunCycles: [{ ...evidence.rerunCycles[0], rerun: ["failed.test.ts", "passed.test.ts"] }] };
  assert.match(targetedEvidenceProblems(broad, after).join(), /only its failed cases/);
  const changed = { ...evidence, targetedInventory: { ...evidence.targetedInventory, fileHashes: { "src/passed.ts": "b".repeat(64) } } };
  assert.match(targetedEvidenceProblems(changed, after).join(), /src\/passed\.ts.*hash changed/);
});

test("every lane pnpm test:lanes names needs a passing run of its own command, not a hand-picked subset (#9238)", () => {
  const commit = "f".repeat(40);
  const laneKey = "7".repeat(16);
  const entry = { kind: "vitest", path: TEST, cases: ["limits"], command: "vitest run" };
  const lane = { name: "app", command: "pnpm --filter app test packages/design-system" };
  const evidence = (matches, testRuns) => ({
    testSelection: [],
    qaImpact: { laneKey },
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, impactKey: laneKey, laneReport: { command: "pnpm test:lanes", matches }, entries: [entry] },
    testRuns: [{ path: TEST, cases: ["limits"], command: "vitest run", status: "passed", commit }, ...testRuns], rerunCycles: [],
  });
  assert.match(targetedEvidenceProblems(evidence([lane], []), commit).join(), /lane app: no passing run/);
  assert.match(targetedEvidenceProblems(evidence([lane], [{ lane: "app", command: "vitest run capability-parity", status: "passed", commit }]), commit).join(), /hand-picked/);
  assert.deepEqual(targetedEvidenceProblems(evidence([lane], [{ lane: "app", command: lane.command, status: "passed", commit, laneKey: "8".repeat(16) }]), commit), [], "current-head provenance needs no carry key");
  assert.deepEqual(targetedEvidenceProblems(evidence([{ ...lane, mentionOnly: true, notRunReason: "only its AGENTS.md mentions the path" }], []), commit), []);
});

test("a changed check or CI script needs a run in its CI job's checkout shape (#9230)", () => {
  const commit = "c".repeat(40);
  const repro = { job: "pr-test.yml:storybook-build", tier: "batch-only", checkout: "fetch-depth 1, no CI_DIFF_BASE_REF", command: "GITHUB_ACTIONS=true pnpm --filter storybook validate:catalog", status: "passed", commit };
  assert.deepEqual(ciCheckProblems({}, ["apps/app/page.tsx"], commit), []);
  for (const file of ["scripts/lint/rules/story-rules.ts", "apps/storybook/package.json", ".github/workflows/pr-test.yml", "packages/design-system/checks/catalog.ts"]) {
    assert.match(ciCheckProblems({}, [file], commit).join(), /ciCheckRepros/, file);
  }
  assert.match(ciCheckProblems({ ciCheckRepros: [] }, ["scripts/a.ts"], commit).join(), /noCiCheckReason/);
  assert.deepEqual(ciCheckProblems({ ciCheckRepros: [], noCiCheckReason: "dependency version only" }, ["package.json"], commit), []);
  assert.match(ciCheckProblems({ ciCheckRepros: [{ ...repro, status: "failed" }] }, ["scripts/a.ts"], commit).join(), /storybook-build: no passing run/);
  assert.match(ciCheckProblems({ ciCheckRepros: [{ ...repro, checkout: "" }] }, ["scripts/a.ts"], commit).join(), /needs job, tier, checkout/);
  assert.deepEqual(ciCheckProblems({ ciCheckRepros: [repro] }, ["scripts/a.ts"], commit), []);
});

test("the Desktop e2e lane left for CI by pre-pr-lanes is not a missing lane run (ISS-13321)", () => {
  const commit = "f".repeat(40);
  const laneKey = "9".repeat(16);
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='@smoke' DESKTOP_E2E_CHANGED_SPECS='' pnpm --dir apps/desktop test:e2e" };
  const evidence = (testRuns) => ({
    testSelection: [], qaImpact: { laneKey },
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, impactKey: laneKey, laneReport: { command: "pnpm test:lanes", matches: [lane] }, entries: [], noTestsReason: "lane only" },
    testRuns, rerunCycles: [],
  });
  const notRun = { lane: lane.name, command: lane.command, status: "not-run", reason: NOT_RUN_NO_DESKTOP_HARNESS, commit, laneKey };
  assert.deepEqual(targetedEvidenceProblems(evidence([notRun]), commit), []);
  assert.match(targetedEvidenceProblems(evidence([{ ...notRun, reason: "" }]), commit).join(), /lane desktop-e2e: no passing run/, "a not-run record names why");
  assert.deepEqual(targetedEvidenceProblems(evidence([{ ...notRun, laneKey: "a".repeat(16) }]), commit), [], "current-head provenance needs no carry key");
  const web = { name: "e2e", command: "pnpm test:e2e" };
  const webEvidence = { ...evidence([{ ...notRun, lane: web.name, command: web.command }]) };
  webEvidence.targetedInventory = { ...webEvidence.targetedInventory, laneReport: { command: "pnpm test:lanes", matches: [web] } };
  assert.match(targetedEvidenceProblems(webEvidence, commit).join(), /lane e2e: no passing run/, "only the Desktop lane is left for CI here");
});

test("a run that also fails on captured main does not block, and the body lists it under Known main failures (ISS-13321)", (t) => {
  const commit = "a".repeat(40);
  const mainSha = "9".repeat(40);
  const red = (extra) => ({ status: "main-preexisting", mainSha, commit, ...extra });
  const required = [{ path: "scripts/deploy/deploy-guards.test.ts", reason: "path gate" }];
  assert.deepEqual(selectionProblems({ testSelection: [], testRuns: [red({ path: required[0].path })] }, [], required, commit), []);
  assert.match(selectionProblems({ testSelection: [], testRuns: [red({ path: required[0].path, mainSha: undefined })] }, [], required, commit).join(), /selected but no passing/,
    "main-preexisting names the main it failed on");
  const lane = { name: "deploy-guards", command: "pnpm test:deploy-guards" };
  const lanes = { testSelection: [], targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, laneReport: { command: "pnpm test:lanes", matches: [lane] }, entries: [], noTestsReason: "lane only" },
    testRuns: [red({ lane: lane.name, command: lane.command })], rerunCycles: [] };
  assert.deepEqual(targetedEvidenceProblems(lanes, commit), []);
  const changed = ["packages/app/list.tsx"];
  const runs = requiredLanes(changed).map((name) => (name === "web-host" ? red({ lane: name, command: "control", outcome: "fails on main too" })
    : { lane: name, status: "passed", command: "control", outcome: "ok", commit }));
  assert.deepEqual(evidenceProblems({ touchFlows: [], touchFlowsReason: "none", runs }, changed, commit), []);
  const runsFile = { testRuns: lanes.testRuns };
  assert.deepEqual(knownMainFailureProblems("## Summary\nNothing.", runsFile), [`${lane.command} fails on main too; list it under "Known main failures" with the main commit`]);
  assert.deepEqual(knownMainFailureProblems(`## Known main failures\n- ${lane.command} fails on ${mainSha}`, runsFile), []);
  const s = session(t);
  const wired = facts(s, { body: COMPLETE_BODY, runs: { ...SELECTED, ...runsFile, testRuns: [...SELECTED.testRuns, ...runsFile.testRuns] }, commit });
  assert.ok(wired.prBodyProblems.some((problem) => problem.includes("Known main failures")), "the body gate reads the runs");
});

test("the web e2e lane is not required locally when every changed spec is left for CI (ISS-13321)", () => {
  const commit = "b".repeat(40);
  const spec = "e2e/issues-row.spec.ts";
  const capability = {
    selectedTier: null,
    container: { dockerPresent: false, dockerReachable: false, memoryGiB: 0, diskGiB: 0, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
    native: { available: false }, remote: { available: false },
    unavailableSpecs: [spec], ciCoverage: ["e2e-test.yml:e2e"],
  };
  const file = { touchFlows: [], touchFlowsReason: "none", runs: [], e2eCapability: capability,
    testSelection: [{ file: ROUTE, selector: "e2e-reference", tests: [spec] }],
    targetedInventory: { laneReport: { command: "pnpm test:lanes", matches: [] } },
    testRuns: [{ path: spec, status: "not-run", commit, reason: NOT_RUN_NO_IDENTITY,
      ciOwner: "e2e-test.yml:e2e", selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" }] };
  assert.deepEqual(evidenceProblems(file, [spec], commit), []);
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: { ...capability, ciCoverage: [] } }, [spec], commit), ["e2e: no run recorded"]);
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: { ...capability, unavailableSpecs: [] } }, [spec], commit), ["e2e: no run recorded"]);
  const docker = { ...capability, container: { ...capability.container, dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80 } };
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: docker }, [spec], commit), ["e2e: no run recorded"], "a machine that can run it runs it");
});
