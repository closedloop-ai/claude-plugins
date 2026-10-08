---
name: cl-execute
description: Draft and upload ClosedLoop implementation plans with Mermaid scope flowcharts, then execute one ClosedLoop feature ticket or a parent-approved coherent multi-ticket feature end to end on Codex Desktop or as a leased Codex CLI ticket worker after all readiness, legacy split-lineage, complexity, risk, requirements, batch, and UI guidance gates. Plan, implement, run the required two-pass coordinated review sequence, validate, open and remediate the feature's single PR, maintain the author-owned feature manual-QA plan and evidence, hand passive monitoring to $cl-sweep or a detached standalone monitor, use protected-queue or human UI merge policy, and reconcile every included ticket. In CLI sweeps, the ticket worker may directly manage bounded read-only support lanes and returns compact CL_SWEEP_EVENT v1/CL_SWEEP_RESULT v1 routing summaries.
---

# CL Execute

## Purpose

Draft the required ClosedLoop-linked implementation plan, then execute one
functional feature as a long-running goal. A feature is one complete selected
user-facing page or capability delivered end to end, not automatically an
entire PRD. It may be one ticket or one coherent multi-ticket unit explicitly
selected by `$cl-sweep`; all member tickets and shipping surfaces required for
that page or capability belong in one integrated pull request. Other pages or
capabilities from the same PRD and separately owned shared-foundation
prerequisites may remain outside this feature boundary.

```text
$cl-execute <ClosedLoop feature URL or FEA/ISS slug>
$cl-execute batch: <ticket URL> <ticket URL> ...
```

`$cl-analyze` decides whether work is ready and whether a plan approval gate is
required. `$cl-execute` owns plan drafting, plan review, upload/link, revision,
approval-or-wait disposition, implementation, the two-pass coordinated
code-review sequence, validation, PR handoff, merge disposition, and ticket/
plan reconciliation.

Treat the invocation as standing approval to create and approve the
implementation plan after worker review, create a PR, address PR feedback, merge
once CI is green and the PR is ready, and mark the feature done after merge.
This approval applies only after the readiness gate passes and no human UI plan
approval is required. It does not authorize high-complexity execution without an
exact-ticket override, extreme-risk work, incoherent batches, duplicate/stale or
blocked work, UI implementation without required human plan approval, manual CI
or review triggers, or externally visible engineering/operational comments.

Do not post completion messages.

## Sweep display activity

When invoked within a sweep, follow [display events](../cl-sweep/references/display-events.md) for both Desktop and CLI owners: report actual planning, coding, review and human-wait entry, and clear the phase on exit. Logging failures do not block work. Publish verified business status after existing authenticated ClosedLoop ticket reads, without additional wallpaper queries. Report explicitly established or cleared ticket dependencies using that reference.

## Load References

Read only the references relevant to the current phase:

- Intake, readiness, requirements, plan drafting, contract audits, performance
  work, UI plan approval, or the one-off cleanup-tooling churn guard:
  [references/planning-and-gates.md](references/planning-and-gates.md).
- CLI sweep context, support lanes, App Server worker continuity, callback
  protocol, or macOS GitHub transport fallback:
  [references/support-lanes-and-sweeps.md](references/support-lanes-and-sweeps.md).
- Source implementation, validation, review, review-learning persistence,
  per-branch push gates, PR creation, or PR comment handling:
  [references/implementation-review-pr.md](references/implementation-review-pr.md).
- The cross-family lane in each coordinated review generation (verified CLI
  commands, sandbox limits, fallback, reviewer prompt):
  [references/cross-family-review.md](references/cross-family-review.md).
- Post-PR author manual-QA plan comments, guided session evidence, head-change
  invalidation, or functional-readiness gating:
  [references/feature-manual-qa.md](references/feature-manual-qa.md).
- Passive monitoring, merge queue recovery, post-start blockers, merge
  disposition, or completion reconciliation:
  [references/monitoring-merge-completion.md](references/monitoring-merge-completion.md).
- Required `CL Execute Gate Result` or `CL Execute Result` output schemas:
  [references/result-formats.md](references/result-formats.md).
- Drafting a PR body, plan prose, the manual-QA comment, a Product-decision
  comment, a PR thread reply, a pause or resume note, or a result's free-text
  fields: [references/writing.md](references/writing.md).
- Scripts: `scripts/check-plan.mjs` lints a plan draft before review and
  upload; `scripts/decision-log.sh` appends to the private decision log.

If a phase crosses more than one category, read each matching reference before
acting. Do not load every reference by default.

## Shared Policy

