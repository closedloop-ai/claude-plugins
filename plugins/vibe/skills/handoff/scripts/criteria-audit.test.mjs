import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditProblems, EvidenceAt, matrixProblems, ticketCriteria } from "./criteria-audit.mjs";

const SCRIPT = fileURLToPath(new URL("./criteria-audit.mjs", import.meta.url));

const TICKET = `## Scope and acceptance criteria

- Scope: drag rows between groups
- Acceptance criteria:
  - [ ] A row can be dragged with the pointer
  - [x] A row too deep to move is refused silently

## Environment
- [ ] not a criterion
`;
test("criteria are the ticket's acceptance checklist, numbered in order", () => {
  assert.deepEqual(ticketCriteria(TICKET), [
    { id: "AC-1", text: "A row can be dragged with the pointer" },
    { id: "AC-2", text: "A row too deep to move is refused silently" },
  ]);
});

test("the audit must cover every criterion as MET without commit identity", () => {
  const criteria = ticketCriteria(TICKET);
  const audit = (verdict2) => `| Criterion | Verdict | Type | Ref |\n|---|---|---|---|\n| AC-1 | MET | script | pnpm test:lanes |\n${verdict2 ? `| AC-2 | ${verdict2} | screenshot | shows a toast |\n` : ""}`;
  assert.deepEqual(auditProblems(audit("MET"), criteria), []);
  assert.deepEqual(auditProblems(audit("PARTIAL"), criteria), ["AC-2: PARTIAL (shows a toast)"]);
  assert.deepEqual(auditProblems(audit(null), criteria), ["AC-2: not audited"]);
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

test("every criterion needs a MET audit row of a known type with a ref; anything else blocks done", () => {
  const criteria = ticketCriteria(TICKET);
  const row = (id, verdict, type, ref) => `| ${id} | ${verdict} | ${type} | ${ref} |\n`;
  const met = (id, type, ref) => row(id, "MET", type, ref);
  assert.deepEqual(auditProblems(met("AC-1", "script", "pnpm test:lanes") + met("AC-2", "screenshot", "capture-2.png"), criteria), []);
  assert.deepEqual(auditProblems(met("AC-1", "source-trace", "apps/app/a.tsx:12") + met("AC-2", "source-trace", ""), criteria), ["AC-2: MET needs a ref naming the source-trace"]);
  assert.deepEqual(auditProblems(met("AC-1", "api-read", "GET /x"), criteria), ["AC-2: not audited"]);
  assert.deepEqual(auditProblems(met("AC-1", "script", "run") + row("AC-2", "PARTIAL", "screenshot", "shot.png"), criteria), ["AC-2: PARTIAL (shot.png)"]);
  assert.deepEqual(auditProblems(met("AC-1", "script", "run") + row("AC-2", "MISSED", "screenshot", ""), criteria), ["AC-2: MISSED"]);
  assert.deepEqual(auditProblems(met("AC-1", "script", "") + met("AC-2", "script", "run"), criteria), ["AC-1: MET needs a ref naming the script"]);
  assert.match(auditProblems(met("AC-1", "vibes", "x") + met("AC-2", "script", "run"), criteria)[0], /evidence type must be one of test, script, screenshot, api-read/);
  assert.deepEqual(auditProblems(met("AC-1", "script", "run") + met("AC-2", "script", "run") + met("AC-9", "script", "run"), criteria), ["AC-9: audit row for a criterion the ticket does not list"]);
  assert.deepEqual(auditProblems(row("AC-1", "VERDICT", "test", "REF") + met("AC-2", "script", "run"), criteria), ["AC-1: not audited"], "the unfilled skeleton row is not an audit");
  assert.deepEqual(auditProblems("", criteria).length, 2);
});

test("a test ref must name a file that exists: in the worktree at a candidate audit, at HEAD at the gate", () => {
  const criteria = ticketCriteria(TICKET).slice(0, 1);
  const dir = mkdtempSync(path.join(tmpdir(), "criteria-evidence-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(dir, "drag.spec.ts"), "");
    git("add", "drag.spec.ts");
    git("commit", "-qm", "test");
    writeFileSync(path.join(dir, "untracked.spec.ts"), "");
    const rows = (ref) => `| AC-1 | MET | test | ${ref} |\n`;
    assert.deepEqual(auditProblems(rows("drag.spec.ts::drags a row"), criteria, dir, EvidenceAt.Head), []);
    assert.deepEqual(auditProblems(rows("untracked.spec.ts"), criteria, dir, EvidenceAt.Head), ["AC-1: the test untracked.spec.ts does not exist at HEAD; a planned test is not evidence"]);
    assert.deepEqual(auditProblems(rows("missing.spec.ts"), criteria, dir, EvidenceAt.Head), ["AC-1: the test missing.spec.ts does not exist at HEAD; a planned test is not evidence"]);
    // The candidate audit runs before the first commit, so an uncommitted test the writer just wrote is real evidence.
    assert.deepEqual(auditProblems(rows("untracked.spec.ts"), criteria, dir), []);
    assert.deepEqual(auditProblems(rows("missing.spec.ts"), criteria, dir), ["AC-1: the test missing.spec.ts does not exist in the worktree; a planned test is not evidence"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fleet unit's member tickets are audited with the session's ticket, as <slug>:AC-n (ISS-13924)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "criteria-members-"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    const gitDir = execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ memberTickets: ["ISS-124"] }));
    const ticket = path.join(dir, "ticket.md");
    const member = path.join(dir, "member.md");
    const audit = path.join(dir, "audit.md");
    const matrix = path.join(dir, "matrix.json");
    writeFileSync(ticket, TICKET);
    writeFileSync(member, "- Acceptance criteria:\n  - [ ] The group header shows its count\n");
    const met = (id) => `| ${id} | MET | script | pnpm test |\n`;
    const cells = (ids) => JSON.stringify({ surfaces: ["web"], inputs: ["*"], flags: [], rows: ids.map((criterion) => ({ criterion, surface: "web", input: "*", evidence: "not input-driven: unit test" })) });
    const run = (...extra) => {
      try {
        return { status: 0, json: JSON.parse(execFileSync(process.execPath, [SCRIPT, "--worktree", dir, "--ticket", ticket, "--audit", audit, "--matrix", matrix, ...extra], { encoding: "utf8" })) };
      } catch (error) {
        return { status: error.status, json: JSON.parse(error.stdout) };
      }
    };
    writeFileSync(audit, met("AC-1") + met("AC-2"));
    writeFileSync(matrix, cells(["AC-1", "AC-2"]));
    assert.deepEqual(run().json.problems, ["member ISS-124 is recorded on the session but has no --member body; its criteria are not audited"]);
    const unaudited = run("--member", `ISS-124=${member}`);
    assert.equal(unaudited.status, 1);
    assert.deepEqual(unaudited.json.problems, ["ISS-124:AC-1: not audited", "ISS-124:AC-1 x web x *: no test or QA evidence"]);
    writeFileSync(audit, met("AC-1") + met("AC-2") + met("ISS-124:AC-1"));
    writeFileSync(matrix, cells(["AC-1", "AC-2", "ISS-124:AC-1"]));
    const passing = run("--member", `ISS-124=${member}`);
    assert.equal(passing.status, 0);
    assert.deepEqual(passing.json.criteria, ["AC-1", "AC-2", "ISS-124:AC-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
