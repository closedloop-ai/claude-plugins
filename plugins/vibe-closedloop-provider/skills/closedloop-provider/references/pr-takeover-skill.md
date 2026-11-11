# Provider text for skills/pr-takeover/SKILL.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-scope -->
2. Read the linked ticket, PRD, human comments and applicable repository instruction files. A ticket body or a fleet instruction is not a human ruling. Preserve every settled behavior and flag-off path. Use closedloop-graph for ticket and code scope, then verify its material findings against the checkout.
<!-- end: read-scope -->

<!-- block: lane-selection -->
4. Read the repo's `pnpm test:lanes` selection for the PR diff. Read its E2E, browser and Desktop instructions, plus `.github/pr-test-event-tiers.md` before naming CI coverage. Do not infer a run from a workflow's existence.
<!-- end: lane-selection -->

<!-- block: reviewers -->
2. Start read-only `../../agents/vibe-adversarial-reviewer.md` and `../../agents/vibe-guardrails-reviewer.md` through the current runtime's native reviewer launch path. In Claude Code that is the launcher's sessionless takeover route, never the native Agent tool: run `node ../vibe/scripts/dist/claude-worker.mjs` in the takeover worktree checked out at the fetched head, with one JSON object on stdin naming that worktree, the reviewer as `agentName`, mode `pull-request`, a `requestId`, the brief as `input`, every closedloop-graph read you can see as `capabilities`, and `"sessionless": {"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full 40-character head SHA>"}}`. The launcher refuses another head, a checkout that holds a vibe session, and every other role, writers included. Save each output and capture it with `node ../handoff/scripts/review-receipts.mjs --worktree <takeover worktree> --role <reviewer> --result <output.json> --out <receipt.json> --pr-url <PR URL> --head <head SHA>`; the receipt records the PR URL, head SHA and worktree, and capture fails for any other head. For Codex reviewers, use the managed App Server thread and machine-observed receipt path in `../handoff/SKILL.md`, section `9. Hand it over`; a native subagent without a readable managed thread cannot clear review. Their PR-specific brief names the worktree, head SHA, live base ref and SHA, changed paths, ticket criteria and exact review diff. It states that there is no previous vibe session or session decision table. Give both `../vibe/references/review-premises.md`. Override the adversarial reviewer's usual origin/main diff with the supplied live-base diff for a stacked PR. Use `../handoff/scripts/review-receipts.mjs` for structured results; a turn-end or prose-only clean claim is not a review receipt. A source change after review needs a new head SHA, a new launch and a new receipt.
<!-- end: reviewers -->

<!-- block: prevention-ticket -->
2. Search recent open claude-plugins vibe tickets by class. Append the evidence to, or link, an existing ticket with the same prevention class. Do not create a duplicate. When verified classes remain uncovered, select the current vibe project, run `../vibe/scripts/ticket-write-check.mjs` for that project, then call ClosedLoop `create-document` for one issue with `repositorySelection` primary `closedloop-ai/claude-plugins`. Include every uncovered class, instance, evidence and proposed prevention. Read the new issue back and retain its URL.
3. Start one prevention worker in a separate claude-plugins worktree during this run. In Claude Code use a native Agent worker; in Codex use a native worker or the installed managed App Server worker path. Give it the issue and `closedloop-core:prevent-recurrence`; require class search, strongest rung, proof and closeout. The worker owns only the prevention branch. Use the existing worker, not the symphony-alpha-specific `vibe-ticket-worker`, to write its prevention code. The takeover continues on the product PR while that worker runs. Record the worker identity, ticket link and actual status. A failed launch is reported as incomplete prevention work, never as a started worker.
<!-- end: prevention-ticket -->

<!-- block: lane-commands -->
1. Get exact commands from the target repo's `pnpm test:lanes` report for the final diff. Run the existing `../vibe/scripts/pre-pr-lanes.mjs` check with its report option. A `not-run` result means the lane is incomplete even when that script permits publication. A Desktop control walk named `linux-walk` is not the Desktop `test:e2e` lane.
<!-- end: lane-commands -->
