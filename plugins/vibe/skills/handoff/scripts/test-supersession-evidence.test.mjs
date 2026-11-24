import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { scanTestRepairs } from "./guardrails-gate.mjs";
import { testSupersessionApprovals } from "./test-supersession-evidence.mjs";

const file = "test/frozen-render.test.mjs";
const base = "a".repeat(40);
const source = "orchestrator answer on ISS-14476 frozen Sessions blocker, 2026-11-19";
const reason = "authorized stricter frozen repetition rule";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const titles = ["transient branch failure", "repeated base pass", "mixed base play", "failed-head diagnostic"];
const before = [
  "assert.equal(summary.ok, true)",
  "assert.equal(story.outcome, UnstableOnBase)",
  "assert.equal(mixed.outcome, SameFailure)",
  "assert.match(story.reason, /the branch's first play did not reproduce/)",
];
const after = [
  "assert.equal(summary.ok, false)",
  "assert.equal(story.outcome, Blocking)",
  "assert.equal(mixed.outcome, Blocking)",
  "assert.match(story.reason, /play PASS on the base, FAIL on the branch/)",
];
const cases = (statements, unrelated = "assert.equal(another.outcome, PASS)") => `
import test from "node:test";
import assert from "node:assert/strict";
${titles.map((title, i) => `test("${title}", () => { ${statements[i]}; assert.equal(renderCount, 2); });`).join("\n")}
test("unrelated fixture", () => { ${unrelated}; });
`;
const entries = titles.map((name, i) => ({ path: file, case: name, retiredBy: "ISS-14476", covers: reason,
  supersession: { base, row: "DT-038G", source, reason, changes: [{ index: 1, oldSha256: digest(before[i]), newSha256: digest(after[i]) }] } }));

function findings(records, approvals = entries, setup = {}) {
  return scanTestRepairs([{ path: file, status: "M" }], () => cases(before), () => cases(after, setup.unrelated),
    undefined, { records, approvals, base: setup.base ?? base }).findings;
}

test("ISS-14476 accepts the exact frozen supersession of three verdicts and the fourth diagnostic", () => {
  assert.deepEqual(findings(entries), []);
});

test("ISS-14476 rejects forged, stale, partial and unrelated assertion supersessions", () => {
  const corrupt = (patch) => entries.map((entry, i) => i === 0 ? { ...entry, ...patch,
    supersession: { ...entry.supersession, ...patch.supersession } } : entry);
  assert.ok(findings([]).length > 0);
  assert.ok(findings(entries, []).length > 0);
  assert.ok(findings(entries.slice(1)).length > 0);
  assert.ok(findings(entries, entries, { base: "b".repeat(40) }).length > 0);
  assert.ok(findings(corrupt({ case: titles[1] })).length > 0);
  assert.ok(findings(corrupt({ supersession: { source: "forged approval" } })).length > 0);
  assert.ok(findings(corrupt({ supersession: { row: "DT-038X" } })).length > 0);
  assert.ok(findings(corrupt({ supersession: { changes: [{ ...entries[0].supersession.changes[0], newSha256: "f".repeat(64) }] } })).length > 0);
  const unrelated = findings(entries, entries, { unrelated: "assert.equal(another.outcome, BLOCK)" });
  assert.equal(unrelated.length, 1);
  assert.match(unrelated[0].evidence, /another\.outcome/);
});

test("ISS-14476 reads supersession approvals only beside their cited decision-table row", () => {
  const fields = entries.map((entry) => `- Assertion supersession: ${JSON.stringify(entry)}`).join("\n");
  const section = `## Authorized assertion supersessions\n\n${fields}\n`;
  assert.deepEqual(testSupersessionApprovals(`| DT-038G | approved |\n\n${section}`), entries);
  assert.deepEqual(testSupersessionApprovals(section), []);
  assert.deepEqual(testSupersessionApprovals(`| DT-038G | approved |\n\n## Unapproved\n${fields}\n`), []);
});

test("ISS-14476 admits the frozen admission assertion only with its authorized row and reason", () => {
  const bind = (row, reason) => ({ ...entries[0], supersession: { ...entries[0].supersession, row, reason } });
  const admissionReason = "authorized separate frozen admission budget";
  const findingsFor = (first) => {
    const records = [first, ...entries.slice(1)];
    return findings(records, records);
  };
  assert.deepEqual(findingsFor(bind("DT-017A", admissionReason)), []);
  assert.ok(findingsFor(bind("DT-017A", reason)).length > 0);
  assert.ok(findingsFor(bind("DT-038G", admissionReason)).length > 0);
  assert.ok(findingsFor(bind("DT-017", admissionReason)).length > 0);
});
