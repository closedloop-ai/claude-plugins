import assert from "node:assert/strict";
import test from "node:test";
import { run as diffRulesFixture } from "./diff-rules-test-fixture.mjs";
import { checkRetiredFlagDependencies, checkRetiredTestDeletions } from "./retirement-evidence.mjs";
import { checkSourceLineCeiling, sourceLineCount } from "./source-line-ceiling.mjs";
import { checkTouchLeadCoverage, surfaceFixProblems } from "./surface-fix-evidence.mjs";

const marker = (path, status = "M", added = []) => ({ path, status, oldPath: null, added, removed: [] });
function sourceRepo(before, current, options = {}) {
  return {
    headFiles: Object.keys(current), baseFiles: new Set(Object.keys(before)),
    head: (file) => current[file], base: (file) => before[file],
    baseBlobs: (files) => new Map(files.map((file) => [file, before[file]])), ...options,
  };
}
function findings(run) {
  const result = [];
  run((rule, file, line, reason) => result.push({ rule, file, line, reason }));
  return result;
}

test("ISS-14476 flags exact touched-file growth and permits grandfathered non-growth without exemptions", () => {
  const sizes = {
    "apps/desktop/src/renderer/App.tsx": [1118, 1121],
    "apps/storybook/stories/start-here-version-history.stories.tsx": [993, 1011],
    "documents-view-branch-coverage.test.tsx": [1037, 1043],
    "new-file.ts": [0, 1001],
    "shrinking.ts": [1381, 1379],
    "unchanged.ts": [1381, 1381],
    "exact-ceiling.ts": [1000, 1000],
  };
  const text = (count) => "export {};\n".repeat(count);
  const before = Object.fromEntries(Object.entries(sizes).filter(([, [prior]]) => prior > 0).map(([file, [prior]]) => [file, text(prior)]));
  const current = Object.fromEntries(Object.entries(sizes).map(([file, [, after]]) => [file, text(after)]));
  const result = findings((add) => checkSourceLineCeiling(Object.keys(sizes).map((file) => marker(file, before[file] ? "M" : "A")),
    sourceRepo(before, current), add));
  assert.deepEqual(result.map(({ file }) => file), Object.keys(sizes).slice(0, 4));
  assert.match(result[0].reason, /1118 to 1121/);
  assert.match(result[1].reason, /1011 lines.*base 993/);
  assert.match(result[2].reason, /1037 to 1043/);
  assert.match(result[3].reason, /1001 lines.*base 0/);
  assert.equal(sourceLineCount("one\ntwo"), 2);
});

test("ISS-14476 whole test retirement preserves live owner exclusion and retry assertions separately", () => {
  const removed = "src/custom-field-reference-search.old.test.tsx";
  const current = "src/custom-field-reference-search.test.tsx";
  const owner = "src/custom-field-reference-search.tsx";
  const source = "export function Search() { return null; }\n";
  const imports = 'import { expect, test } from "vitest";\nimport { Search } from "./custom-field-reference-search";\n';
  const both = imports + `
test("owner exclusion", () => { const rows = Search(); expect(rows).not.toContain(owner); });
test("retry after failure", () => { Search(); expect(retry).toHaveBeenCalled(); });
`;
  const map = [
    { case: "owner exclusion", index: 1, source: owner, replacement: { path: current, case: "owner exclusion" } },
    { case: "retry after failure", index: 1, source: owner, replacement: { path: current, case: "retry after failure" } },
  ];
  const before = { [removed]: both, [owner]: source };
  const whole = { path: removed, retiredBy: "ISS-7", covers: "original search wrapper" };
  const diff = [marker(removed, "D"), marker(current, "A")];
  const run = (head, assertions) => findings((add) => checkRetiredTestDeletions(diff,
    sourceRepo(before, head, { retiredTests: () => [{ ...whole, assertions }] }), add));
  assert.equal(run({ [owner]: source, [current]: both }, undefined).length, 2);
  assert.deepEqual(run({ [owner]: source, [current]: both }, map), []);
  const missing = run({ [owner]: source, [current]: both.replace("expect(retry).toHaveBeenCalled();", "") }, map);
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /retry after failure.*lacks/);
  assert.match(run({ [owner]: source, [current]: both }, map.map(({ replacement, ...row }) => row))[0].reason, /live deleted assertion/);
  assert.deepEqual(run({}, map.map(({ replacement, ...row }) => row)), []);
});

test("ISS-14476 flag retirement finds five dead card producers and a stale docs literal", () => {
  const owner = "src/product-grid-table-v2.tsx";
  const docs = "docs/branches-and-sessions-list-adapter-disposition-ledger.md";
  const before = { [owner]: 'const key = "gridview-adoption";\nif (flag(key)) return cardCompatibility?.make();\n' };
  const current = { [owner]: "if (cardCompatibility?.alwaysActive) return cardCompatibility.make();\n",
    [docs]: "gridview-adoption is still active for hosts.\n" };
  for (let index = 0; index < 5; index++) current[`src/host-${index}.tsx`] =
    'import { ProductGridTable } from "./product-grid-table-v2";\nconst card = { rows: [] };\nexport const View = <ProductGridTable cardCompatibility={card} />;\n';
  const run = (head) => findings((add) => checkRetiredFlagDependencies("gridview-adoption", [marker(owner)], sourceRepo(before, head), add));
  const red = run(current);
  assert.equal(red.filter(({ rule }) => rule === "flag-retirement-dead-host").length, 5);
  assert.equal(red.filter(({ rule }) => rule === "flag-retirement-docs").length, 1);
  const repaired = Object.fromEntries(Object.entries(current).map(([file, text]) => [file,
    text.replace("rows: []", "rows: [], alwaysActive: true").replace("is still active for hosts", "was retired")]));
  assert.deepEqual(run(repaired), []);
});

