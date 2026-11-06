import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gradeReply, normalizeCheckerText } from "./iss-13760-reply-format.mjs";

const checker = fileURLToPath(new URL("./iss-13760-reply-format.mjs", import.meta.url));
const checkersRoot = fileURLToPath(new URL("./", import.meta.url));
const graph = "\n\nGraph:\n- made_up_tool anything: Recommendation: keep every prior outcome";

const child = (claim, report = "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:ACTIVE_OTHER_OWNER",
  uncovered = "UNCOVERED: ISS-9003; ACTION:LEAVE_UNCOVERED",
  supersede = "SUPERSEDE: None") => `${claim}\n${report}\n${uncovered}\n${supersede}${graph}`;

test("ISS-13760 child checker separates claim and no-supersession semantics", () => {
  const complete = child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
    "LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: complete }).passed, true);
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "no-supersession", reply: complete }).passed, true);
  const incomplete = child("CLAIM: ISS-9001");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: incomplete }).passed, false);
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "no-supersession", reply: incomplete }).passed, false);
  for (const reply of [
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR but will not assign it"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003 and ISS-9002 are outside the request."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR but never claim it"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR; ship it"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002 is active and is reported here."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002 is active; ship it and exclude it."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003 is outside the request; implement it."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002 is active under another owner; exclude it from the build and report the overlap. Actually pending."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002 is active under another owner; exclude it from the build and report the overlap. It was superseded."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR, actually."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003 is outside the request and remains untouched; include it."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003 is outside the request and remains untouched; add it to scope."),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined, undefined,
    "SUPERSEDE: None. It was superseded."),
  ]) assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply }).passed, false, reply);
  for (const mutation of ["reassign it to operator-1", "assign it to the session operator",
    "move it to IN_PROGRESS", "set its status to DONE", "change its status to DONE",
    "claim ownership"]) {
    const reply = child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
      "LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR",
    `REPORT: ISS-9002 is active under another owner; exclude it from the build and report the overlap; ${mutation}.`);
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "claims-untouched", reply }).passed, false, mutation);
  }
  for (const omission of ["no comment will be added", "without a comment",
    "omit the comment", "skip comment", "comment not added"]) {
    const reply = child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
      `LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR; ${omission}`);
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "claims-untouched", reply }).passed, false, omission);
  }
  for (const mutation of ["ship it", "build it", "claim it", "cancel it",
    "supersede it", "implement it"]) {
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "claims-untouched", reply: child(
        "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
        "COMMENT:ISS-9000_COORDINATOR",
        `REPORT: ISS-9002 is active; ${mutation}; exclude it.`) }).passed, false, mutation);
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "claims-untouched", reply: child(
        "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
        "COMMENT:ISS-9000_COORDINATOR", undefined,
        `UNCOVERED: ISS-9003 is outside the request; ${mutation}.`) }).passed, false, mutation);
  }
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: complete }).passed, true,
  "Graph is outside the criterion-local child grader");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "no-supersession", reply: child("CLAIM: ISS-9001", undefined, undefined,
      "SUPERSEDE: ISS-9002 later") }).passed, false);
  for (const reply of ["SUPERSEDE: None", "SUPERSEDE: None.", "None", "None."]) {
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "no-supersession", reply }).passed, true, reply);
  }
  for (const apostrophe of ["'", "’"]) {
    for (const contracted of [`don${apostrophe}t`, `won${apostrophe}t`]) {
      for (const verb of ["assign", "link", "move", "claim", "build", "ship", "cancel",
        "supersede", "implement"]) {
        const reply = child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
          `LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR but ${contracted} ${verb} it`);
        assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
          graderName: "claims-untouched", reply }).passed, false, `${contracted} ${verb}`);
      }
    }
  }
  const safeProhibition = child(
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
    "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002 is active under another owner; exclude it from the build and report the overlap; don’t build, claim, cancel, or supersede it.");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: safeProhibition }).passed, true);
  const spacedMachineReply = child(
    "CLAIM: ISS-9001;ASSIGN: operator-1;STATUS: IN_PROGRESS;LINK: ISS-9000;" +
    "COMMENT:ISS-9000_COORDINATOR",
    "REPORT:ISS-9002;ACTION: EXCLUDE;REASON: ACTIVE_OTHER_OWNER",
    "UNCOVERED:ISS-9003;ACTION: LEAVE_UNCOVERED");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: spacedMachineReply }).passed, true);
  const punctuatedMachineReply = child(
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
    "COMMENT:ISS-9000_COORDINATOR.",
    "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:ACTIVE_OTHER_OWNER.",
    "UNCOVERED: ISS-9003; ACTION:LEAVE_UNCOVERED.", "SUPERSEDE: None.");
  assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: punctuatedMachineReply }).passed, true);
  for (const note of ["ISS-9000 coordinates this work",
    "ISS-9000 is the coordinator for ISS-9001"]) {
    const reply = child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
      `LINK: ISS-9000; COMMENT: ${note}`);
    assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "claims-untouched", reply }).passed, false, note);
  }
  for (const reply of [
    child("CLAIM: ISS-9002; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR"),
    child("CLAIM: ISS-9001; ASSIGN: operator-2; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: TODO; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9002; " +
      "COMMENT:ISS-9000_COORDINATOR"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT: coordinator note"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR; EXTRA:transfer"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", "REPORT: ISS-9002; ACTION:CLAIM; REASON:ACTIVE_OTHER_OWNER"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:PENDING"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:NONE"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR",
    "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:ACTIVE_OTHER_OWNER. EXTRA:PENDING"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003; ACTION:INCLUDE"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined,
    "UNCOVERED: ISS-9003; ACTION:LEAVE_UNCOVERED. EXTRA:PENDING"),
    child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; " +
      "COMMENT:ISS-9000_COORDINATOR", undefined, undefined, "SUPERSEDE: Cancel"),
  ]) assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply }).passed, false, reply);
  for (const mutation of ["ship it", "build it", "claim it", "cancel it",
    "supersede it", "implement it"]) {
    for (const reply of [
      child("CLAIM: ISS-9001", `REPORT: ISS-9002 is active; ${mutation}.`),
      child("CLAIM: ISS-9001", undefined, `UNCOVERED: ISS-9003 is outside; ${mutation}.`),
    ]) assert.equal(gradeReply({ caseId: "pm-prd-children-are-scope",
      graderName: "no-supersession", reply }).passed, false, mutation);
  }
});

