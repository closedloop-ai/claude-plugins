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
  ["pm-review-duplicate-helper-copy/graders/both-sites.md", "artifact-creation-dialog.tsx:504", "the add-artifact-dialog.tsx:428 copy is allowed", "extract capitalize into generic-artifact-surface and remove the duplicate copy"],
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
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | delete the duplicate copy and import capitalize from generic-artifact-surface"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | delete the duplicate copy and import capitalize from generic-artifact-surface\n\nGraph:\n- made_up_tool anything: Recommendation: keep every prior outcome"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | Remove the duplicate function and import the shared helper from generic-artifact-surface"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | Remove the duplicate function and import the shared helper"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | owner is `packages/app/shared`; import the shared helper and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | use the shared helper from both dialogs and remove the duplicate\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | Move capitalize into generic-artifact-surface and remove the duplicate function\n\nGraph:\n- code_callers capitalize: no callers"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | Use the shared helper from generic-artifact-surface; import it and remove the duplicate helper\n\nGraph:\n- blast_radius_tickets helper.ts: no tickets"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | extract capitalize into generic-artifact-surface, then delete the duplicate copy\n\nGraph:\n- query_collisions duplicate helper: none"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move the report and remove the warning\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move the test helper and remove the log\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | move the duplicate from artifact-creation-dialog.tsx:504 into a shared helper | evidence | no change needed"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper; no removal needed\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper and avoid removal\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper; removal is not needed\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper; deleting the duplicate is unnecessary\n\nGraph:\n- ticket -> files"), false);
  for (const fix of ["import the shared helper and remove nothing",
    "delete none and import the shared helper", "drop neither and import the shared helper",
    "import the shared helper; removal optional"]) {
    assert.equal(pattern.test(`blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | ${fix}\n\nGraph:\n- ticket -> files`), false, fix);
  }
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | extract a shared helper, then delete the copy\n\nCorrection: no change needed\n\nGraph:\n- ticket -> files"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | move nothing, do not remove"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | no change needed"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | never import; delete the copy"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 duplicates artifact-creation-dialog.tsx:504 | import it; don't delete the copy"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper and remove the duplicate log"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | owner is packages/app/shared; import the shared helper and remove the duplicate function from artifact-creation-dialog.tsx:504"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | owner is packages/app/shared; import the shared helper and remove the duplicate function, so both dialogs use one owner"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/components/generic-artifact-surface and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/components/generic-artifact-surface/capitalize.ts and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/components/generic-artifact-surface` and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/components/generic-artifact-surface/preview/components and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/shared-helpers/capitalize.ts and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/components/generic-artifact-surface/preview/components/capitalize.ts` and remove the duplicate function"), true);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/components/generic-artifact-surface/preview/components/add-artifact-dialog.tsx and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into packages/app/shared/components/generic-artifact-surface.backup and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/../other` and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/shared-helpers.tmp` and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/artifact-creation-dialog.tsx` and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize into `packages/app/shared/components/generic-artifact-surface`backup and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import capitalize from add-artifact-dialog and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import capitalize from artifact-creation-dialog and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize to add-artifact-dialog and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | move capitalize to artifact-creation-dialog and remove the duplicate function"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper and remove the duplicate function's log"), false);
  assert.equal(pattern.test("blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | import the shared helper and remove the duplicate function pending"), false);
  for (const fix of ["never import the shared helper; remove the duplicate function",
    "don't move capitalize; remove the duplicate function",
    "import the shared helper from an unrelated owner and remove the duplicate function",
    "import the shared helper from an unrelated source and remove the duplicate function",
    "import the shared helper and remove an unrelated copy",
    "import the shared helper and remove the function",
    "move the warning from add-artifact-dialog and remove the duplicate function",
    "move the log into generic-artifact-surface and remove the duplicate function"]) {
    assert.equal(pattern.test(`blocking | add-artifact-dialog.tsx:428 | duplicates artifact-creation-dialog.tsx:504 | evidence | ${fix}`), false, fix);
  }
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
  const report = "REPORT: ISS-9002 has active work; exclude it and do not build it.";
  const uncovered = "UNCOVERED: ISS-9003 is untouched and outside the request.";
  const graph = "\n\nGraph:\n- code_symbols capitalize: packages/app/shared/helper.ts:42";
  const full = (claimLine, reportLine = report, supersede = "SUPERSEDE: None.",
    uncoveredLine = uncovered) =>
    `${claimLine}\n${reportLine}\n${uncoveredLine}\n${supersede}${graph}`;
  assert.equal(none.test(full("CLAIM: ISS-9001", report)), true);
  assert.equal(none.test(full("CLAIM: ISS-9001", report,
    "SUPERSEDE: ISS-9002 from agent judgment.")), false);
  assert.equal(claim.test(full("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: Session ISS-9000 coordinates this child")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; RELATES_TO: ISS-9000; COMMENT: ISS-9000 is the coordinating session ticket")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: ISS-9000 coordinates this child")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: ISS-9000 coordinates this claim, link, and status update")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and comment that ISS-9000 coordinates the work.")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and add a coordinator comment.")), true);
  assert.equal(claim.test(full("CLAIM: ISS-9001 — link ISS-9000, assign operator-1, then set IN_PROGRESS.")), false);
  for (const bad of [
    "CLAIM: ISS-9001; ASSIGN: skip assigning operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: avoid IN_PROGRESS; LINK: ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: refrain from ISS-9000; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: skip",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; COMMENT: note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: note\nNo action will be taken.",
    "CLAIM: ISS-9001; ASSIGN: will not assign operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: coordinator note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: will not set IN_PROGRESS; LINK: ISS-9000; COMMENT: coordinator note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: will not link ISS-9000; COMMENT: coordinator note",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: will not comment",
    "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: ISS-9000 coordinates this child but will not assign it",
  ]) assert.equal(claim.test(full(bad)), false, bad);
  const validStructuredClaim = "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: Session ISS-9000 coordinates this child";
  const mixedUncovered = full(validStructuredClaim, report, "SUPERSEDE: None.",
    "UNCOVERED: ISS-9003 and ISS-9002 are untouched and outside the request.");
  assert.equal(claim.test(mixedUncovered), false);
  assert.equal(none.test(mixedUncovered), false);
  const opaqueGraph = full(validStructuredClaim).replace(
    "- code_symbols capitalize: packages/app/shared/helper.ts:42",
    "- made_up_tool anything: Recommendation: keep every prior outcome");
  assert.equal(claim.test(opaqueGraph), true);
  assert.equal(none.test(opaqueGraph), true);
  for (const forbidden of ["build ISS-9002", "claim ISS-9002",
    "cancel ISS-9002", "supersede ISS-9002"]) {
    assert.equal(claim.test(full(validStructuredClaim,
      `REPORT: ISS-9002 has active work; exclude it and ${forbidden}.`)), false, forbidden);
    assert.equal(none.test(full(validStructuredClaim,
      `REPORT: ISS-9002 has active work; exclude it and ${forbidden}.`)), false, forbidden);
  }
  assert.equal(claim.test(full(validStructuredClaim, report, "SUPERSEDE: None.",
    "UNCOVERED: ISS-9003 is outside the request; assign it later.")), false);
  const fullGraders = ["claims-untouched.md", "reports-active.md", "leaves-uncovered.md",
    "no-supersession.md"].map((file) => grader(`pm-prd-children-are-scope/graders/${file}`));
  const contradictory = "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: Session ISS-9000 coordinates this child\n" +
    "REPORT: ISS-9002 has active work; exclude it and do not build it.\n" +
    "UNCOVERED: ISS-9003 is untouched and outside the request.\nSUPERSEDE: None.\n" +
    `No action will be taken, and we may supersede it later.${graph}`;
  assert.deepEqual(fullGraders.map((pattern) => pattern.test(contradictory)),
    [false, true, true, false]);
  const safeReport = "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: Session ISS-9000 coordinates this child\n" +
    "REPORT: ISS-9002 has active work; exclude it, do not build it, take no action on that child, and do not supersede ISS-9002.\n" +
    `UNCOVERED: ISS-9003 is untouched and outside the request.\nSUPERSEDE: None.${graph}`;
  assert.deepEqual(fullGraders.map((pattern) => pattern.test(safeReport)),
    [true, true, true, true]);
  const futureSafeReport = safeReport.replace("do not supersede ISS-9002",
    "we will not supersede ISS-9002");
  assert.deepEqual(fullGraders.map((pattern) => pattern.test(futureSafeReport)),
    [true, true, true, true]);
  assert.equal(claim.test(full("CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; COMMENT: Session ISS-9000 coordinates this child",
    "REPORT: ISS-9002 has active work; exclude it, then retract ISS-9001.")), false);
  const prompt = readFileSync(path.join(root, "pm-prd-children-are-scope/prompt.md"), "utf8");
  for (const mutation of [/ASSIGN:\s*operator-1/, /STATUS:\s*IN_PROGRESS/,
    /LINK:\s*ISS-9000/, /COMMENT:\s*<coordinator-note>/]) assert.match(prompt, mutation);
});