Before routing blockers, recommending blocker communication, or writing
externally visible blocker text, read the sibling policy skill at
`../cl-policy/SKILL.md` and follow its Required Reference resolution order. Use
`references/local-policy.md` when present; otherwise use
`references/local-policy.example.md` only to understand the required shape, then
require a populated `$HOME/.closedloop-ai/local-policy.md` before routing. Use
the policy terms `Product contact` and `Engineering attention contact`; do not
hardcode a personal name for the engineering attention contact.

## Hard Boundaries

- Treat ClosedLoop comments as company-visible product records. Keep every
  engineering/operational blocker private unless the user explicitly requests
  the exact comment. Only genuine Product-decision comments are automatic, and
  only after Product Answer Discovery proves the apparent question has not
  already been answered and the Product contact is available under current
  user/session context.
- Do not invoke `$workflow-orchestrator`, `$workflow-execute`, or any
  orchestrator-run ticket execution workflow.
- Do not invoke `$cl-split`, split tickets, create child tickets, or turn
  legacy split evidence into a split-repair route. Keep every issue as the
  single ticket it already is.
- Use the standalone `workflow-memory` CLI for repo-memory root resolution,
  queries, writes, validation, and attachments. Do not route memory access
  through workflow-orchestrator.
- Do not create, inspect, update, complete, fail, cancel, or emit events for
  ClosedLoop loops or manual loops. ClosedLoop MCP loop guidance is superseded
  by this boundary. Use ticket status, linked plan, pull request, validation
  evidence, structured result, and workflow repo memory as the execution record.
- Do not skip independent plan review, the required two-pass coordinated
  code-review sequence, PR comment handling, or current-head CI evidence.
- One feature has exactly one integrated PR, including when backend, Storybook,
  and production UI work originate in different member tickets. Do not split
  the functional delivery into per-surface PRs or infer whole-feature
  functionality from isolated member-ticket evidence.
- After the PR exists, create and maintain the single author-owned feature
  manual-QA plan comment in
  [references/feature-manual-qa.md](references/feature-manual-qa.md). Do not
  enqueue, merge, report readiness or functionality, or complete tickets until
  the responsible human author has supplied passing evidence for the relevant final
  change across the integrated feature.
- Do not wait for pending CI before addressing known open PR comments or review
  threads. Existing review feedback is PR work, not passive CI monitoring: fix,
  reply, resolve, and push the remediation as soon as focused validation passes.
  A pending older own-branch check is superseded by the PR-comment fix; do not
  hold the fix behind it.
- When live current-head PR CI is already green for all checks, or green for
  the specific check lanes a post-PR remediation delta can affect, treat that
  green CI as the broad validation evidence for everything outside the delta.
  Do not rerun a broad local validation suite for the delta. Use
  closedloop-graph code intelligence (`code_tests_for` when a checkout cannot
  provide better related-test data, and local related-test tooling when
  available) plus repo memory to select isolated tests/static checks for the
  files actually changed; run only those focused commands, mandatory hooks, and
  `git diff --check` unless the delta invalidates prior evidence, expands the
  touched surface, or touches an unindexed path where graph evidence cannot map
  the blast radius.
- Never manually trigger or retrigger GitHub CI or automated review. Observe and
  address automation that starts on its own.
- Never make a failing check pass by changing the check. That covers test
  assertions and expected values, snapshots and screenshot baselines,
  tolerances, skip and quarantine lists, timeouts, coverage thresholds, size and
  performance budgets, lint and type-error baselines, and harness code, and it
  covers restructuring product code only to satisfy a check. Change a check
  only when the requirements contract changed that behavior (cite the
  requirement beside the change in the result and the PR) or with the user's
  explicit approval for that exact change. Adopting a value that main already
  changed is integration, not a change to the check. If a baseline or
  expectation looks wrong, keep it and report it as a finding with evidence.
- Run exactly two coordinated `$workflow-code-review` generations before
  opening or finalizing the PR in both Codex Desktop and Codex CLI sessions:
  review, fix valid findings, review the remediated tree again, then fix valid
  second-pass findings. Never launch a third coordinated review generation after
  the second pass completes, including after further fixes, head changes,
  rebases, or integration.
- For each coordinated review generation, launch the full default
  `$workflow-code-review` lane set concurrently in one fan-out. The generic
  two-support-lane cap does not apply to these read-only review cohorts; do not
  serialize, batch, or throttle their lanes when concurrency slots are
  available. The same fan-out includes one read-only cross-family lane from
  [references/cross-family-review.md](references/cross-family-review.md): a
  Codex worker gets a Claude Code reviewer and a Claude Code worker gets a
  Codex reviewer. When that CLI cannot run, use its documented same-family
  fallback and record `Cross-family review: unavailable`; never skip it
  silently.
