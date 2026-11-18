import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { checkAgentDecisionCitations, checkCommentClaims, checkExcuseComments, checkGuardedConstants, checkRemovedNameComments, checkSessionPointers, checkStaleCitations, citationPattern } from "./comment-rules.mjs";
import { bindProvider, makeHome, PROVIDER_BINDING } from "../../vibe/scripts/test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { ticketReference } = await vibeCore("lib/vibe/scripts/provider.mjs");
// The ClosedLoop provider's references, as a session it is bound to reads them.
const TICKETED = ticketReference(PROVIDER_BINDING);
const RULES = { ticketed: TICKETED, citations: citationPattern(PROVIDER_BINDING) };
import { parseUnifiedDiff } from "./diff-rules.mjs";
import { run } from "./diff-rules-test-fixture.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "comment-rules.mjs");
const CANVAS = "packages/app/documents/components/document-artifact-canvas.tsx";
const STORY = "apps/storybook/stories/surfaces-v2/v2-issue-detail.stories.tsx";
const LEAD = "packages/app/issues/components/detail-v2/issue-v2-canvas.tsx";

// The shapes PR #9732 shipped, reduced: the canvas before and after the historical edit row went.
const CANVAS_BASE = [
  "export function Canvas({ editMode, session }) {",
  "  const textControls = (",
  "    <Toolbar",
  "      readOnly={!editMode.isEditing}",
  "    />",
  "  );",
  "  const editRow =",
  "    editMode.isEditing || session.isViewingHistorical",
  "      ? { left: textControls }",
  "      : null;",
  "  return <Bar editRow={editRow} />;",
  "}",
  "",
].join("\n");
const CANVAS_HEAD = [
  "export function Canvas({ editMode, session }) {",
  "  const textControls = (",
  "    <Toolbar",
  "      readOnly={!editMode.isEditing}",
  "    />",
  "  );",
  "  const toolbarParts = {",
  "    editBar: editMode.isEditing ? textControls : null,",
  "  };",
  "  return <Bar parts={toolbarParts} />;",
  "}",
  "",
].join("\n");
const STORY_HEAD = [
  "/**",
  " * The issue with its checked task line left out of the body: the shared",
  " * rich-text style renders one below 4.5:1 contrast, a pre-existing defect on",
  " * main (packages/rich-text/tiptap-editor.css).",
  " */",
  "export const issue = strip(fixture);",
  "",
].join("\n");
const LEAD_BASE = "/** Above the text, in the DI-13 layout. */\nexport const A = 1;\n/**\n * Edit bar under the fields, as in the DI-13 design.\n */\nexport const B = 2;\n";
const LEAD_HEAD = "/** Above the text, in the DI-13 layout. */\nexport const A = 1;\n/**\n * Edit bar under the fields, as in the issue detail design (ISS-13897).\n */\nexport const B = 2;\n";

function files(diff) {
  return parseUnifiedDiff(diff);
}

function collect(check) {
  const found = [];
  check((rule, file, line, problem) => found.push({ rule, file, line, problem }));
  return found;
}

test("the PR #9732 shapes block through diff-rules: an unticketed excuse comment and a constant guarded prop (ISS-13947)", (t) => {
  const result = run(t, { base: { [CANVAS]: CANVAS_BASE, [LEAD]: LEAD_BASE }, head: { [CANVAS]: CANVAS_HEAD, [STORY]: STORY_HEAD, [LEAD]: LEAD_HEAD } });
  assert.deepEqual(result.found.filter(([rule]) => ["excuse-comment", "guarded-constant"].includes(rule)).sort(), [["excuse-comment", STORY], ["guarded-constant", CANVAS]]);
  assert.equal(result.blocking.find((finding) => finding.rule === "guarded-constant").line, 4);
  assert.match(result.blocking.find((finding) => finding.rule === "guarded-constant").problem, /`textControls` is used only where `editMode.isEditing` is true/);
  assert.ok(!result.found.some(([rule]) => rule === "stale-citation"), "a citation candidate is the reviewer's, never blocking");

  const fixed = run(t, { base: { [CANVAS]: CANVAS_BASE }, head: {
    [CANVAS]: CANVAS_HEAD.replace("      readOnly={!editMode.isEditing}\n", ""),
    [STORY]: STORY_HEAD.replace("a pre-existing defect on\n * main (packages/rich-text/tiptap-editor.css)", "ISS-13948"),
  } });
  assert.deepEqual(fixed.found.filter(([rule]) => ["excuse-comment", "guarded-constant"].includes(rule)), []);
});

