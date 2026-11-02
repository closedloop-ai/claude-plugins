import assert from "node:assert/strict";
import test from "node:test";
import { prBodyClaimProblems } from "./pr-body-claims.mjs";

const pending = { testRuns: [
  { lane: "web-e2e", command: "pnpm test:e2e", status: "not-run" },
  { lane: "desktop-e2e", command: "pnpm --dir apps/desktop test:e2e", status: "not-run" },
] };

test("AC-005 DT-08: original PR wording cannot claim CI covers not-run web and Desktop E2E", () => {
  const body = "## Test plan\nThe web e2e flag-on test and Desktop e2e are not run locally; CI covers them.\n";
  assert.match(prBodyClaimProblems(body, pending).join("\n"), /CI coverage claim for not-run web and Desktop E2E lane/);
  const desktop = "Desktop e2e has not run. CI runs Desktop e2e. No CI runs it before merge.";
  assert.match(prBodyClaimProblems(desktop, pending).join("\n"), /not-run Desktop E2E lane/);
});

test("AC-005 DT-08: truthful handoff and an actual passing lane remain valid", () => {
  const truthful = "Web and Desktop E2E have not run. No CI runs these lanes before merge.";
  assert.deepEqual(prBodyClaimProblems(truthful, pending), []);
  const passed = { testRuns: [{ lane: "web-e2e", command: "pnpm test:e2e", status: "passed" }] };
  assert.deepEqual(prBodyClaimProblems("Web E2E ran in CI.", passed), []);
  const desktopOnly = { testRuns: [{ lane: "desktop-e2e", command: "pnpm --dir apps/desktop test:e2e", status: "not-run" }] };
  assert.match(prBodyClaimProblems("E2E has not run. CI covers E2E.", desktopOnly).join("\n"), /not-run Desktop E2E lane/);
  const mixedClaim = "Web E2E has not run. Desktop E2E passed. No CI runs these lanes before merge.";
  assert.match(prBodyClaimProblems(mixedClaim, pending).join("\n"), /Desktop.*not run/);
});

test("AC-001 DT-09: only an uncited universal Summary claim is blocked", () => {
  const claim = "## Summary\n- Every picker has a search box.\n\n## Test plan\nNeither touches a path in this PR.";
  assert.match(prBodyClaimProblems(claim, null).join("\n"), /Every picker.*file:line citation/);
  const cited = claim.replace("Every picker has a search box.", "Every picker has a search box (packages/app/picker.tsx:12).");
  assert.deepEqual(prBodyClaimProblems(cited, null), []);
  assert.deepEqual(prBodyClaimProblems("## Summary\nA picker has search.\n## Test plan\nNeither touches a path in this PR.", null), []);
});

test("S2 DT-09: Summary prose and table rows pass while bullet claims need any file citation", () => {
  const prose = "## Summary\nEvery picker has a search box.\n\n## Test plan\nNone.";
  const table = "## Summary\n| Claim | Evidence |\n| Every picker has search | none |\n\n## Test plan\nNone.";
  assert.deepEqual(prBodyClaimProblems(prose, null), []);
  assert.deepEqual(prBodyClaimProblems(table, null), []);
  const bullet = "## Summary\n- Every picker has a search box.\n\n## Test plan\nNone.";
  assert.match(prBodyClaimProblems(bullet, null).join("\n"), /file:line citation/);
  const cited = bullet.replace("search box.", "search box (docs/picker.md:12).");
  assert.deepEqual(prBodyClaimProblems(cited, null), []);
  const from9366 = "## Summary\n- **Unsaved close.** Closing with entered content asks to confirm.\n";
  const from9448 = "## Summary\n- **Navigation.** One hook puts an issue's page under Issues.\n";
  assert.deepEqual(prBodyClaimProblems(from9366, null), []);
  assert.deepEqual(prBodyClaimProblems(from9448, null), []);
});
