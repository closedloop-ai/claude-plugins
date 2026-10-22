import assert from "node:assert/strict";
import test from "node:test";
import { auditProblems, matrixProblems, ticketCriteria } from "./criteria-audit.mjs";

const TICKET = `## Scope and acceptance criteria

- Scope: drag rows between groups
- Acceptance criteria:
  - [ ] A row can be dragged with the pointer
  - [x] A row too deep to move is refused silently

## Environment
- [ ] not a criterion
`;
const HEAD = "0123456789abcdef0123456789abcdef01234567";

test("criteria are the ticket's acceptance checklist, numbered in order", () => {
  assert.deepEqual(ticketCriteria(TICKET), [
    { id: "AC-1", text: "A row can be dragged with the pointer" },
    { id: "AC-2", text: "A row too deep to move is refused silently" },
  ]);
});

test("the audit must cover every criterion as MET on the current head", () => {
  const criteria = ticketCriteria(TICKET);
  const audit = (head, verdict2) => `Head: ${head}\n| Criterion | Verdict | Evidence |\n|---|---|---|\n| AC-1 | MET | spec drag.spec.ts |\n${verdict2 ? `| AC-2 | ${verdict2} | shows a toast |\n` : ""}`;
  assert.deepEqual(auditProblems(audit(HEAD.slice(0, 10), "MET"), criteria, HEAD), []);
  assert.deepEqual(auditProblems(audit(HEAD, "PARTIAL"), criteria, HEAD), ["AC-2: PARTIAL (shows a toast)"]);
  assert.deepEqual(auditProblems(audit(HEAD, null), criteria, HEAD), ["AC-2: not audited"]);
  assert.match(auditProblems(audit("fedcba9876", "MET"), criteria, HEAD)[0], /rerun it on the final head/);
});

test("every criterion x surface x input x flag cell needs evidence, and flag-off cells need parity proof or a ruling", () => {
  const criteria = ticketCriteria(TICKET).slice(0, 1);
  const base = { surfaces: ["web", "desktop"], inputs: ["pointer", "keyboard"], flags: ["on", "off"] };
  const rows = [];
  for (const surface of base.surfaces) {
    for (const input of base.inputs) {
      rows.push({ criterion: "AC-1", surface, input, flag: "on", evidence: `${surface} ${input} spec` });
    }
    rows.push({ criterion: "AC-1", surface, input: "*", flag: "off", evidence: "not input-driven: the surface is unchanged with the flag off" });
  }
  assert.deepEqual(matrixProblems({ ...base, rows }, criteria), []);
  const desktopPointerMissing = rows.filter((row) => !(row.surface === "desktop" && row.input === "pointer" && row.flag === "on"));
  assert.deepEqual(matrixProblems({ ...base, rows: desktopPointerMissing }, criteria), ["AC-1 x desktop x pointer x flag on: no test or QA evidence"]);
  const offAsserted = rows.map((row) => (row.flag === "off" && row.surface === "web" ? { ...row, input: "pointer", evidence: "looks the same" } : row));
  assert.ok(matrixProblems({ ...base, rows: offAsserted }, criteria).includes('AC-1 x web x pointer x flag off: flag-off evidence must start "no behavior change:" (a diff against the base) or "ruling:"'));
  assert.match(matrixProblems({ ...base, flags: ["on"], rows }, criteria)[0], /no "off"/);
  assert.match(matrixProblems({ surfaces: [], inputs: ["pointer"], rows }, criteria)[0], /no surfaces or no input modes/);
  const anyInputWithoutReason = [{ criterion: "AC-1", surface: "web", input: "*", evidence: "covered" }];
  assert.equal(matrixProblems({ surfaces: ["web"], inputs: ["pointer"], rows: anyInputWithoutReason }, criteria).length, 1, "* needs a not input-driven reason");
});
