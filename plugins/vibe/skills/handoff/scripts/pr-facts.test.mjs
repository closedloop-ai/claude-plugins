import assert from "node:assert/strict";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertionChanges, checkEvidence, citeCheck, classifyLanes, computeOverlap, contractChanges,
  extractAsks, importedModules, LANE, parseDiff, readDiff, SERVER_ONLY_LINE, STACKED_BASE_STATEMENT,
} from "./pr-facts.mjs";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pr-facts.mjs");

const BASE_FILES = {
  "apps/api/app/links/route.ts": [
    "export async function POST() {",
    "  return Response.json({ ok: true });",
    "}",
    "",
  ].join("\n"),
  "packages/api/src/types/links.ts": "export type LinkKind = \"a\" | \"b\";\nexport const LINK_LIMIT = 10;\n",
  "packages/api/src/links.test.ts": [
    "import { expect, it } from \"vitest\";",
    "it(\"limits\", () => {",
    "  expect(limit()).toBe(10);",
    "  expect(kind()).toBe(\"a\");",
    "});",
    "",
  ].join("\n"),
  "packages/api/src/old.test.ts": "it(\"old\", () => { expect(1).toBe(1); });\n",
  "packages/api/src/service.ts": "// ISS-1: keep\nexport function run() {}\n",
  "packages/api/src/helper.ts": "export const helper = 1;\n",
};

function withSession(edit, fn) {
  const { root, home, cleanup } = makeHome("pr-facts-");
  try {
    const checkout = path.join(root, "wt");
    makeCheckout({ root, home, checkout, files: BASE_FILES });
    git(checkout, ["checkout", "--quiet", "-b", "vibe/links"], home);
    edit(checkout, (file, content) => {
      mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
      writeFileSync(path.join(checkout, file), content);
    });
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "-m", "session"], home);
    return fn({ checkout, home, root, base: git(checkout, ["merge-base", "HEAD", "origin/main"], home) });
  } finally {
    cleanup();
  }
}

function typicalEdit(checkout, write) {
  write("apps/api/app/links/route.ts", [
    "export async function POST() {",
    "  return Response.json({ error: \"managed\" }, { status: 409 });",
    "}",
    "",
  ].join("\n"));
  write("packages/api/src/types/links.ts", "export type LinkKind = \"a\" | \"b\" | \"c\";\n");
  write("packages/api/src/links.test.ts", [
    "import { expect, it } from \"vitest\";",
    "it(\"limits\", () => {",
    "  expect(limit()).toBe(20);",
    "});",
    "",
  ].join("\n"));
  unlinkSync(path.join(checkout, "packages/api/src/old.test.ts"));
  write("packages/api/src/service.ts", "import { helper } from \"./helper\";\nexport function run() { return helper; }\n");
}

test("parseDiff tracks added and removed line numbers per hunk", () => {
  const files = parseDiff([
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -2 +2,2 @@",
    "-old",
    "+new",
    "+more",
    "",
  ].join("\n"));
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].hunks[0].removed, [{ line: 2, text: "old" }]);
  assert.deepEqual(files[0].hunks[0].added, [{ line: 2, text: "new" }, { line: 3, text: "more" }]);
});

test("facts name the flipped and removed assertions, deleted test file, contracts and refusals", () => {
  withSession(typicalEdit, ({ checkout, base }) => {
    const files = readDiff(checkout, base);
    const assertions = assertionChanges(files);
    assert.deepEqual(assertions.map((change) => [change.kind, change.path]).sort(), [
      ["deleted-test-file", "packages/api/src/old.test.ts"],
      ["flipped", "packages/api/src/links.test.ts"],
      ["removed", "packages/api/src/links.test.ts"],
    ]);
    const flipped = assertions.find((change) => change.kind === "flipped");
    assert.equal(flipped.line, 3);
    assert.match(flipped.before, /toBe\(10\)/);
    assert.match(flipped.after, /toBe\(20\)/);
    const { contracts, refusals } = contractChanges(files);
    assert.deepEqual(contracts.map((contract) => [contract.kind, contract.name]).sort(), [
      ["changed", "LinkKind"],
      ["removed", "LINK_LIMIT"],
    ]);
    assert.deepEqual(refusals.map((refusal) => [refusal.path, refusal.line, refusal.status]), [
      ["apps/api/app/links/route.ts", 2, 409],
    ]);
  });
});

