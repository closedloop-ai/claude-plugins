# Provider text for skills/handoff/references/handoff-pr.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: tests-then-push -->
step 6's review on the result, with the repo's `review-soul` critic required
on those tests, then the remaining step 6 candidate gates before step 7's commit and its push and publication through
`vibe-environment-worker` in redeploy mode. The pull request does not open
<!-- end: tests-then-push -->

<!-- block: ticket-stays -->
On this path the ticket stays with the person: step 8 skips the next-owner
question and lookup and gives the ticket worker the session's operator as the
next owner, and step 9 skips assign mode. Handoff opens the pull request as
its last step (step 9) through `vibe-environment-worker` in `pull-request`
mode, and the person gets its link, never a branch to merge.
<!-- end: ticket-stays -->

<!-- block: pr-dispatch -->
worktree, the live ticket slug, the confirmed summary, the final verified
published commit from step 7, the tests the `pull-request` turn wrote and
step 5's check results, and the ticket's Production impact and Flag changes
and gates fields. It opens the pull request on the already pushed branch,
<!-- end: pr-dispatch -->

<!-- block: pr-dispatch-2 -->
reason on the Engineering checklist as a verified human-only blocker does
<!-- end: pr-dispatch-2 -->

<!-- block: pr-dispatch-3 -->
someone, run step 8's
lookup and assign mode as for passing it on. Then mark the
<!-- end: pr-dispatch-3 -->

<!-- block: prd-children -->
After it returns the URL, have the ticket worker attach it to every PRD child
in review. In Codex, arm the core `$gh-monitor-pr` on it when already set up,
<!-- end: prd-children -->

<!-- block: fix-push -->
5. Step 7: ROOT commits the fixes, the main-sync publication gate runs, and
   `vibe-environment-worker` in redeploy mode pushes the validated commit to
<!-- end: fix-push -->

<!-- block: ticket-refresh -->
6. Step 8's ticket refresh: `vibe-ticket-worker` in handoff mode re-derives
   every record section the fixes touched (Production impact, Flag changes
   and gates, the tests, Missing tests) from the session record and the
   final diff.
<!-- end: ticket-refresh -->
