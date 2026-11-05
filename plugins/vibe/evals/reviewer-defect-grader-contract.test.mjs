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

const iss13727Graders = [
  ["pm-review-iss-13727-guardrails/graders/test-expectations.md",
    ["rulings-check.test", "six", "two", "behavior ruling", "restores or keeps"]],
  ["pm-review-iss-13727-guardrails/graders/shared-classifier.md",
    ["scope-intake", "handoff/path classifier", "shared lower-level classifier", "case parity"]],
  ["pm-review-iss-13727-guardrails/graders/changelog-citation-scope.md",
    ["CHANGELOG", "citation", "semicolon", "line-versus-clause", "truthful"]],
  ["pm-review-iss-13727-guardrails/graders/changelog-symlink-claim.md",
    ["CHANGELOG", "symlink escapes", "allowed assertion", "adversarial proof", "combined protected-write"]],
  ["pm-review-iss-13727-adversarial/graders/security-exception.md",
    ["absent targets", "dangling targets", "wrong-type or directory", "escape or hooks",
      "alternate or supported write forms", "collectively", "complete adversarial boundary coverage"]],
  ["pm-review-iss-13727-adversarial/graders/production-wiring.md",
    ["direct load-check helper", "fleet production call-site", "stays green", "production-boundary assertion"]],
  ["pm-review-iss-13727-adversarial/graders/binding-consumers.md",
    ["existing or borrowed", "discard or cancel", "ownership provenance", "session-owned tickets"]],
  ["pm-review-iss-13727-adversarial/graders/gating-regex.md",
    ["bare follows or wait-for", "ordinary prose", "positive-only tests", "near-miss or negative"]],
];

function grader(file) {
  const source = readFileSync(path.join(root, file), "utf8");
  const pattern = /^pattern: '(.+)'$/m.exec(source)?.[1]?.replaceAll("''", "'");
  assert.ok(pattern, file);
  return new RegExp(pattern, "i");
}

test("S4 AC-001: each reviewer grader rejects a worded non-finding and requires its remedy", () => {
  for (const [file, site, nonFinding, remedy] of cases) {
    const rule = grader(file);
    const bad = `blocking | ${site} | ${nonFinding} | evidence | no change needed`;
    const good = `blocking | ${site} | ${file.includes("duplicate") ? "duplicate in add-artifact-dialog.tsx:428" : "defect"} | evidence | ${remedy}`;
    assert.equal(rule.test(bad), false, `${file} accepted a worded non-finding`);
    assert.equal(rule.test(good), true, `${file} rejected the precise remedy`);
    if (file.includes("dead-clear-control")) {
      assert.equal(rule.test(`blocking | ${site} | defect | evidence | Don't show Clear selection`), true);
    }
    if (file.includes("dirty-field-coverage")) {
      assert.equal(rule.test(`blocking | ${site} | defect | title.trim() !== "" || body.trim() !== "" | Compute dirty against every editable field`), true);
    }
  }
});

test("ISS-13727 LLM grader criteria preserve every prevention requirement", () => {
  for (const [file, required] of iss13727Graders) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.match(source, /^type: llm$/m, file);
    const criteria = /^criteria: \|\n([\s\S]*?)\n---$/m.exec(source)?.[1];
    assert.ok(criteria, `${file} has no criteria block`);
    for (const phrase of ["PASS only", "FAIL if", "high or blocking", "concrete evidence",
      "concrete repair", "absent", "approved or ignored", "generic concern"]) {
      assert.match(criteria, new RegExp(phrase, "i"), `${file} lacks ${phrase}`);
    }
    assert.match(criteria, /(?:lacks|missing) a concrete repair|concrete repair is missing/i,
      `${file} permits a missing repair`);
    for (const phrase of required) assert.match(criteria, new RegExp(phrase, "i"), `${file} lacks ${phrase}`);
  }
});

test("ISS-13727 prompts carry evidence without giving away findings or remedies", () => {
  const guardrails = readFileSync(path.join(root, "pm-review-iss-13727-guardrails/prompt.md"), "utf8");
  const adversarial = readFileSync(path.join(root, "pm-review-iss-13727-adversarial/prompt.md"), "utf8");
  for (const token of ["six exclusion categories", "classifyHandoffPath", "const cited", "Symlink escapes remain denied"]) {
    assert.match(guardrails, new RegExp(token));
  }
  for (const token of ["nativeTarget", "runLoadCheck", "cancelTicket", "const SEQUENCING",
    "review follows normal policy", "wait for the preview to load",
    "Every proven defect in these excerpts is high; report it in the requested high format.",
    "Each fix must name the production correction and its boundary regression test."]) {
    assert.match(adversarial, new RegExp(token));
  }
  for (const phrase of ["falls from six", "copies disagree", "never exercises", "require the exact",
    "do not approve", "narrower or stronger"]) {
    assert.doesNotMatch(guardrails.toLowerCase(), new RegExp(phrase));
  }
  for (const phrase of ["admits the session", "there are no", "leaves the new test green", "still sends",
    "because it has no", "blocks ordinary", "not sufficient", "find the smallest"]) {
    assert.doesNotMatch(adversarial.toLowerCase(), new RegExp(phrase));
  }
});

test("ISS-13727 reviewer rules own all seven prevention classes", () => {
  const compact = (file) => readFileSync(path.join(root, "../agents", file), "utf8")
    .split(/\s+/).join(" ");
  const guardrails = compact("vibe-guardrails-reviewer.md");
  const adversarial = compact("vibe-adversarial-reviewer.md");
  for (const phrase of ["Deleted named expectations, fixture members", "policy and classification logic",
    "map each added CHANGELOG statement"]) assert.match(guardrails, new RegExp(phrase));
  for (const phrase of ["A security exception needs adversarial cases", "production-wiring test may not be replaced",
    "trace every producer", "ordinary prose and near-miss inputs", "Severity floor",
    "security-exception gap", "lost production-boundary wiring check",
    "destructive-consumer ownership or provenance gap", "gate false positive is `high`",
    "both the production correction and the boundary, adversarial or negative",
    "regression test that would fail without it"]) {
    assert.match(adversarial, new RegExp(phrase));
  }
});
