# Provider text for skills/handoff/references/handoff-pr.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: tests-then-push -->
When the person explicitly asks for a pull request to
be raised, full tests for every change in the session are required before it
opens. Resume the SAME writer in `pull-request` mode, the only turn whose
envelope authorizes tests, to write them: every acceptance criterion and
unsuperseded row, production wiring and failure paths, on web and Desktop
where their adapters differ, and every entry on the missing tests list. Run
`node scripts/handoff-inventory.mjs --worktree "<wt>" --phase pull-request`,
then step 3's guardrail check, step 5's checks with the new tests included and
step 6's review on the result, with the repo's `review-soul` critic required
on those tests, then the remaining step 6 candidate gates before step 7's commit and its push and publication through
`vibe-environment-worker` in redeploy mode. The pull request does not open
until those tests pass, their independent review is clean and step 9's gate passes.
<!-- end: tests-then-push -->

<!-- block: ticket-stays -->
On this path the ticket stays with the person: step 8 skips the next-owner
question and lookup and gives the ticket worker the session's operator as the
next owner, and step 9 skips assign mode. Handoff opens the pull request as
its last step (step 9) through `vibe-environment-worker` in `pull-request`
mode, and the person gets its link, never a branch to merge.
<!-- end: ticket-stays -->

<!-- block: pr-dispatch -->
Then dispatch
`vibe-environment-worker` in `pull-request` mode (its own `pull-request`
record action, an exclusive record turn with no record writes) with the
worktree, the live ticket slug, the confirmed summary, the final verified
published commit from step 7, the tests the `pull-request` turn wrote and
step 5's check results, and the ticket's Production impact and Flag changes
and gates fields. It opens the pull request on the already pushed branch,
blocked until the inventory's `blocking.prBody` and `blocking.prEvidence` and
`../vibe/scripts/pre-pr-lanes.mjs check` pass
(`NEEDS_CHANGE`: runs to the verify worker, the rest to the SAME writer), and
returns its URL; it never enqueues or merges it. On `BLOCKED`, record the
reason on the Engineering checklist as a verified human-only blocker does
(`../vibe/references/guardrails.md`, "Plugins and tooling"), tell the
person in one plain line what prevented the pull request and which paths
were tried. Check for a safe retry or accepted alternative first. When it
remains a verified engineering-only block, offer to pass the pushed work
to someone now; never give them the branch to merge instead. When they name
someone, run step 8's
lookup and assign mode as for passing it on (ISS-13321). Then mark the
session handed off as below.
<!-- end: pr-dispatch -->

<!-- block: prd-children -->
After it returns the URL, have the ticket worker attach it to every PRD child
in review. In Codex, arm the core `$gh-monitor-pr` on it when already set up,
never asking for a restart.
<!-- end: prd-children -->

<!-- block: fix-push -->
5. Step 7: ROOT commits the fixes, the main-sync publication gate runs, and
   `vibe-environment-worker` in redeploy mode pushes the validated commit to
   the SAME branch through the normal pre-push hook. Never a force push,
   never a new branch or a second pull request.
<!-- end: fix-push -->

<!-- block: ticket-refresh -->
6. Step 8's ticket refresh: `vibe-ticket-worker` in handoff mode re-derives
   every record section the fixes touched (Production impact, Flag changes
   and gates, the tests, Missing tests) from the session record and the
   final diff.
<!-- end: ticket-refresh -->