- Between the two review generations, run only the fast compile/static/focused-
  unit checks needed to keep the remediated snapshot reviewable. Defer broad,
  containerized, browser, Electron, and full-suite validation until all valid
  second-pass findings are fixed, then run that comprehensive validation once
  on the final tree unless an intermediate finding can be verified only at a
  real boundary.
- Every failing automatically reported current-head coverage check is the ticket
  worker's responsibility until green, even when branch protection does not mark
  it required.
- Do not classify a current-head red CI lane as "unrelated" and wait passively
  merely because the failure appears outside the touched files. First compare
  live evidence from current `origin/main`, the PR/merge-group head, and
  relevant peer PR runs when useful. If latest main already fixes the failure,
  integrate main into the branch and push. If other active PRs or latest main
  are green for the same lane, treat the failure as branch-caused, indirect, or
  flaky-but-owned by this PR until the worker fixes it or automatic rerun
  evidence proves the current head green. Only a CI-provider outage, credential
  outage, or job that cannot execute may be routed as an external wait, and the
  result must name the exact external owner/evidence.
- Do not gate pushes on repository-wide active CI branch counts. Inspect only
  this ticket branch for older queued/running CI.
- Do not merge or rebase current main into a green, mergeable PR head merely as
  a final-integration precaution. Integrate main only for a source conflict,
  proven unlanded dependency, or concrete queue/base failure evidence.
- Do not plan or implement third-party API, SDK, hosted platform, model
  provider, auth/billing provider, webhook, or fast-moving integration behavior
  from model memory alone. Consult official current online documentation and
  record the evidence.
- Do not report `ENGINEERING_BLOCKED`, `BLOCKED_BEFORE_START`, or any dependency
  blocker from ClosedLoop status or artifact links alone. First verify the
  blocker against live GitHub PR state, current `origin/main` ancestry, related
  plans/comments, closedloop-graph, and the current checkout. If a blocker ticket
  or `BLOCKS` link is stale because the blocking PR already merged, reconcile the
  stale ClosedLoop state/link when authorized by the lane, then re-run readiness
  instead of repeating the stale blocker.
- Do not ask for separate approval to approve the plan once gates are satisfied,
  except for UI work without a clear ticket design, screenshot, or prototype, or
  when the current sweep/session instruction requires Daniel's personal approval
  for every implementation plan.
- Every implementation plan draft or revision must use the `mermaid-visualizer`
  skill and include Mermaid flowchart code fences that help Daniel understand
  the scope of change. Default to before/after flowcharts for architecture,
  control-flow, data-flow, lifecycle, retry, persistence, or UI flow changes.
  If a different flowchart shape explains the scope better, use that shape, but
  do not omit diagrams merely because the change is non-UI.
- During an active planning, implementation, validation, or PR-handling turn,
  treat new human messages as queued input by default. A message about another
  issue, plan, PR, policy, or concern is not permission to drop the current
  action or reorder the lane. Preempt only when the human explicitly says to
  work on it immediately, stop, pause, abort, switch now, or when the message
  reports a material safety/security/production incident that makes continuing
  the current action unsafe. Otherwise acknowledge the queued item briefly,
  finish the current safe step, then process queued items in priority order.
- On an explicit pause or stop, finish or back out of the current atomic step,
  start nothing new, and stop running support lanes, except that an in-flight
  coordinated review generation completes and its artifacts are kept, because
  a launched generation counts toward the two. Take no push, PR, queue, or
  ticket-status action in order to pause. Leave uncommitted edits in the
  worktree and never make a `wip:` commit; under a sweep the parent's
  checkpoint captures dirty state, and standalone the note records
  `git status`. Write a resume note to the ticket's workflow-memory execution
  record using repo-relative paths only: intent, current phase, what is
  verified with evidence pointers, review generations and Parker pass used,
  the next action, and gotchas. Then return the current status with
  `Blocker: paused by user instruction`.