test("an unchanged export re-declared in the same hunk is not a contract change", () => {
  const files = parseDiff([
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@",
    "-export const A = 1;", "+export const A = 1;", "",
  ].join("\n"));
  assert.deepEqual(contractChanges(files).contracts, []);
});

test("overlap intersects open pull requests with changed files and imported modules, skipping our branch", () => {
  withSession(typicalEdit, ({ checkout }) => {
    const imported = importedModules(checkout, ["packages/api/src/service.ts"]);
    assert.deepEqual(imported, ["packages/api/src/helper.ts"]);
    const overlap = computeOverlap({
      changed: ["packages/api/src/service.ts", "apps/api/app/links/route.ts"],
      imported,
      ownBranch: "vibe/links",
      prs: [
        { number: 8938, title: "types", headRefName: "a", files: ["packages/api/src/helper.ts"] },
        { number: 8900, title: "shares", headRefName: "b", files: ["apps/api/app/links/route.ts", "x.ts"] },
        { number: 8999, title: "unrelated", headRefName: "c", files: ["y.ts"] },
        { number: 9000, title: "ours", headRefName: "vibe/links", files: ["apps/api/app/links/route.ts"] },
      ],
    });
    assert.deepEqual(overlap, [
      { number: 8900, title: "shares", sharedFiles: ["apps/api/app/links/route.ts"], importedFiles: [] },
      { number: 8938, title: "types", sharedFiles: [], importedFiles: ["packages/api/src/helper.ts"] },
    ]);
  });
});

test("cite-check refuses a citation to a line the diff did not change", () => {
  withSession(typicalEdit, ({ checkout, base }) => {
    const files = readDiff(checkout, base);
    const ok = citeCheck("Changed `apps/api/app/links/route.ts:2`.", { files });
    assert.deepEqual(ok, { ok: true, problems: [] });
    const wrongLine = citeCheck("Changed apps/api/app/links/route.ts:1.", { files });
    assert.equal(wrongLine.ok, false);
    assert.match(wrongLine.problems[0], /not a changed line/);
    const untouched = citeCheck("See packages/api/src/helper.ts:1.", { files });
    assert.match(untouched.problems[0], /does not change/);
  });
});

test("cite-check requires every overlap, assertion change, contract, refusal and ticket ask", () => {
  withSession(typicalEdit, ({ checkout, base }) => {
    const files = readDiff(checkout, base);
    const facts = {
      files,
      overlap: [{ number: 8900, title: "shares", sharedFiles: ["apps/api/app/links/route.ts"], importedFiles: [] }],
      assertions: assertionChanges(files),
      ...contractChanges(files),
      asks: extractAsks("Say why POST vs DELETE in the PR. Other text."),
    };
    const empty = citeCheck("Summary only.", facts);
    assert.equal(empty.ok, false);
    const joined = empty.problems.join("\n");
    for (const expected of ["#8900", "packages/api/src/links.test.ts:3", "packages/api/src/old.test.ts", "LinkKind", "LINK_LIMIT", "409", "POST vs DELETE"]) {
      assert.ok(joined.includes(expected), expected);
    }
    const complete = [
      "Overlaps #8900 in apps/api/app/links/route.ts:2 (409 refusal).",
      "Flipped packages/api/src/links.test.ts:3; removed assertion packages/api/src/links.test.ts:3.",
      "Deleted packages/api/src/old.test.ts.",
      "Changed LinkKind; removed LINK_LIMIT.",
      "Say why POST vs DELETE in the PR. POST, because the body carries the edge.",
    ].join("\n");
    assert.deepEqual(citeCheck(complete, facts), { ok: true, problems: [] });
  });
});

test("a stacked pull request must carry the stacked-base statement", () => {
  const files = [];
  assert.equal(citeCheck("Body.", { files, prBase: "vibe/dependency" }).ok, false);
  assert.equal(citeCheck(`Body. ${STACKED_BASE_STATEMENT}`, { files, prBase: "vibe/dependency" }).ok, true);
  assert.equal(citeCheck("Body.", { files, prBase: "main" }).ok, true);
});

test("asks extracts every say/state/decide instruction aimed at the pull request", () => {
  const asks = extractAsks("Fix it. State in the pull request whether undo changed.\nSay why POST vs DELETE in the PR. Say hello.");
  assert.deepEqual(asks, ["State in the pull request whether undo changed.", "Say why POST vs DELETE in the PR."]);
});

