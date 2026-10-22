import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childProblems, executedProblems, ticketProblems } from "./executed-check.mjs";
import { makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "executed-check.mjs");
const MERGED = "2026-10-21T12:00:00Z";
const SECTION = [
  "# PRD: Board",
  "",
  "## Production visual QA",
  "- `board-v2`: Projects > Board; on for the team, off for everyone else",
  "- Checked: 2026-10-21T13:00:00Z",
  "",
  "## Problem",
  "Text.",
].join("\n");

test("EXECUTED needs the flag section first, a flag row or No flags, and a check after the last merge", () => {
  assert.deepEqual(executedProblems(SECTION, MERGED), []);
  assert.deepEqual(executedProblems(SECTION.replace(/- `board-v2`.*\n/, "No flags: server-only change\n"), MERGED), []);
  assert.match(executedProblems("# PRD\n\n## Problem\nText.\n", MERGED).join(), /first section is not "## Production visual QA"/);
  assert.match(executedProblems(SECTION.replace("## Production visual QA", "## Notes\n\n## Production visual QA"), MERGED).join(), /first section/);
  assert.match(executedProblems(SECTION.replace(/- `board-v2`.*\n/, "Flags were checked.\n"), MERGED).join(), /lists no flag/);
  assert.match(executedProblems(SECTION.replace(/- Checked:.*\n/, ""), MERGED).join(), /no "Checked/);
  assert.match(executedProblems(SECTION, "2026-10-21T14:00:00Z").join(), /before the last merge/);
});

test("the CLI exits 1 on a document missing the section", (t) => {
  const home = makeHome("vibe-executed-check-");
  t.after(home.cleanup);
  const good = path.join(home.root, "good.md");
  const bad = path.join(home.root, "bad.md");
  writeFileSync(good, SECTION);
  writeFileSync(bad, "# PRD\n\n## Problem\n");
  assert.equal(runNode(SCRIPT, ["--kind", "plan", "--file", good, "--last-merge", MERGED], home.home).status, 0);
  const refused = runNode(SCRIPT, ["--kind", "plan", "--file", bad, "--last-merge", MERGED], home.home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.ok, false);
});

test("a PRD is executed only when every PRODUCES child is DONE or CANCELED", (t) => {
  assert.deepEqual(childProblems([{ slug: "A-1", status: "DONE" }, { slug: "A-2", status: "CANCELED" }]), []);
  assert.deepEqual(childProblems([{ slug: "A-1", status: "DONE" }, { slug: "A-3", status: "IN_REVIEW" }, { slug: "A-4", status: "BACKLOG" }]), [
    "child A-3 is IN_REVIEW; a PRD is executed only when every PRODUCES child is DONE or CANCELED",
    "child A-4 is BACKLOG; a PRD is executed only when every PRODUCES child is DONE or CANCELED",
  ]);
  const home = makeHome("vibe-executed-check-");
  t.after(home.cleanup);
  const prd = path.join(home.root, "prd.md");
  const open = path.join(home.root, "open.json");
  const done = path.join(home.root, "done.json");
  writeFileSync(prd, SECTION);
  writeFileSync(open, JSON.stringify([{ slug: "A-1", status: "DONE" }, { slug: "A-3", status: "IN_PROGRESS" }]));
  writeFileSync(done, JSON.stringify([{ slug: "A-1", status: "DONE" }]));
  const args = ["--kind", "prd", "--file", prd, "--last-merge", MERGED];
  assert.match(runNode(SCRIPT, args, home.home).json.error, /--kind prd needs --children/);
  assert.match(runNode(SCRIPT, ["--file", prd, "--last-merge", MERGED], home.home).json.error, /--kind plan, --kind prd or --kind ticket is required/);
  const refused = runNode(SCRIPT, [...args, "--children", open], home.home);
  assert.equal(refused.status, 1);
  assert.deepEqual(refused.json.problems, ["child A-3 is IN_PROGRESS; a PRD is executed only when every PRODUCES child is DONE or CANCELED"]);
  assert.equal(runNode(SCRIPT, [...args, "--children", done], home.home).status, 0);
});

const TICKET = [
  "## Scope and acceptance criteria",
  "",
  "- Scope: board rows",
  "- Acceptance criteria:",
  "  - [x] Rows reorder by drag",
  "  - [ ] Moves beyond four levels are refused",
  "  - [ ] Keyboard reorder; Follow-up: ISS-12001",
  "  - [ ] Touch reorder; Excluded: Pat Example, 2026-10-21, ISS-12001 comment",
  "",
  "## Environment",
].join("\n");

test("a ticket is DONE only when every acceptance criterion is checked, followed up or excluded by a human (bulk DONE sweep)", (t) => {
  assert.deepEqual(ticketProblems(TICKET), [
    "AC-2 is unchecked: \"Moves beyond four levels are refused\"; check it against the merged code, or name `Follow-up: <slug>` or `Excluded: <human name or operator ruling>, <YYYY-MM-DD>` on it",
  ]);
  assert.deepEqual(ticketProblems(TICKET.replace("- [ ] Moves", "- [x] Moves")), []);
  assert.match(ticketProblems(TICKET.replace("Excluded: Pat Example, 2026-10-21", "Excluded: the plan")).join(), /AC-4 is unchecked/, "a plan is not a human exclusion");
  assert.match(ticketProblems("# Bug\n\nIt breaks.\n").join(), /no acceptance criteria checkboxes/);
  const heading = "## Acceptance Criteria\n\n- [x] One\n- [ ] Two\n\n## Notes\n- [ ] not a criterion\n";
  assert.deepEqual(ticketProblems(heading).map((problem) => problem.slice(0, 16)), ["AC-2 is unchecke"]);
  const home = makeHome("vibe-executed-check-");
  t.after(home.cleanup);
  const file = path.join(home.root, "ticket.md");
  writeFileSync(file, TICKET);
  assert.match(runNode(SCRIPT, ["--kind", "ticket", "--file", file], home.home).json.error, /--kind ticket needs --slug/);
  const refused = runNode(SCRIPT, ["--kind", "ticket", "--file", file, "--slug", "ISS-12001"], home.home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.problems.length, 1);
  writeFileSync(file, TICKET.replace("- [ ] Moves", "- [x] Moves"));
  assert.equal(runNode(SCRIPT, ["--kind", "ticket", "--file", file, "--slug", "ISS-77", "--prd", "PRD-5"], home.home).status, 1, "the exclusion names neither this ticket nor its PRD");
  assert.equal(runNode(SCRIPT, ["--kind", "ticket", "--file", file, "--slug", "ISS-12001"], home.home).status, 0);
});

test("an exclusion closes a ticket only in a ruling that names the ticket or its PRD (PRD-729 rollout tickets)", () => {
  const body = "- Acceptance criteria:\n  - [ ] Roll out to cohorts with stop conditions; Excluded: Pat Example, 2026-10-21, ruling on the Desktop Labs toggle\n";
  assert.equal(ticketProblems(body, ["ISS-9538", "PRD-729"]).length, 1, "a ruling about another surface");
  assert.deepEqual(ticketProblems(body.replace("ruling on the Desktop Labs toggle", "ruling on PRD-729 rollout"), ["ISS-9538", "PRD-729"]), []);
});
