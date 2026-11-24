import { realpathSync } from "node:fs";
import { encodePng } from "./png-diff.mjs";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { captureVisualQaViewport } from "../../../lib/vibe/scripts/viewport-overflow.mjs";
import { visualQaBodySection, visualQaFindingsProblems } from "../../../lib/vibe/scripts/required-visual-qa.mjs";
import { captureReviewReceipt, graphCalls, reviewTraceFacts } from "../../../lib/handoff/scripts/review-receipts.mjs";
import { sourceIdentity } from "../../../lib/vibe/scripts/tested-head.mjs";
import { criteriaStates, unreadCriteriaProblems } from "./criteria-list.mjs";
import { run } from "./diff-rules-test-fixture.mjs";
import { topLevelTestCases } from "../../vibe/scripts/dist/qa-impact-parser.mjs";
import { pullRequestFacts } from "./pr-facts.mjs";
import { createGuardrailsGate, scanTestRepairs } from "./guardrails-gate.mjs";
import { classifyHandoffPath, PathDisposition } from "./path-classifier.mjs";
import { fileRuleCache } from "./inventory-cache.mjs";
import { frozenComparisonBase, frozenGate } from "./frozen-render-gate.mjs";
import { FrozenSlotBusy } from "./frozen-render.mjs";

test("ISS-14476 ties file-local cache results to exact patch, shared context and rule inputs", (t) => {
  const { root, cleanup } = makeHome("vibe-file-local-");
  t.after(cleanup);
  const key = { head: "a".repeat(40), phase: "pull-request", rulesVersion: "r1", contextHash: "scope" };
  const a = { path: "app/a.ts", added: [{ line: 1, text: "apply()" }] };
  const other = { path: "app/b.ts", added: [{ line: 4, text: "other()" }] };
  const findings = [{ rule: "linked", file: a.path, line: 1, problem: "problem", fix: "fix" }];
  const first = fileRuleCache(root, key);
  assert.deepEqual(first.findings("group", a, "apply()", () => findings), findings);
  first.save();
  const read = fileRuleCache(root, key);
  assert.deepEqual(read.findings("group", other, "other()", () => []), []);
  assert.deepEqual(read.findings("group", a, "apply()", () => assert.fail("unrelated file missed a stable hit")), findings);
  assert.deepEqual(read.findings("group", a, "applyMore()", () => []), []);
  assert.deepEqual(fileRuleCache(root, { ...key, contextHash: "new" }).findings("group", a, "apply()", () => []), []);
  assert.deepEqual(fileRuleCache(root, { ...key, rulesVersion: "r2" }).findings("group", a, "apply()", () => []), []);
});

test("ISS-14476 preserves outer criteria IDs and reports unread boxes under a sibling heading", () => {
  const ticket = "## Acceptance criteria\n- [x] first\n### Acceptance criteria for web\n- [ ] next\n### Desktop\n1) [ ] unread\n## Other\n+ [ ] checklist\n";
  assert.deepEqual(criteriaStates(ticket).map(({ id, text }) => [id, text]), [["AC-1", "first"], ["AC-2", "next"]]);
  assert.equal(unreadCriteriaProblems(ticket).length, 1);
  assert.match(unreadCriteriaProblems(ticket)[0], /under "Acceptance criteria"/);
});

test("ISS-14476 counts observed graph calls rather than the reviewer's self-report", () => {
  const call = { type: "tool_use", name: "mcp__graph__code_callers" };
  const alias = "mcp__graph__code_callers";
  const trace = (block) => reviewTraceFacts([
    JSON.stringify({ type: "assistant", message: { content: [block] } }),
    JSON.stringify({ type: "result", session_id: "sessions" }),
  ].join("\n"));
  assert.deepEqual(graphCalls({ graphToolAliases: [alias] }, trace({ type: "text", text: "used " + alias })), []);
  assert.deepEqual(graphCalls({ graphToolAliases: [alias] }, trace(call)), [alias]);
  assert.deepEqual(graphCalls({ graphToolAliases: [alias] }, trace({ ...call, name: "mcp__tracker__search" })), []);
});