test("lanes: a server-only diff needs no UI, Storybook or Desktop evidence", () => {
  const lanes = classifyLanes(["apps/api/app/links/route.ts", "packages/api/src/types/links.ts"]);
  assert.deepEqual(lanes, { serverOnly: true, line: SERVER_ONLY_LINE, uiFiles: [], requiredLanes: [] });
});

test("lanes: shared app code needs both hosts, touch flows need both devices, stories need plays", () => {
  const lanes = classifyLanes(["packages/app/sessions/list.tsx", "packages/app/sessions/list.stories.tsx"], { touchFlows: ["card select"] });
  assert.equal(lanes.serverOnly, false);
  assert.deepEqual(lanes.requiredLanes, [LANE.webHost, LANE.desktopHost, LANE.webkitIphone, LANE.chromiumPixel, LANE.storybookPlays]);
});

test("evidence blocks pending, running and missing runs, and runs on another commit", () => {
  const changed = ["packages/app/sessions/list.tsx", "packages/app/sessions/list.stories.tsx"];
  const commit = "a".repeat(40);
  const passed = (lane) => ({ lane, status: "passed", command: `run ${lane}`, commit, outcome: "selected two cards" });
  const complete = {
    touchFlows: ["card select"],
    runs: [LANE.webHost, LANE.desktopHost, LANE.webkitIphone, LANE.chromiumPixel, LANE.storybookPlays].map(passed),
  };
  assert.equal(checkEvidence(complete, changed, commit).ok, true);
  const pending = { ...complete, runs: complete.runs.map((run) => (run.lane === LANE.webkitIphone ? { ...run, status: "running" } : run)) };
  assert.match(checkEvidence(pending, changed, commit).problems.join("\n"), /webkit-iphone: running/);
  const missing = { ...complete, runs: complete.runs.filter((run) => run.lane !== LANE.storybookPlays) };
  assert.match(checkEvidence(missing, changed, commit).problems.join("\n"), /storybook-plays: no run recorded/);
  const stale = { ...complete, runs: complete.runs.map((run) => ({ ...run, commit: "b".repeat(40) })) };
  assert.match(checkEvidence(stale, changed, commit).problems.join("\n"), /not the published commit/);
  assert.match(checkEvidence({ runs: complete.runs }, changed, commit).problems.join("\n"), /no touchFlows list/);
  assert.match(checkEvidence({ touchFlows: [], runs: complete.runs }, changed, commit).problems.join("\n"), /touchFlowsReason/);
});

test("the CLI check exits 1 on an incomplete body and 0 on a complete one", () => {
  withSession(typicalEdit, ({ checkout, home, root }) => {
    const prs = path.join(root, "prs.json");
    writeFileSync(prs, JSON.stringify([{ number: 8900, title: "shares", headRefName: "b", files: ["apps/api/app/links/route.ts"] }]));
    const body = path.join(root, "body.md");
    writeFileSync(body, "Summary only.\n");
    const failing = runNode(SCRIPT, ["check", "--worktree", checkout, "--prs-json", prs, "--body", body], home);
    assert.equal(failing.status, 1);
    assert.equal(failing.json.ok, false);
    assert.ok(failing.json.problems.some((problem) => problem.includes("#8900")));
    writeFileSync(body, [
      "Overlaps #8900 at apps/api/app/links/route.ts:2 (new 409).",
      "Flipped packages/api/src/links.test.ts:3 and removed packages/api/src/links.test.ts:3.",
      "Deleted packages/api/src/old.test.ts. Changed LinkKind, removed LINK_LIMIT.",
      "",
    ].join("\n"));
    const passing = runNode(SCRIPT, ["check", "--worktree", checkout, "--prs-json", prs, "--body", body], home);
    assert.equal(passing.status, 0, JSON.stringify(passing.json.problems));
    const planned = runNode(SCRIPT, ["overlap", "--worktree", checkout, "--prs-json", prs, "--files", "apps/api/app/links/route.ts"], home);
    assert.deepEqual(planned.json.overlap.map((pr) => pr.number), [8900]);
    const lanes = runNode(SCRIPT, ["lanes", "--worktree", checkout], home);
    assert.equal(lanes.json.serverOnly, true);
    rmSync(body);
  });
});

test("the CLI refuses an unknown subcommand", () => {
  const { home, cleanup } = makeHome("pr-facts-cli-");
  try {
    const result = runNode(SCRIPT, ["nonsense", "--worktree", "."], home);
    assert.equal(result.status, 1);
    assert.match(result.json.error, /Usage/);
  } finally {
    cleanup();
  }
});