test("ISS-14476 verifies the real Issues footer chain and refuses both dead pagination paths", () => {
  const page = "src/issues-page.tsx";
  const live = "src/table-pagination-footer.tsx";
  const dead = "src/table-pagination-v2.tsx";
  const older = "src/old-pagination-attempt.tsx";
  const source = {
    [page]: 'import { TablePaginationFooter } from "./table-pagination-footer";\nexport function IssuesPage() { return <TablePaginationFooter />; }',
    [live]: "export function TablePaginationFooter() { return <footer />; }",
    [dead]: "export function Pagination() { return <footer />; }",
    [older]: "export function OlderPagination() { return <footer />; }",
  };
  const diff = [marker(live), marker(dead), marker(older)];
  const claim = (target) => `Fix surface: Issues: ${page} -> ${target}`;
  assert.deepEqual(surfaceFixProblems(claim(live), diff, sourceRepo({}, source)), []);
  for (const path of [dead, older]) assert.match(surfaceFixProblems(claim(path), diff, sourceRepo({}, source))[0].reason, /no verified render\/import path/);
  assert.equal(surfaceFixProblems(claim(live), diff, sourceRepo({}, { ...source, [page]: source[page].split("\n")[0] } )).length, 1);
});

test("ISS-14476 demands linked-lead early return or menu handling, click/navigation and neutral press/cancellation", () => {
  const handler = "src/use-grid-table-v2-touch-selection.ts";
  const spec = "src/use-grid-table-v2-touch-selection.test.tsx";
  const imports = 'import { test, expect } from "vitest";\nimport { useTouch } from "./use-grid-table-v2-touch-selection";\n';
  const neutral = `test("neutral opens menu", () => {
    const lead = <span>Issue</span>; useTouch(lead);
    fireEvent.pointerDown(lead, { pointerType: "touch" }); vi.advanceTimersByTime(550);
    expect(menu).toHaveBeenCalled();
  });`;
  const link = `test("interactive anchor preserves navigation", () => {
    const lead = <a href="/issues/1">Issue</a>; useTouch(lead);
    fireEvent.pointerDown(lead, { pointerType: "touch" }); vi.advanceTimersByTime(550);
    expect(menu).not.toHaveBeenCalled(); fireEvent.click(lead); expect(navigation).toHaveBeenCalled();
  });`;
  const cancel = `test("movement cancels touch press", () => {
    const lead = <span>Issue</span>; useTouch(lead);
    fireEvent.pointerDown(lead, { pointerType: "touch" }); fireEvent.pointerMove(lead); vi.advanceTimersByTime(550);
    expect(menu).not.toHaveBeenCalled();
  });`;
  const diff = [marker(handler, "M", [{ text: 'if (event.pointerType === "touch") {}' }])];
  const run = (cases) => {
    const required = [];
    const messages = findings((add) => checkTouchLeadCoverage(diff,
      sourceRepo({}, { [handler]: "export const useTouch = () => null;", [spec]: [imports, ...cases].join("\n") }), add, required));
    return { messages, required };
  };
  assert.match(run([neutral, cancel]).messages[0].reason, /anchor lead/);
  assert.match(run([link, neutral]).messages[0].reason, /movement\/cancel/);
  assert.match(run([link.replace("expect(navigation).toHaveBeenCalled();", ""), neutral, cancel]).messages[0].reason, /click\/navigation/);
  const green = run([neutral, link, cancel]);
  assert.deepEqual(green.messages, []);
  assert.deepEqual(green.required.map(({ path }) => path), [spec]);
});

test("ISS-14476 source inventory refuses direct private startup file access without inspecting the target", (t) => {
  const forbiddenPath = ["~", ["", "secrets", "env"].join(".")].join("/");
  const sh = "plugins/vibe/skills/fleet-orchestrator/scripts/unsafe.sh";
  const js = "plugins/vibe/lib/vibe/scripts/unsafe.mjs";
  const md = "plugins/vibe/skills/fleet-orchestrator/unsafe.md";
  const tooling = "tools/vibe-workers/src/unsafe.ts";
  const safe = "plugins/vibe/skills/fleet-orchestrator/scripts/ready.sh";
  const fixture = diffRulesFixture(t, { head: {
    [sh]: `#!/bin/sh\n. ${forbiddenPath}\ncat ${forbiddenPath}\n`,
    [js]: `const result = readFileSync("${forbiddenPath}");\n`,
    [md]: `Run the private setup: cat ${forbiddenPath}\n`,
    [tooling]: `const result = readFileSync("${forbiddenPath}");\n`,
    [safe]: "zsh -lic 'test -n \"$APP_RUNTIME_KEY\"'\n",
  } });
  assert.deepEqual(fixture.blocking.filter(({ rule }) => rule === "private-env-file").map(({ file, line }) => [file, line]).sort(),
    [[sh, 2], [sh, 3], [js, 1], [md, 1], [tooling, 1]].sort());
});
