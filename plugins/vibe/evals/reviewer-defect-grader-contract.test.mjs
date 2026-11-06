import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const grader = (file) => {
  const source = readFileSync(path.join(root, file), "utf8");
  const pattern = /^pattern: '(.+)'$/m.exec(source)?.[1]?.replaceAll("''", "'");
  assert.ok(pattern, file);
  return new RegExp(pattern, /^flags: '?(.*)'?$/m.exec(source)?.[1] ?? "i");
};

const cases = [
  ["pm-review-flag-resolution/graders/pending-swap.md", "documents-create-action.tsx:77", "pending swap is already safe", "use useFeatureFlagGate and wait for isReady"],
  ["pm-review-paged-refetch/graders/page-fanout.md", "use-documents.ts:202", "pages refetch is already bounded", "add maxPages to bound refetch"],
  ["pm-review-dead-clear-control/graders/clear.md", "creation-owner-field.tsx:56", "Clear already works", "hide Clear selection"],
  ["pm-review-pending-owner-value/graders/loading-value.md", "creation-owner-field.tsx:44", "Unassigned is correct while pending", "render an isPending state"],
  ["pm-review-dirty-field-coverage/graders/property-only.md", "artifact-creation-dialog.tsx:167", "dirty already covers Priority", "include every editable field in dirty"],
  ["pm-review-duplicate-helper-copy/graders/both-sites.md", "artifact-creation-dialog.tsx:504", "the add-artifact-dialog.tsx:428 copy is allowed", "extract one shared helper and remove the copy"],
];

test("S4 AC-001: each reviewer grader rejects a worded non-finding and requires its remedy", () => {
  for (const [file, site, nonFinding, remedy] of cases) {
    const pattern = grader(file);
    const bad = `blocking | ${site} | ${nonFinding} | evidence | no change needed`;
    const good = `blocking | ${site} | ${file.includes("duplicate") ? "duplicate in add-artifact-dialog.tsx:428" : "defect"} | evidence | ${remedy}`;
    assert.equal(pattern.test(bad), false, `${file} accepted a worded non-finding`);
    assert.equal(pattern.test(good), true, `${file} rejected the precise remedy`);
    if (file.includes("dead-clear-control")) {
      assert.equal(pattern.test(`blocking | ${site} | defect | evidence | Don't show Clear selection`), true);
    }
    if (file.includes("dirty-field-coverage")) {
      assert.equal(pattern.test(`blocking | ${site} | defect | title.trim() !== "" || body.trim() !== "" | Compute dirty against every editable field`), true);
    }
    if (file.includes("duplicate-helper-copy")) {
      assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 and artifact-creation-dialog.tsx:504 | move nothing, do not remove"), false);
    }
  }
});

test("ISS-13760 AC-001: duplicate-helper grading is order-independent and fail-closed", () => {
  const pattern = grader("pm-review-duplicate-helper-copy/graders/both-sites.md");
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | delete the copy and import the shared helper"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | move nothing, do not remove"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | no change needed"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | never import; delete the copy"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | import it; don't delete the copy"), false);
});

test("ISS-13760 AC-002: host-adapter grading accepts order and hyphen variants but requires the lane on the entry", () => {
  const desktop = grader("pm-missing-tests-host-adapters/graders/desktop-entry.md");
  const bothHosts = grader("pm-missing-tests-host-adapters/graders/both-host-rule.md");
  const lane = grader("pm-missing-tests-host-adapters/graders/owning-lane.md");
  assert.equal(desktop.test("Missing tests: PRD-42 AC-3 needs its saved-selection Desktop coverage."), true);
  assert.equal(desktop.test("Missing tests: Desktop saved-selection coverage without a criterion."), false);
  assert.equal(bothHosts.test("The host-adapter rule covers Desktop as well as web."), true);
  assert.equal(bothHosts.test("The web adapter alone is enough."), false);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 — Desktop saved selection in the Desktop test lane."), true);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 — Desktop saved selection.\nIts owning test lane is desktop-e2e."), false);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 — discover the Desktop test lane."), false);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 — Desktop needs no lane."), false);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 — Desktop; consult pnpm test:lanes."), false);
  assert.equal(lane.test("Missing tests: Desktop in the Desktop test lane, no criterion."), false);
  assert.equal(lane.test("Missing tests: PRD-42 AC-3 in the web lane.\nMissing tests: Desktop in the Desktop test lane."), false);
  assert.equal(bothHosts.test("The web and Desktop adapter coverage rule does not apply."), false);
  assert.equal(bothHosts.test("The Desktop adapter is exempt; web is covered."), false);
  assert.equal(bothHosts.test("Desktop does not need adapter coverage; the web adapter does."), false);
});

test("ISS-13760 AC-004: touch grading accepts ruled equivalents and either iOS term order", () => {
  const insufficient = grader("pm-card-touch-device-coverage/graders/current-evidence-insufficient.md");
  const iosMouse = grader("pm-card-touch-device-coverage/graders/ios-mouse-click.md");
  const equivalents = ["do not establish", "do not prove", "do not show", "do not verify",
    "do not count", "not enough", "neither verifies", "but no real device", "no WebKit"];
  for (const wording of equivalents) {
    assert.equal(insufficient.test(`Keyboard and hasTouch ${wording} the tap result.`), true, wording);
  }
  assert.equal(insufficient.test("Keyboard and hasTouch prove the tap result."), false);
  assert.equal(insufficient.test("Keyboard and hasTouch verify taps, but no WebKit or real-device run exists."), true);
  assert.equal(insufficient.test("Keyboard and hasTouch verify taps, but no defect or issues exist."), false);
  assert.equal(iosMouse.test("pointerType is mouse even when an iPhone tap produces the click."), true);
  assert.equal(iosMouse.test("A WebKit iPhone tap can report pointerType mouse."), true);
  assert.equal(iosMouse.test("pointerType is touch on Chromium."), false);
  assert.match(readFileSync(path.join(root,
    "pm-card-touch-device-coverage/graders/two-devices.md"), "utf8"),
  /pattern: 'WebKit\[\^\\n\]\*iPhone\[\^\\n\]\*\(Chromium/);
});

test("ISS-13760 AC-006: child grading accepts bare none and complete link wording only", () => {
  const none = grader("pm-prd-children-are-scope/graders/no-supersession.md");
  const claim = grader("pm-prd-children-are-scope/graders/claims-untouched.md");
  assert.equal(none.test("SUPERSEDE: None."), true);
  assert.equal(none.test("SUPERSEDE: None.\nSUPERSEDE: ISS-9002 from agent judgment."), false);
  assert.equal(claim.test("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: coordinator note"), true);
  assert.equal(claim.test("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; RELATES_TO: ISS-9000; COMMENT: coordinator note"), true);
  assert.equal(claim.test("CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and comment that ISS-9000 coordinates the work."), true);
  assert.equal(claim.test("CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and add a coordinator comment."), true);
  assert.equal(claim.test("CLAIM: ISS-9001 — link ISS-9000, assign operator-1, then set IN_PROGRESS."), false);
  for (const bad of [
    "CLAIM: ISS-9001; ASSIGN: skip assigning operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: avoid IN_PROGRESS; LINK: ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: refrain from ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: skip",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; COMMENT: note",
  ]) assert.equal(claim.test(bad), false, bad);
  const prompt = readFileSync(path.join(root, "pm-prd-children-are-scope/prompt.md"), "utf8");
  for (const mutation of ["ASSIGN: operator-1", "STATUS: IN_PROGRESS",
    "LINK: ISS-9000", "COMMENT:"]) {
    assert.match(prompt, new RegExp(mutation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
