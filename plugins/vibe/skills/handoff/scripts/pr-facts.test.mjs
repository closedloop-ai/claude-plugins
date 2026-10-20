import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evidenceProblems, pullRequestFacts, requiredLanes, STACKED_BASE_STATEMENT } from "./pr-facts.mjs";
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
});

test("evidence: lanes follow the diff, and unfinished, missing or stale runs block", () => {
  const changed = ["packages/app/list.tsx", "packages/app/list.stories.tsx"];
  assert.deepEqual(requiredLanes([ROUTE]), []);
  assert.deepEqual(requiredLanes(changed, ["card select"]), ["web-host", "desktop-host", "webkit-iphone", "chromium-pixel", "storybook-plays"]);
  const commit = "a".repeat(40);
  const runs = requiredLanes(changed, ["card select"]).map((lane) => ({ lane, status: "passed", command: "run", commit, outcome: "selected" }));
  const file = { touchFlows: ["card select"], runs };
  assert.deepEqual(evidenceProblems(file, changed, commit), []);
  assert.match(evidenceProblems({ ...file, runs: runs.map((run, i) => (i === 2 ? { ...run, status: "running" } : run)) }, changed, commit).join(), /webkit-iphone: running/);
  assert.match(evidenceProblems({ ...file, runs: runs.slice(1) }, changed, commit).join(), /web-host: no run recorded/);
  assert.match(evidenceProblems(file, changed, "b".repeat(40)).join(), /not the published commit/);
  assert.match(evidenceProblems({ runs }, changed, commit).join(), /touchFlows/);
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
    "--body", s.file("body.md", body), "--runs", s.file("runs.json", { touchFlows: [], touchFlowsReason: "server only", runs: [] }),
    "--commit", "a".repeat(40)], s.home);
  const failing = run("Summary only.");
  assert.equal(failing.status, 1);
  assert.equal(failing.json.blocking.prBody, false);
  const passing = run(COMPLETE_BODY);
  assert.equal(passing.json.blocking.prBody, true, JSON.stringify(passing.json.prBodyProblems));
  assert.equal(passing.json.blocking.prEvidence, true);
  assert.match(runNode(INVENTORY, ["--worktree", s.wt, "--phase", "handoff", "--body", ticket], s.home).json.error, /--phase pull-request/);
});
