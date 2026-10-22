import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ticketWriteProblems } from "./ticket-write-check.mjs";
import { makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "ticket-write-check.mjs");
const TODAY = "2026-10-21";
const PULL = "https://github.com/acme/app/pull/42";

test("a follow-up goes in the current sprint and never under an executed or obsolete parent", () => {
  assert.deepEqual(ticketWriteProblems({ projectName: "10/19-10/23", parents: [{ slug: "ISS-1", status: "IN_PROGRESS" }], today: TODAY }), []);
  assert.match(ticketWriteProblems({ projectName: "9/21-9/25", today: TODAY }).join(), /ended 2026-09-25/);
  assert.match(ticketWriteProblems({ projectName: "12/28-1/1", today: "2027-01-05" }).join(), /ended 2027-01-01/);
  assert.deepEqual(ticketWriteProblems({ projectName: "12/28-1/1", today: "2026-12-30" }), []);
  assert.match(ticketWriteProblems({ projectName: "Enterprise", today: TODAY }).join(), /no date range/);
  assert.deepEqual(ticketWriteProblems({ projectName: "Enterprise", projectEnd: "2026-10-23", today: TODAY }), []);
  for (const status of ["EXECUTED", "OBSOLETE", "DONE", "CANCELED"]) {
    assert.match(ticketWriteProblems({ parents: [{ slug: "PRD-721", status }], today: TODAY }).join(), new RegExp(`PRD-721 is ${status}`));
  }
});

test("IN_REVIEW needs the delivering pull request", () => {
  assert.match(ticketWriteProblems({ status: "IN_REVIEW", today: TODAY }).join(), /needs the pull request/);
  assert.deepEqual(ticketWriteProblems({ status: "IN_REVIEW", pullRequest: PULL, today: TODAY }), []);
  assert.deepEqual(ticketWriteProblems({ status: "DONE", today: TODAY }), []);
});

test("the CLI exits 1 on a refused write", (t) => {
  const home = makeHome("vibe-ticket-write-");
  t.after(home.cleanup);
  const refused = runNode(SCRIPT, ["--project-name", "9/21-9/25", "--parent", "PRD-721:executed", "--today", TODAY], home.home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.problems.length, 2);
  assert.equal(runNode(SCRIPT, ["--project-name", "10/19-10/23", "--status", "in_review", "--pull-request", PULL, "--today", TODAY], home.home).status, 0);
});