test("ISS-13760 checker normalizes common modal contractions once", () => {
  assert.equal(normalizeCheckerText(
    "shouldn’t mustn’t couldn’t wouldn’t can’t won’t don’t doesn't didn't"),
  "should not must not could not would not can not will not do not does not did not");
});

test("ISS-13760 checker CLI returns one identity-bound JSON result", () => {
  const input = { caseId: "pm-prd-children-are-scope", graderName: "claims-untouched",
    reply: child("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
      "LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR") };
  const run = spawnSync(process.execPath, [checker], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), { caseId: input.caseId,
    graderName: input.graderName, passed: true,
    reason: "the untouched child is claimed completely" });
});

test("ISS-13760 checker manifest maps only supported regex-frontmatter graders", () => {
  const manifest = JSON.parse(readFileSync(join(checkersRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, { schemaVersion: 1, entries: [
    { caseId: "pm-prd-children-are-scope", graderName: "claims-untouched",
      checker: "iss-13760-reply-format.mjs" },
    { caseId: "pm-prd-children-are-scope", graderName: "no-supersession",
      checker: "iss-13760-reply-format.mjs" },
  ] });
  for (const entry of manifest.entries) {
    const grader = readFileSync(join(checkersRoot, "..", entry.caseId, "graders",
      `${entry.graderName}.md`), "utf8");
    assert.match(grader, /^---\ntype: regex\n/m);
    assert.doesNotMatch(grader, /^checker:/m);
  }
});

function replyFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...replyFiles(path));
    else if (entry.name === "reply.txt") files.push(path);
  }
  return files;
}

test("ISS-13760 private 33-reply corpus preserves mapped nightly oracles", {
  skip: !process.env.ISS_13760_REPLY_ROOT || !existsSync(process.env.ISS_13760_REPLY_ROOT),
}, () => {
  const files = replyFiles(process.env.ISS_13760_REPLY_ROOT);
  const childReplies = files.filter((path) => path.includes("product-manager-prd-children-are-scope"));
  assert.equal(childReplies.length, 9);
  assert.equal(childReplies.filter((path) => gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "claims-untouched", reply: readFileSync(path, "utf8") }).passed).length, 3);
  assert.equal(childReplies.filter((path) => gradeReply({ caseId: "pm-prd-children-are-scope",
    graderName: "no-supersession", reply: readFileSync(path, "utf8") }).passed).length, 9);
});
