import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
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
    const source = readFileSync(path.join(root, file), "utf8");
    const pattern = /^pattern: '(.+)'$/m.exec(source)?.[1]?.replaceAll("''", "'");
    assert.ok(pattern, file);
    const grader = new RegExp(pattern, "i");
    const bad = `blocking | ${site} | ${nonFinding} | evidence | no change needed`;
    const good = `blocking | ${site} | ${file.includes("duplicate") ? "duplicate in add-artifact-dialog.tsx:428" : "defect"} | evidence | ${remedy}`;
    assert.equal(grader.test(bad), false, `${file} accepted a worded non-finding`);
    assert.equal(grader.test(good), true, `${file} rejected the precise remedy`);
    if (file.includes("dead-clear-control")) {
      assert.equal(grader.test(`blocking | ${site} | defect | evidence | Don't show Clear selection`), true);
    }
    if (file.includes("dirty-field-coverage")) {
      assert.equal(grader.test(`blocking | ${site} | defect | title.trim() !== "" || body.trim() !== "" | Compute dirty against every editable field`), true);
    }
  }
});