test("AC-50 ISS-14476 checks near-ceiling story growth and recognizes the exact Debt ledger before handoff", (t) => {
  const story = "apps/storybook/notes.stories.ts";
  const at = (count) => "export const story = {};\n" + "// comment\n".repeat(count - 1);
  const fixture = run(t, { base: { [story]: at(903) }, head: { [story]: at(910) }, binding: null });
  const gate = () => createGuardrailsGate().gate({ worktree: fixture.checkout, base: fixture.baseSha }).findings
    .filter((result) => result.file === story && result.message.includes("near the 1000-line ceiling"));
  const log = path.join(fixture.checkout, ".git", "vibe-changes.md");
  assert.equal(gate().length, 1);
  writeFileSync(log, "Debt: coverage in one story; added: " + story + "; reused instead: stable story setup; reason: existing shared fixtures keep the states comparable\n");
  assert.equal(gate().length, 0);
});

test("ISS-14476 distinguishes a fresh default frozen base and a slot-admission timeout", async () => {
  const sha = "a".repeat(40);
  assert.equal(frozenComparisonBase("/unused", undefined, () => ({ ok: true, fetched: true, originMain: sha })), sha);
  assert.throws(() => frozenComparisonBase("/unused", "main", () => ({ ok: true, fetched: false, originMain: sha })),
    /could not be verified/);

  const report = await frozenGate({ repo: "/unused", base: sha, baseDir: "/prepared", out: "/unused" }, {
    layout: () => ({ renderManifests: [] }), select: () => ["changed.stories.tsx"], record: () => null, launch: () => null,
    compare: async () => { throw new FrozenSlotBusy("synthetic blocked admission"); },
  });
  assert.equal(report.exitCode, 2);
  assert.match(report.line, /^FROZEN BUSY /);
});