test("an excuse comment needs a ticket; ordinary comments with those words elsewhere do not fire", () => {
  const diff = (lines) => files(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
  assert.equal(collect((add) => checkExcuseComments(diff(["// Works around a known issue in the date picker."]), add, TICKETED)).length, 1);
  assert.equal(collect((add) => checkExcuseComments(diff(["// Skips the row: a pre-existing defect", "// in the shared fixture."]), add, TICKETED)).length, 1, "one finding per comment block");
  assert.deepEqual(collect((add) => checkExcuseComments(diff(["// Works around a known issue in the date picker (ISS-1234)."]), add, TICKETED)), []);
  assert.deepEqual(collect((add) => checkExcuseComments(diff(["// The parsing bug flag shows the banner.", "// Guards a regression in sort order."]), add, TICKETED)), []);
  assert.deepEqual(collect((add) => checkExcuseComments(diff(["const onMain = 'pre-existing';"]), add, TICKETED)), [], "code, not a comment");
});

test("a guarded constant needs every use guarded and the diff to touch it", () => {
  const head = (uses) => `const controls = (\n  <T readOnly={!mode.isEditing} />\n);\n${uses}\n`;
  const repo = (text) => ({ head: () => text });
  const touched = (text, lines) => [{ path: "a.tsx", status: "M", added: lines.map((line) => ({ line, text: text.split("\n")[line - 1] })), removed: [] }];
  const guarded = head("const a = { bar: mode.isEditing ? controls : null };");
  assert.equal(collect((add) => checkGuardedConstants(touched(guarded, [4]), repo(guarded), add)).length, 1);
  const andGuard = head("return mode.isEditing && controls;");
  assert.equal(collect((add) => checkGuardedConstants(touched(andGuard, [4]), repo(andGuard), add)).length, 1);
  const mixed = head("const a = mode.isEditing ? controls : null;\nconst b = { left: controls };");
  assert.deepEqual(collect((add) => checkGuardedConstants(touched(mixed, [4]), repo(mixed), add)), [], "an unguarded use keeps the expression live");
  assert.deepEqual(collect((add) => checkGuardedConstants(touched(guarded, []), repo(guarded), add)), [], "an untouched pre-existing shape is not this diff's");
  const other = head("const a = session.ready ? controls : null;");
  assert.deepEqual(collect((add) => checkGuardedConstants(touched(other, [4]), repo(other), add)), []);
});

test("citation and removed-name candidates find the PR #9732 DI-13 lines and leftover names", () => {
  const leadDiff = files([
    `diff --git a/${LEAD} b/${LEAD}`, `--- a/${LEAD}`, `+++ b/${LEAD}`, "@@ -4 +4 @@",
    "- * Edit bar under the fields, as in the DI-13 design.",
    "+ * Edit bar under the fields, as in the issue detail design (ISS-13897).", "",
  ].join("\n"));
  const citations = collect((add) => checkStaleCitations(leadDiff, { head: () => LEAD_HEAD, rules: RULES }, add));
  assert.deepEqual(citations.map(({ rule, line }) => [rule, line]), [["stale-citation", 1]]);
  assert.match(citations[0].problem, /replaced the citation DI-13 in one comment, but line 1 still cites it/);
  const kept = LEAD_HEAD.replace("issue detail design (ISS-13897)", "DI-13 design (ISS-13897)");
  assert.deepEqual(collect((add) => checkStaleCitations(leadDiff.map((file) => ({ ...file, added: [{ line: 4, text: " * Edit bar, as in the DI-13 design (ISS-13897)." }] })), { head: () => kept, rules: RULES }, add)), []);

  const removedDiff = files([`diff --git a/${CANVAS} b/${CANVAS}`, `--- a/${CANVAS}`, `+++ b/${CANVAS}`, "@@ -7,4 +7,3 @@",
    "-  const editRow =", "+  const toolbarParts = {", ""].join("\n"));
  const stale = "// Builds the editRow for the lead.\nconst toolbarParts = {};\n";
  assert.deepEqual(collect((add) => checkRemovedNameComments(removedDiff, { head: () => stale }, add)).map(({ rule, line }) => [rule, line]), [["removed-name-comment", 1]]);
  assert.deepEqual(collect((add) => checkRemovedNameComments(removedDiff, { head: () => "// Builds the toolbar parts.\nconst toolbarParts = {};\n" }, add)), []);
});

test("ISS-14137 comment claims are checked against all current readers", () => {
  const source = "/** Read at ONE site. */\nexport const FLAG_KEY = 'flag';\n";
  const changed = files("diff --git a/key.ts b/key.ts\n--- a/key.ts\n+++ b/key.ts\n@@ -0,0 +1,2 @@\n+/** Read at ONE site. */\n+export const FLAG_KEY = 'flag';\n");
  const found = collect((add) => checkCommentClaims(changed, { head: () => source,
    wordFiles: () => ["key.ts", "a.ts", "b.ts", "c.ts"] }, add));
  assert.equal(found[0].rule, "claim-vs-readers");
  assert.match(found[0].problem, /3 reader files.*a\.ts, b\.ts, c\.ts/);
});

test("ISS-14137 session pointers and agent product decisions are blocking in test comments too", () => {
  const changed = files("diff --git a/x.test.ts b/x.test.ts\n--- a/x.test.ts\n+++ b/x.test.ts\n@@ -0,0 +1,3 @@\n+// rulings.md 578\n+// DT-CUSTOM-7\n+// orchestrator decision: Remove project goes first\n");
  const repo = { sessionIds: ["DT-CUSTOM-7"], rules: RULES };
  const pointers = collect((add) => checkSessionPointers(changed, repo, add));
  assert.deepEqual(pointers.map((entry) => entry.rule), ["session-internal-pointer", "session-internal-pointer"]);
  assert.equal(collect((add) => checkAgentDecisionCitations(changed, repo, add))[0].rule, "agent-decision-citation");
  const cited = files("diff --git a/x.test.ts b/x.test.ts\n--- a/x.test.ts\n+++ b/x.test.ts\n@@ -0,0 +1 @@\n+// ISS-13590: Remove project goes first\n");
  assert.deepEqual(collect((add) => checkAgentDecisionCitations(cited, repo, add)), []);
});

test("ISS-14137 a comment that only mentions a session or lane is not an agent decision citation", () => {
  const repo = { sessionIds: [], rules: RULES };
  const mentions = files("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,3 @@\n+// One captured session serves every case; the admission case runs last.\n+// The binding is read once, on the first key a lane asks for.\n+export {};\n");
  assert.deepEqual(collect((add) => checkAgentDecisionCitations(mentions, repo, add)), []);
  const citing = files("diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -0,0 +1,2 @@\n+// Ruled by the agent: archived rows show last.\n+export {};\n");
  assert.equal(collect((add) => checkAgentDecisionCitations(citing, repo, add))[0].rule, "agent-decision-citation");
  // Every layout raised in review: a citation names an agent, lane or session as the decider; a mention, a role list or
  // a tuple does not, whatever ordering word sits beside it.
  const cases = [
    ["// Orchestrator decisions: archived rows show last.", true],
    ["// Archived rows show last (orchestrator, 2026-11-17).", true],
    ["// Archived rows show last (agent; decided).", true],
    ["// Archived rows show last (orchestrator: ruling).", true],
    ["// Archived rows show last (writer, chose).", true],
    ["// Rows show last (session expired).", false],
    ["// Copy the token (session storage) first.", false],
    ["// Show the badge (agent header) last.", false],
    ["// Idle helper panes hide first when a helper (reviewer, verifier, QA prep, poller) stops.", false],
    ["// Sort by (session, index), newest first.", false],
    ["// Group findings by (session, rule) first.", false],
    ["// Sort by (reviewer, rule id), oldest first.", false],
    ["// Show rows last (orchestrator 2026-11-18).", false],
    ["// Show one row per session, newest first.", false],
    ["// Show the decision table rows first.", false],
    ["// Show rows first, per the decision table.", true],
  ];
  for (const [comment, cited] of cases) {
    const diff = files(`diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n@@ -0,0 +1,2 @@\n+${comment}\n+export {};\n`);
    assert.equal(collect((add) => checkAgentDecisionCitations(diff, repo, add)).length, cited ? 1 : 0, comment);
  }
  // A citation wrapped across comment lines is still one sentence.
  for (const [lines, cited] of [
    [["// Archived rows show last (orchestrator,", "// 2026-11-17)."], true],
    [["// Archived rows show last, as decided by the", "// orchestrator."], true],
    [["// Archived rows show last.", "// Sorted by (session, index)."], false],
  ]) {
    const diff = files(`diff --git a/w.ts b/w.ts\n--- a/w.ts\n+++ b/w.ts\n@@ -0,0 +1,3 @@\n${lines.map((line) => `+${line}`).join("\n")}\n+export {};\n`);
    assert.equal(collect((add) => checkAgentDecisionCitations(diff, repo, add)).length, cited ? 1 : 0, lines.join(" "));
  }
});

test("ISS-14137 diff-rules derives private row ids from the session evidence", (t) => {
  const result = run(t, { head: { "x.test.ts": "// DT-CUSTOM-7 is the reason\nexport {};\n" },
    changeLog: "Affected rows: DT-CUSTOM-7\n" });
  assert.ok(result.blocking.some((finding) => finding.rule === "session-internal-pointer" && finding.problem.includes("DT-CUSTOM-7")));
});

test("the command prints blocking findings and reviewer candidates for a worktree diff", (t) => {
  const result = run(t, { base: { [LEAD]: LEAD_BASE }, head: { [LEAD]: LEAD_HEAD, [STORY]: STORY_HEAD }, commit: true });
  const { home, cleanup } = makeHome("vibe-comment-rules-");
  t.after(cleanup);
  const printed = spawnSync(process.execPath, [SCRIPT, "--worktree", result.checkout, "--base", result.baseSha],
    { encoding: "utf8", env: { ...process.env, HOME: home, ...bindProvider(home) } });
  assert.equal(printed.status, 0, printed.stderr);
  const output = JSON.parse(printed.stdout);
  assert.deepEqual(output.blocking.map(({ rule, file }) => [rule, file]), [["excuse-comment", STORY]]);
  assert.deepEqual(output.candidates.map(({ rule, file, line }) => [rule, file, line]), [["stale-citation", LEAD, 1]]);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
});

// A large changed file: 100 definitions, each read 400 times, then one guarded constant and one near miss at the
// end, where the diff touches. Each definition looks up the line of every use, so a per-lookup split of the
// file's whole prefix takes many seconds here, while one line index per file finishes well inside the bound.
function largeGuardedFile() {
  const lines = [];
  for (let i = 0; i < 100; i += 1) lines.push(`const value${i} = compute(${i});`);
  for (let j = 0; j < 400; j += 1) for (let i = 0; i < 100; i += 1) lines.push(`use(value${i}, ${j});`);
  const guardedAt = lines.length + 2;
  lines.push("const controls = (", "  <T readOnly={!mode.isEditing} />", ");", "const a = { bar: mode.isEditing ? controls : null };");
  lines.push("const near = (", "  <T readOnly={!mode.isEditing} />", ");", "const b = { bar: session.ready ? near : null };", "");
  return { text: lines.join("\n"), lines, guardedAt, touched: [lines.length - 5, lines.length - 1] };
}

// A changed file with many definitions, as a bundled script has: 60,000 definitions read once each, then the
// same guarded constant and near miss. A search of the whole file per definition needs several times the case
// timeout here, while one pass over the file's identifiers stays far inside it.
function manyDefinitionsFile() {
  const lines = [];
  for (let i = 0; i < 60_000; i += 1) lines.push(`const value${i} = compute(${i});`, `use(value${i});`);
  const guardedAt = lines.length + 2;
  lines.push("const controls = (", "  <T readOnly={!mode.isEditing} />", ");", "const a = { bar: mode.isEditing ? controls : null };");
  lines.push("const near = (", "  <T readOnly={!mode.isEditing} />", ");", "const b = { bar: session.ready ? near : null };", "");
  return { text: lines.join("\n"), lines, guardedAt, touched: [lines.length - 5, lines.length - 1] };
}

// The check runs in a worker so the case timeout can end a run that never yields.
function guardedConstantsInWorker(t, text, files) {
  const source = `import { parentPort, workerData } from "node:worker_threads";
const { checkGuardedConstants } = await import(workerData.module);
const found = [];
checkGuardedConstants(workerData.files, { head: () => workerData.text }, (rule, file, line, problem) => found.push({ rule, file, line, problem }));
parentPort.postMessage(found);`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    { workerData: { module: new URL("./comment-rules.mjs", import.meta.url).href, text, files } });
  worker.unref();
  t.after(() => worker.terminate());
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test("ISS-14325 a large changed file with many definitions and uses finishes inside the case timeout with the same findings", { timeout: 5_000 }, async (t) => {
  const { text, lines, guardedAt, touched } = largeGuardedFile();
  const changed = [{ path: "big.tsx", status: "M", added: touched.map((line) => ({ line, text: lines[line - 1] })), removed: [] }];
  const found = await guardedConstantsInWorker(t, text, changed);
  assert.deepEqual(found.map(({ rule, file, line }) => [rule, file, line]), [["guarded-constant", "big.tsx", guardedAt]]);
  assert.match(found[0].problem, /`controls` is used only where `mode.isEditing` is true/);
  assert.ok(!found.some(({ problem }) => problem.includes("`near`")), "the near miss, guarded by another condition, reports nothing");
});

test("ISS-14325 a changed file with many definitions finishes inside the case timeout with the same findings", { timeout: 5_000 }, async (t) => {
  const { text, lines, guardedAt, touched } = manyDefinitionsFile();
  const changed = [{ path: "bundle.mjs", status: "M", added: touched.map((line) => ({ line, text: lines[line - 1] })), removed: [] }];
  const found = await guardedConstantsInWorker(t, text, changed);
  assert.deepEqual(found.map(({ rule, file, line }) => [rule, file, line]), [["guarded-constant", "bundle.mjs", guardedAt]]);
  assert.ok(!found.some(({ problem }) => problem.includes("`near`")), "the near miss, guarded by another condition, reports nothing");
});