- UI PRs require Daniel's human/manual merge by default. Ready non-UI PRs use
  standing direct protected-queue authorization. UI, UI-impacting contract, or
  workflow changes require exactly one dedicated pre-PR Parker visual-QA pass
  before first push/open PR. The
  [Parker Visual-QA Gate](references/implementation-review-pr.md#parker-visual-qa-gate)
  is the one owner of its timing, blockers, exceptions, handoff evidence, and
  head-change rules; read it before any UI push, PR, handoff, or ready claim.
- Preserve compatibility shims unless the user explicitly approves removal in
  the current task.
- Require automated browser E2E to be headless and Electron E2E to use the
  repository-supported displayless harness. Never silently fall back to headed
  or visible execution.
- Follow all applicable `AGENTS.md`, repo-local instructions, ClosedLoop status
  lifecycle rules, and compatibility guardrails.

## Intake

1. Parse one ticket URL/slug or a parent-approved batch manifest. If neither is
   provided, ask one concise clarification and stop. Reject ad hoc batches that
   lack a stable batch id, every full ticket URL, analysis result, requirements
   contract, acceptance criteria, aggregate complexity/risk, validation/rollback
   boundary, merge policy, and designated execution-owner worktree.
2. Start or continue a Codex goal for the exact ticket or approved batch when
   goal tooling is available. In an App Server ticket worker this is mandatory;
   failure to create or resume the goal is `MANUAL_INTERVENTION_REQUIRED`.
3. Load every included ticket from live ClosedLoop. Fetch directly relevant
   linked PRDs, plans, comments, acceptance criteria, attachments, project
   context, parent/child links, split signature comments, and related tickets.
4. Use `closedloop-graph` proactively under cl-policy's host-capability rules
   during intake, readiness revalidation, planning, dependency checks, and final
   requirements conformance. Inspect ticket-bounded lineage, blockers,
   producers, semantic matches, duplicates, prior Product blockers, related
   PRD/plan/comment/design decisions, related PR overlap, and codebase
   intelligence. Verify graph-derived code claims against the current checkout
   and graph-derived decision claims against live ClosedLoop artifacts. Every
   later step that finds something uses the Discovery Routes below.
5. If resuming from `Status: WAITING_UI_PLAN_APPROVAL`, reload the linked plan
   and ticket comments/status before doing anything else. Continue only when
   explicit human approval for the same uploaded UI plan is present.
6. On any resume, replacement, adoption, or post-compaction turn (the ticket
   already has a branch, PR, uploaded plan, decision log, prior
   `CL Execute Result`, or workflow-memory execution record), reconstruct state
   before acting. Read the decision log's last rows first and append its
   `start` row, then read the latest result and memory record (including any
   pause note), the linked plan, the PR head, checks, and unresolved threads,
   the manual-QA comment, and `git log` plus `git diff` against the merge base.
   Record which phases are done: review generations used, the pre-PR Parker
   pass, the ordinary review-remediation push, and manual-QA scenarios with
   their tested heads and patch-ids. Name the resume point and do not redo a
   finished phase; never start a third review generation or a second Parker
   pass. Verify each inherited claim the next step depends on against live
   state (the PR head matches, checks are as reported, the named focused tests
   pass at the head) instead of trusting prior prose, and redo only what live
   state contradicts.
7. Mark each included non-terminal, non-currently-blocked feature
   `IN_PROGRESS` when evaluation or planning starts. This status does not
   authorize branch creation, source edits, PR work, or merge work.
8. Run the readiness gate in
   [references/planning-and-gates.md](references/planning-and-gates.md) before
   creating a branch, editing code, or opening a PR. Emit the `CL Execute Gate
   Result` from [references/result-formats.md](references/result-formats.md).
9. If the gate is not `GO`, or is `GO_WITH_UI_PLAN_APPROVAL` without explicit
   approval for the current plan, stop at the matching planning/blocker result.
10. Confirm every included feature is `IN_PROGRESS` before returning a planning
   wait or starting execution. Do not create ClosedLoop loops.
11. Check repo memory before choosing the approach. Re-check memory before
   writing or revising the plan, before runtime launch, before validation/E2E/
   visual QA, when debugging setup failures, and before PR finalization.

## Discovery Routes

Whenever a step says to find something, ask closedloop-graph first, under
cl-policy's host-capability rules, then verify each result against the current
checkout, live ClosedLoop, or live GitHub before relying on it. The code graph
indexes the default branch only, so this ticket's branch and uncommitted edits
are never in it. Call `sync_status` when freshness could change the answer.

| To find | closedloop-graph first | Verify or fall back with |
| --- | --- | --- |
| Callers and importers of a symbol or file | `code_symbols` to turn a bare name into a repo-qualified path, then `code_callers` (it drops test rows) and `code_importers` | `rg` in the worktree |
| Tests to rerun for a file | repo related-test tooling when you hold the checkout; otherwise `code_tests_for` | `rg` over the test tree |
| A string that is not a symbol (route, config key, flag, event, JSON field, IPC channel, error text) | `code_grep` with its literal fragments joined in one regex alternation | `rg` |
| Blast radius | the code half above plus `blast_radius_tickets` on the repo-qualified path | `git log --follow` |
| Tickets that touched a file | `blast_radius_tickets` | `git log -S`/`-L`, `git blame` |
| One ticket's lineage, branches, PRs, changed files | `ticket_detail` | live ClosedLoop, `gh pr view` |
| Tickets mentioning a keyword | `fts_search` | live ClosedLoop search |
| Related or duplicate tickets | `query_collisions`, then `search_nodes` (paste an unfiled draft verbatim, unfiltered) | live ClosedLoop |
| Whether a ticket was superseded | `ticket_detail`, then `graph_query` on `SUPERSEDES`, `REDUCED_INTO`, and `REPLACES` edges | live ClosedLoop |
| Prior or reverted attempts | `ticket_detail` and `blast_radius_tickets` for earlier PRs and branches on the surface, `fts_search` on the symptom | `gh pr list --state closed`, `git log --grep=Revert`, `git log -S` |
| Why something exists, stated relationships | `search_memory_facts` (quote the returned `fact`) | `git log -S`/`-L`, `git blame`, `gh pr view` on the introducing PR |
| Rollups | `query_shipped`, `query_wip`, `readonly_sql` | live ClosedLoop |

A graph zero is a claim about the query, not about the code. Name the reply
field that makes an absence real (for example `seed_is_indexed_file: true` on
`code_tests_for`); a `found: false` with `unestablished_because`, an
`upstream_truncated` walk, or a 100-row `code_callers` reply is not a complete
answer. Mined or inherited file attributions are not the ticket's own diff.
When the graph is stale, unavailable, or cannot answer, fall back explicitly to
`rg`, `git log -S`/`-L`, `git blame`, and `gh`, and say which route produced
the evidence.

## Phase Summary

- Planning: use
  [references/planning-and-gates.md](references/planning-and-gates.md). Draft
  by loading `plan-structure` by name (`$plan-structure` in Codex or
  `/closedloop-core:plan-structure` in Claude Code), then reading
  `resources/plan_template.md` from that skill's own folder,
  and read that file immediately before drafting or revising. Use
  `mermaid-visualizer` and include scope-explaining Mermaid flowcharts in every
  plan. Run independent plan review, resolve findings, then upload/link/approve
  or wait as gated.
- Support lanes and sweeps: use
  [references/support-lanes-and-sweeps.md](references/support-lanes-and-sweeps.md).
  CLI ticket workers may manage bounded read-only lanes; support agents never
  mutate code, tickets, plans, PRs, CI, review, or communication.
- Implementation, validation, review, and PR: use
  [references/implementation-review-pr.md](references/implementation-review-pr.md).
  Keep edits scoped, validate touched paths, run the two-pass coordinated review
  sequence, remediate contract-compatible findings after each pass, and open/
  update the feature's one integrated PR. After creation, follow
  [references/feature-manual-qa.md](references/feature-manual-qa.md) for the
  owned plan comment and human author session.
- Monitoring, merge, blockers, and completion: use
  [references/monitoring-merge-completion.md](references/monitoring-merge-completion.md).
  Stop passive polling after handoff, recover concrete queue failures without
  review/CI retriggers, and reconcile tickets/plans only after merge evidence.

## Required Outcomes

- `GO`: all gates pass; execute.
- `GO_WITH_UI_PLAN_APPROVAL`: planning may proceed, but plan approval, branch
  creation, code changes, PR work, and merge work wait for explicit human
  approval of the uploaded UI plan.
- Legacy `SPLIT_REPAIR_REQUIRED`: do not execute or split again; return to the
  parent coordinator for single-ticket re-analysis or private human review.
- `PRODUCT_BLOCKED`: route only a concise first-person Product-decision comment
  through cl-policy after Product Answer Discovery proves no existing
  authoritative answer and the Product contact is available; otherwise surface
  exact missing decisions privately to Daniel/current user or the engineering
  attention route.
- `ENGINEERING_BLOCKED`, `ALREADY_DONE_OR_DUPLICATE`, or
  `HUMAN_REVIEW_REQUIRED`: keep engineering/operational detail private and
  surface the required action to the user or parent.

Terminal or handoff statuses are defined in
[references/result-formats.md](references/result-formats.md): `MERGED`,
`PR_MONITORING_HANDOFF`, `BLOCKED_BEFORE_START`, `BLOCKED_AFTER_START`,
`WAITING_UI_PLAN_APPROVAL`, `WAITING_MANUAL_QA`, `WAITING_CI`, `WAITING_REVIEW`,
`WAITING_HUMAN_MERGE`, `CI_FAILED_NEEDS_HUMAN`, `REVIEW_BLOCKED`, and
`MANUAL_INTERVENTION_REQUIRED`.