test("ISS-14476 captures each scroll end and the findings gate rejects wrong runtime, missing artifacts or overflow", async (t) => {
  const { root, cleanup } = makeHome("vibe-overflow-ledger-");
  t.after(cleanup);
  const head = "a".repeat(40);
  const base = { width: 387, height: 800, checkedContainers: 3, entries: [{
    path: "#scroll", scrollWidth: 500, clientWidth: 390, scrollHeight: 20, clientHeight: 20,
    horizontal: true, vertical: false, blocking: false,
  }] };
  const file = "apps/app/list.tsx";
  const png = encodePng({ width: 1, height: 1, data: Buffer.alloc(4) });
  const steps = [];
  const page = {
    async evaluate(fn) {
      steps.push(fn.name);
      if (fn.name === "inspectVisualQaOverflow") return structuredClone(base);
      if (fn.name === "revealScrollEnd") return { reached: true, offsets: [], farEndCoverage: { height: 20, bands: 1, filled: [0] } };
    },
    async screenshot({ path }) { writeFileSync(path, png); },
  };
  const capture = await captureVisualQaViewport(page, { evidenceDir: root, name: "mobile",
    capture: { surface: "web", target: "/issues", theme: "light", paths: [file] } });
  assert.deepEqual(steps, ["inspectVisualQaOverflow", "revealScrollEnd", "restoreScrollOffsets"]);
  assert.equal(capture.overflow.entries[0].farEndPng, "mobile-scroll-1.png");

  const record = { head, findings: [], rounds: [{ id: "round-1", head, runtime: "web", captures: [capture] }] };
  const evidence = path.join(root, "findings.json");
  const validate = (body = visualQaBodySection(record)) => {
    writeFileSync(evidence, JSON.stringify(record));
    return visualQaFindingsProblems(evidence, head, null, null, { paths: [file], body });
  };
  assert.deepEqual(validate(), []);
  assert.match(validate("## Visual QA\nold round").join("\n"), /complete Visual QA section/);
  capture.surface = "Desktop";
  assert.match(validate().join("\n"), /Desktop needs Electron/);
  capture.surface = "web";
  capture.overflow.entries[0].farEndPng = "absent.png";
  assert.match(validate().join("\n"), /far-end/);
  capture.overflow.entries[0] = { ...capture.overflow.entries[0], farEndPng: "mobile-scroll-1.png", path: ":root",
    blocking: true, protruding: { x: { path: "#outside" } } };
  assert.match(validate().join("\n"), /unintended overflow.*furthest box: #outside/);
});


test("AC-31 ISS-14476 keeps an available browser scenario advisory until the exact case is reproduced", (t) => {
  const fixture = makeHome("vibe-browser-premise-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout: worktree });
  const tracePath = path.join(fixture.root, "trace.jsonl");
  const resultFile = path.join(fixture.root, "result.json");
  const outFile = path.join(fixture.root, "receipt.json");
  const sessionId = "fixture-review";
  const role = "vibe-adversarial-reviewer";
  writeFileSync(tracePath, JSON.stringify({ type: "result", session_id: sessionId }) + "\n");
  const source = sourceIdentity(worktree);
  const finding = { id: "F1", blocking: true, evidence: "row wrap would hide the action",
    premises: [{ claim: "The row uses a fixed width", evidence: { kind: "code", file: "README.md", line: 1, fact: "sample cited line" } }],
    browserCase: { status: "queued", name: "narrow row" } };
  const receipt = (finding) => {
    writeFileSync(resultFile, JSON.stringify({ runtime: "claude", agentName: role, status: "DONE", sessionId,
      requestId: "fixture-case", tracePath, worktree: realpathSync(worktree), source, graphToolAliases: [], data: { findings: [finding] } }));
    return captureReviewReceipt({ worktree, resultFile, outFile, role });
  };

  assert.throws(() => receipt(finding), /browser case needs its reproducing runtime result/);
  assert.equal(receipt({ ...finding, blocking: false }).findings[0].blocking, false);
  const named = { ...finding, browserCase: { ...finding.browserCase, status: "reproduced" } };
  const runtime = (result) => ({ claim: "Run the named reproduction",
    evidence: { kind: "command", command: "fixture browsers report", result } });
  assert.throws(() => receipt({ ...named, premises: [...finding.premises, runtime("other case reproduced")] }), /its reproducing runtime result/);
  assert.equal(receipt({ ...named, premises: [...finding.premises, runtime("narrow row reproduced")] }).findings[0].blocking, true);
});

test("ISS-14476 admits exactly root AGENTS under the repository policy while other instruction files remain protected", () => {
  const repoPolicy = JSON.parse(readFileSync(new URL("../../../../../vibe-handoff-paths.json", import.meta.url), "utf8"));
  const input = { phase: "pull-request", policy: repoPolicy, repository: "example/independent-caller" };
  const disposition = (path) => classifyHandoffPath({ ...input, file: { path, status: "M" } }).disposition;

  assert.equal(disposition("AGENTS.md"), PathDisposition.Allowed);
  assert.equal(disposition("plugins/vibe/AGENTS.md"), PathDisposition.Forbidden);
  assert.equal(disposition("CLAUDE.md"), PathDisposition.Forbidden);
  assert.equal(disposition("AGENTS.override.md"), PathDisposition.Forbidden);
  assert.equal(disposition("vibe-handoff-paths.json"), PathDisposition.Forbidden);
});

const TEST_RUNNER = 'import test from "node:test";\n';
const LEFT_CASE = 'test("left case", () => { assert.equal(actual, first); });\n';
const MOVED_CASE = 'test("carried case", () => { assert.equal(actual, second); });\n';
const SOURCE_TEST = "test/pr-facts.test.mjs";
const SIBLING_TEST = "test/pr-facts-carry.test.mjs";

/** Run the existing repair gate with real test source and a changed-file inventory. */
function movedRepairFindings(destination, moved, status = "A", retained = LEFT_CASE, extra = []) {
  const source = new Map([[SOURCE_TEST, TEST_RUNNER + retained], [destination, moved], ...extra]);
  const files = [{ path: SOURCE_TEST, status: "M" }, { path: destination, status },
    ...extra.map(([file]) => ({ path: file, status: "A" }))];
  const base = (file) => file === SOURCE_TEST ? TEST_RUNNER + LEFT_CASE + MOVED_CASE : TEST_RUNNER;
  return scanTestRepairs(files, base, (file) => source.get(file)).findings;
}

test("ISS-14476 preserves a complete unchanged test moved into a newly added responsibility sibling", () => {
  assert.deepEqual(movedRepairFindings(SIBLING_TEST, TEST_RUNNER + MOVED_CASE), []);
});

test("ISS-14476 refuses changed, dropped, inactive, ambiguous and unrelated test moves", () => {
  const moved = TEST_RUNNER + MOVED_CASE;
  const controls = [
    ["edited assertion", movedRepairFindings(SIBLING_TEST, moved.replace("second", "first"))],
    ["dropped case", movedRepairFindings(SIBLING_TEST, TEST_RUNNER + LEFT_CASE)],
    ["unrelated filename", movedRepairFindings("test/other.test.mjs", moved)],
    ["different directory", movedRepairFindings("other/pr-facts-carry.test.mjs", moved)],
    ["modified destination", movedRepairFindings(SIBLING_TEST, moved, "M")],
    ["duplicate destination", movedRepairFindings(SIBLING_TEST, moved, "A", LEFT_CASE, [["test/pr-facts-duplicate.test.mjs", moved]])],
    ["disabled destination", movedRepairFindings(SIBLING_TEST, moved.replace('test("carried', 'test.skip("carried'))],
    ["fake runner", movedRepairFindings(SIBLING_TEST, moved.replace("node:test", "./helper.mjs"))],
    ["commented case", movedRepairFindings(SIBLING_TEST, TEST_RUNNER + "// " + MOVED_CASE)],
    ["retained same title", movedRepairFindings(SIBLING_TEST, moved, "A", LEFT_CASE + MOVED_CASE.replace("second", "first"))],
    ["unreadable source syntax", movedRepairFindings(SIBLING_TEST, moved, "A", LEFT_CASE + "let bad =")],
  ];
  for (const [label, findings] of controls) {
    assert.ok(findings.some((row) => row.file === SOURCE_TEST && row.evidence.includes("second")), label);
  }
});

test("ISS-14476 proves exact parser ranges across runner, callback and unrelated layout combinations", () => {
  const runners = [
    ['import test from "node:test";', "test", "node:test:test"],
    ['import { test as run } from "node:test";', "run", "node:test:test"],
    ['import { it as run } from "vitest";', "run", "vitest:it"],
    ['import { test } from "@playwright/test";', "test", "@playwright/test:test"],
  ];
  const callbacks = [
    '() => assertions.run()',
    'async () => { await assertions.run(); }',
    'function () { assertions.run(); }',
  ];
  const layouts = [
    ['', ''],
    ['const ignored = 1;\n', '\nconst trailing = 2;'],
    ['/* run("decoy", () => {}) */\n', '\n// run("decoy", () => {})'],
  ];
  for (const [binding, callee, runner] of runners) {
    for (const callback of callbacks) {
      for (const [before, after] of layouts) {
        const body = callee + '("a \\"literal\\"", ' + callback + ');';
        const prefix = binding + "\n" + before;
        const source = prefix + body + after;
        const [range, ...extras] = topLevelTestCases(SOURCE_TEST, source);
        assert.deepEqual(extras, []);
        assert.deepEqual(range, { name: 'a "literal"', runner, start: prefix.length, end: prefix.length + body.length });
        assert.equal(source.slice(range.start, range.end), body);
        assert.deepEqual(topLevelTestCases(SOURCE_TEST, prefix + "if (enabled) " + body + after), []);
        assert.deepEqual(topLevelTestCases(SOURCE_TEST, prefix + body.replace(callee + "(", callee + ".skip(") + after), []);
      }
    }
  }
  assert.equal(topLevelTestCases(SOURCE_TEST, TEST_RUNNER + "const invalid ="), null);
});

test("ISS-14476 reports exact moved test cases consistently in the real PR-facts diff", (t) => {
  const { root, home, cleanup } = makeHome("vibe-test-move-facts-");
  t.after(cleanup);
  const worktree = path.join(root, "repo");
  makeCheckout({ root, home, checkout: worktree, files: { [SOURCE_TEST]: TEST_RUNNER + LEFT_CASE + MOVED_CASE } });
  const base = git(worktree, ["rev-parse", "HEAD"], home);
  const read = () => pullRequestFacts({ worktree, base, include: new Set([SOURCE_TEST, SIBLING_TEST]), ownBranch: "main" }).assertionChanges;
  const source = path.join(worktree, SOURCE_TEST);
  const sibling = path.join(worktree, SIBLING_TEST);
  writeFileSync(source, TEST_RUNNER + LEFT_CASE);
  writeFileSync(sibling, TEST_RUNNER + MOVED_CASE);
  assert.deepEqual(read(), []);
  git(worktree, ["add", SIBLING_TEST], home);
  assert.deepEqual(read(), [], "a staged sibling remains an added test file");
  writeFileSync(sibling, TEST_RUNNER + MOVED_CASE.replace("second", "wrong"));
  assert.deepEqual(read().map(({ path, kind }) => [path, kind]), [[SOURCE_TEST, "removed"]]);
  writeFileSync(sibling, TEST_RUNNER + LEFT_CASE + MOVED_CASE);
  unlinkSync(source);
  assert.deepEqual(read(), [{ kind: "deleted-test-file", path: SOURCE_TEST }]);
});
