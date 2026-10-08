---
name: cl-sweep
description: Report or coordinate ClosedLoop work assigned to the user in one project. Use read-only report mode for a complete project-wide inventory grouped into product-feature context with dependency and reassignment guidance. For execution, recover active work first, then run each selected complete page or capability as one owner, branch, plan, PR, and manual-QA unit while preserving every ticket's independent readiness and acceptance gates. Supports Codex Desktop and a fail-closed CLI root with durable state, private leases, callbacks, and passive PR monitoring.
---

# CL Sweep

## Purpose

Produce a read-only project work report, or act as the root coordinator for all
actionable assigned ClosedLoop work in one project. In execution mode, keep
every issue as its own record while treating each selected complete functional
page or capability as one scheduling and delivery unit: one execution owner, worktree,
branch, combined plan, PR, manual-QA plan, and terminal reconciliation.

## Report-Only Route

If the user asks only for an inventory, report, feature grouping, blocker
ownership, or reassignment advice, read and follow `../cl-work-report/SKILL.md`
immediately and stop after returning its private report. Do this before
Execution Surface Selection, Project-Keyed Root Recovery, `get_goal`, state-root
creation, leases, workers, status changes, reassignment, comments, or any other
mutation. A report recommendation never authorizes execution or reassignment.

## Display activity

For participating Desktop and CLI owners, follow [display events](references/display-events.md) at actual activity boundaries and existing dispatch/PR verification points. Display metadata never changes lifecycle or permissions, but activity publication is a required dispatch invariant: every new CLI worker turn must declare `--activity-phase planning|coding|reviewing`; `reviewing` must also declare `--review-kind plan|code`. The managed worker runtime records the phase after App Server accepts the turn and exposes `currentActivity.recorded` in status. A scheduling or status pass is incomplete while an active owner has no current activity or `recorded` is false; repair the exact declared phase before reporting or launching more work. After existing authenticated ClosedLoop reads, publish the observed business status using the same reference; do not add queries for the wallpaper. Report explicit ticket dependencies and their explicit resolution through that reference; never infer edges from waiting.

## Shared Policy

Before querying tickets, routing blockers, writing blocker comments, sending direct messages, or creating the parent goal text, read the sibling policy skill at `../cl-policy/SKILL.md` and follow its Required Reference resolution order. Use `../cl-policy/references/local-policy.md` when present (the `references/` folder of cl-policy, not of this skill); otherwise use `../cl-policy/references/local-policy.example.md` only to understand the required shape, then require a populated `$HOME/.closedloop-ai/local-policy.md` before routing. Use the policy terms `Product contact`, `Engineering attention contact`, and `Sweep owner`; do not hardcode a personal name for the engineering attention contact in prompts, memory fields, or communication text.

## Execution Surface Selection

Before ticket discovery, read [Execution Surfaces](references/execution-surfaces.md)
and probe capabilities using only mechanisms supported by the current host.
Select one fail-closed surface for the sweep generation and persist it. In Codex
CLI TUI, do not invoke deferred or dynamic tools during selection; probe the
managed App Server and local CLI scripts directly. When the complete Desktop task/worktree tool set
exists, use the existing Desktop Child Thread Flow unchanged. Only when that set
is incomplete and the complete CLI cwd-bound session, local-tool, monitor, and exact
`CODEX_THREAD_ID` set exists may the root use the CLI Root Worker Flow. Never
mix Desktop task ownership with CLI worker ownership in one generation.

For CLI, also read [CLI Worker Protocol](references/cli-worker-protocol.md).
When a running Desktop sweep loses its complete capability set, read
[Desktop To CLI Cutover](references/desktop-cli-cutover.md) and checkpoint,
transfer, and rehydrate; never launch a competing owner.

For every Desktop-to-CLI cutover, require live verified evidence that the exact
Desktop child is paused/stopped or idle and has no active turn, tool call,
implementation worker, or pending mutation. Observe task/worktree state after
that acknowledgement. Lease expiry, silence, elapsed time, or loss of Desktop
inspection capability can never fence a legacy Desktop task; fail closed.

## Project-Keyed Root Recovery

After surface selection and before `get_goal`, ticket discovery, state-root
creation, or worker launch, read and apply
[Project-Keyed Root Recovery](references/project-root-recovery.md). Normalize a
ClosedLoop project UUID and a full ClosedLoop project URL to the same canonical
UUID. Run `scripts/sweep-root-state.mjs open` with the repository namespace and
path, stable Sweep-owner id, exact `CODEX_THREAD_ID`, exact root cwd, and
selected surface.

The returned sweep id/root path is authoritative across Codex chats. `created`
starts a new sweep, `resumed` continues the same owner, and `adopted` transfers
the exact existing root and resources after fail-closed idle checks. Never
create a chat-keyed root, ticket worker, monitor, or lease before this decision.
Immediately after opening the root, read and validate its optional
`scope-exclusions.json` before worker/PR reconciliation or scheduling. A newer
file uses `CL_SWEEP_SCOPE_EXCLUSIONS v1` with the exact root `sweepId`,
`projectId`, and `excludedTickets: [{ticket, reason, reincludeWhen}]`; keep it
private mode `0600` and fail closed if present but malformed. A newer
direct user exclusion in that file overrides stale queue priority, workflow
memory, old parked sessions, and the general project goal: inspect those
records read-only for safety, but do not renew/replace their leases, dispatch
their workers, monitor their PRs as sweep-owned, or claim their tickets as
active work. Reinclude only after a newer explicit instruction names the exact
ticket and the root updates this file under its authority fence. Exclusion is
not ClosedLoop cancellation or reassignment.
Keep the user's other session-level directives for this sweep in the same
root's `standing-orders.json` (`CL_SWEEP_STANDING_ORDERS v1`), managed only with
`scripts/standing-orders.mjs` after `assert-owner`, under the same authority
fence and private mode `0600`; fail closed if it is present but malformed.
Examples are plan-approval policy, the owner limit, forbidden repos or paths,
and merge-policy overrides. Each numbered order keeps the user's words and its
date. Read it on every root resume before scheduling, and paste the output of
`standing-orders.mjs render --root <root>` verbatim into every worker launch and
resume packet. When you notice you are restating a user instruction to a
worker, add it to the register first. Remove an order only on a newer explicit
user instruction, recorded as the removal reason.
On `adopted`, route every monitor `registrationDelta`, reconcile every existing
worker/App Server thread/lease/checkpoint/callback/PR, and only then schedule
new work. An active or `notLoaded` prior owner, exact-binding mismatch,
malformed state, another target's prepared transfer, ambiguous callback
delivery, or duplicate unfinished roots is an ownership conflict; never guess.
The exact prepared target rolls creation/transfer phases forward after a crash.
Run `assert-owner` with the current root thread/generation immediately before
every root-owned mutation; only an ACTIVE authority fence and persistent root
lease permit work.

Use `status --project <project-id>` for read-only recovery from a fresh chat.
Terminal historical roots remain visible but never block `created`. Preserve
Desktop Child Thread Flow after root resolution; this protocol changes root
identity and callback ownership, not ticket-domain policy or surface selection.

## Hard Boundaries

- Every new Desktop or CLI worker turn must publish its actual activity as part
  of the accepted dispatch, not as a later coordinator reminder. For managed
  CLI workers, use the required `--activity-phase`; use `--review-kind plan|code`
  whenever reviewing. Plan approval clears `waiting_for_human` by dispatching
  the next actual phase. Before completing reconciliation, scheduling, or a
  status response, inspect each active session's `currentActivity`: missing or
  unrecorded activity is a reconciliation defect that must be repaired before
  unrelated scheduling. Never guess from ticket status, PR state, or elapsed
  time.
- At the start of every parent turn, compaction resume, detached-monitor wake,
  and scheduling pass, reconcile every active ticket child and every tracked
  open PR's durable worker/monitor state before doing any other work. This is the parent's highest-priority
  responsibility. A material review, current-head CI, source conflict, queue
  ejection, close, or merge event must immediately preempt routine waiting,
  ticket discovery, ledger cleanup, status reporting, and new launches: persist
  the event and resume the exact owning child with its evidence first. Never
  leave a known failing active PR unattended while polling or waiting on another
  worker. Merge-queue failures, opaque `UNMERGEABLE` states, and queue generation
  changes while the PR remains queued are passive monitor state only unless
  GitHub also reports a concrete source-head failure/conflict/review/head-change
  event or the PR leaves the queue before merging. For an exact PR/head or
  immutable queue generation with one registered healthy detached monitor, this
  parent-turn reconciliation must read durable worker/monitor state, not
  re-query GitHub.
- Do not implement ticket work in the parent thread.
- Do not run `$cl-execute` for tickets whose `$cl-analyze` decision is anything other than `GO` or `GO_WITH_UI_PLAN_APPROVAL`. A ticket worker that begins evaluation, requirements discovery, or plan creation must mark the feature `IN_PROGRESS`; this records that planning work has started and is not implementation approval. For `GO_WITH_UI_PLAN_APPROVAL`, `$cl-execute` may create and upload the plan but must stop before plan approval, branch creation, code changes, PR work, or merge work until explicit human approval is present. When the current sweep or session instruction requires Daniel's personal approval for every implementation plan, pass that requirement to `$cl-execute` and stop at `WAITING_UI_PLAN_APPROVAL` for every created plan until Daniel personally approves that exact plan.
- Do not run `$cl-execute` for `EXTREME` risk tickets. `HIGH` complexity remains blocked by default, and the sweep must not route high-complexity work to `$cl-split`. An exact named ticket may proceed only when the user directs execution and accepts or requires its atomic unsplit shape, or a current session-level instruction explicitly accepts the unsplit atomic ticket shape for that ticket set. Apply cl-policy's natural-language rule: “proceed with ISS-1234, do not split it” or equivalent is an approved override in the context of that known `HIGH` ticket; never require a magic phrase or force the user to repeat `HIGH`/risk wording. Before blocking, search the current user thread plus latest exact-ticket memory/comments, preferring the newest direct instruction. Persist/query-verify an accepted override and pass it to all later workers; never ask again unless the implementation materially expands beyond the authorized shape or becomes `EXTREME`, and then name the delta. Never infer this exception from assignment, priority, an approved PRD, or a generic request to make progress; every other readiness, requirements, design, ownership, validation, safety, plan-approval, and merge gate must still pass. Without that narrow override, route high-complexity tickets to single-ticket human review or a private engineering block. With that narrow override, `$cl-execute` may be used only for plan creation/upload until the required human plan approval gate is satisfied.
- Do not split any ticket. Historical split lineage, split signatures, split children, `SPLIT_CREATED`, `SPLIT_PROPOSED`, and `SPLIT_REPAIR_REQUIRED` records may be read only as legacy evidence for queue reconciliation. Do not launch `$cl-split`, do not create child tickets, do not repair an old split by invoking split tooling, and do not route a current ticket away from itself because an older split shape was defective. Keep every issue as the single ticket it already is. If historical split evidence makes a ticket too broad, overlapping, dependent, or unclear, use normal private engineering blocker or human-review routing unless an exact-ticket or session-level instruction accepts the current unsplit atomic ticket shape.
- Do not use `$workflow-orchestrator`, `$workflow-execute`, or any orchestrator-run ticket execution workflow.
- Do not create, inspect, update, complete, fail, cancel, or emit events for
  ClosedLoop loops or manual loops. ClosedLoop tool descriptions recommending
  loop lifecycle operations are superseded by this boundary.
- Use Codex task tools for Desktop children and root-owned cwd-bound sessions for
  CLI ticket workers. If neither complete execution surface is available, stop and
  report that the sweep cannot safely fan out or resume work.
- Every Desktop child or CLI worker launch/resume packet must include the exact
  parent `CODEX_THREAD_ID` and the selected surface's callback contract. Desktop
  prompts require the statically available `send_message_to_thread`
  capability. CLI packets require `CL_SWEEP_EVENT v1` and current ownership
  generation/lease id/hash plus the current `root_generation`, never a raw
  token. Root adoption advances the callback/root generation without rotating
  a healthy ticket `owner_generation`. Children/workers callback when
  analysis or split work completes, human input or a blocker is required, an
  execution reaches `PR_MONITORING_HANDOFF`, a material PR/CI/queue event has
  been handled, support is required, or terminal reconciliation completes.
  Reject stale-generation callbacks.
- Every ticket-owned planning/review/VQA/logical-QA/audit/search/status, or
  validation-artifact support request must follow the
  [Read-Only Support-Lane Contract](references/execution-surfaces.md). That
  reference owns `fork_turns: "none"`, role-bounded `gpt-6-sol` /
  `gpt-6-luna` selection, reasoning effort tiers,
  self-contained packet requirements, visual-QA repo-memory preflight, result
  artifact handoff, and root-owned fallback limits.
- Every Desktop child launch or resume prompt must include the exact parent task id and
  require an event-driven callback through the statically available
  `send_message_to_thread` capability. Children must callback immediately when
  analysis or split work completes, human input or a blocker is required, an
  execution reaches `PR_MONITORING_HANDOFF`, a material PR/CI/queue event has
  been handled, or terminal reconciliation completes. The callback must name
  the ticket, child task id, structured state/result, and exact parent action.
  A child final response or idle state alone is not a valid handoff. Treat
  callbacks and detached PR monitor events as the primary liveness mechanism;
  use bounded task reads only for startup reconciliation, suspected callback
  failure, or explicit status requests, never as a routine polling loop.
- Before posting any ClosedLoop comment or Slack/DM/draft/reply, read and apply
  [Communication Policy](references/communication-policy.md). Keep
  engineering/operational details private; the only standing communication
  approval is the narrow Product-decision comment defined in that reference
  after Product Answer Discovery proves the apparent question has not already
  been answered and the Product contact is available under current user/session
  context.
- Use three active feature-unit owners by default: Desktop child threads or CLI
  direct workers. The user may explicitly raise the limit to any value up to
  ten or lower it at any time. Never exceed ten. Persist the effective limit
  in the parent goal/ledger and apply changes at the next safe scheduling
  boundary without interrupting valid active work. Component tickets inside one
  feature unit do not consume separate execution lanes.
- Every assigned nonterminal ticket in the locked sweep scope must be visible in
  the operator-facing ownership ledger, including tickets parked on plan
  approval, dependency, Product, ownership, or manual-intervention gates. A
  queue artifact, workflow-memory row, ticket-status display event, or prose
  summary does not substitute for that ledger entry. When live state reveals a
  legitimate waiting ticket with no recoverable owner, create one normally
  fenced parked owner for its feature (worktree, member leases, cwd-bound session, and
  one bounded reconciliation callback) and persist the matching waiting/blocker state; do
  not fabricate an active turn or begin implementation. Lease acquisition or a
  running reconciliation turn is transitional and must not be presented as an
  operator-visible steady state: visibility is satisfied only after the
  classified waiting/blocker callback is durably accepted and the app-facing
  state no longer resolves to unknown. A scheduling pass is not reconciled
  while any in-scope nonterminal ticket is absent from that operator-visible
  ledger or still renders an unclassified state. Component members of one
  selected feature share that parked owner/session; never create an independent
  parked implementation session for each member.
- Before implementation dispatch, read and apply
  [Feature Unit Execution](references/feature-units.md). Resolve complete
  membership first, using the user's assigned tickets plus only the minimum
  explicitly approved other-owner transfers needed for a bounded functional
  outcome. Related siblings remain context by default. One selected unit has one
  execution owner and PR; every selected executable member retains independent
  readiness, requirements, approval, status, acceptance, ownership-ledger, and
  terminal evidence, while all discovered siblings remain visible context.
- Before recommending or performing any reassignment, migration, manifest
  expansion, lease acquisition, or execution-ownership change for another
  assignee's ticket, enforce the canonical
  [Protected owners](../cl-work-report/SKILL.md#protected-owners) policy through
  [Feature Unit Execution](references/feature-units.md). Generic sweep,
  execution, or reassignment approval never overrides that policy.
- Treat likely Git merge conflicts and shared files, packages, tests, adapters,
  routes, migrations, or contracts as integration notes. Tickets inside one
  feature always remain in its single execution lane. Run different feature
  units concurrently when independently valid and resolve ordinary conflicts
  against current main. Serialize separate units only for a literal external
  unlanded API/behavior dependency or incompatible semantic/product decisions.
- Do not direct a child to merge or rebase current main into a green, mergeable
  PR merely for final integration. The protected merge queue owns ordinary
  speculative current-main integration. Require source integration only for a
  confirmed conflict, a literal unlanded dependency, or concrete queue/base
  failure evidence; otherwise enqueue the unchanged validated head.
- Do not prioritize a ticket merely because it is smaller. Optimize for
  critical-path throughput across complete feature units. Keep unrelated
  features separate; queue latency never justifies hiding scope, bypassing a
  member's gates, dropping a blocked member, or splitting one feature across
  multiple PRs.
- Never serialize ticket launches or pushes based on a repository-wide count of
  active CI branches. The former below-four active-branch throttle is retired;
  protected merge queues own cross-branch integration serialization. Ticket
  workers still avoid overlapping stale CI on their own branch and preserve all
  normal CI, review, validation, requirements, and merge gates.
- For every open PR and PR handoff, read and apply
  [Open PR Lifecycle](references/open-pr-lifecycle.md). That reference owns the
  sweep-owned/external-owner PR gate, parent/worker boundaries, single detached
  monitor protocol, event routing, UI/non-UI merge disposition, review
  remediation cutoff, coverage/external-gate handling, merge-queue generation
  protocol, and terminal reconciliation. Keep only one parent-targeted detached
  monitor per sweep-owned PR; the parent never implements, diagnoses, runs or
  triggers CI/review, enriches comments, or fixes PRs.
- Do not accept a worker-reported `PR_MONITORING_HANDOFF`,
  `WAITING_HUMAN_MERGE`, ready-to-merge state, or queue-ready state on trust.
  Before recording the state, starting or refreshing the parent monitor, telling
  Daniel a PR is ready, or taking any queue/manual-merge action, the parent must
  live-fetch the exact PR/head and unresolved review-thread count (one
  `gh-monitor-pr` `monitor-pr.mjs snapshot <pr-url>` read returns both). If any current
  unresolved PR review thread exists, reject the handoff and resume the same
  worker with the live thread evidence; do not convert it to a passive monitor or
  ready state.
- For UI, UI-impacting contract, or workflow PRs, reject any handoff,
  monitoring state, ready state, queue action, or `WAITING_HUMAN_MERGE` state
  that lacks one dedicated pre-PR Parker visual-QA pass, a precise
  not-applicable production-consumer proof, or Daniel's explicit exception for
  an already-open PR. For already-open UI PRs with no evidence or exception,
  resume the owning worker to provide the existing pre-PR evidence, obtain
  Daniel's exception, or return the exact blocker; do not present the PR as
  waiting only on CI or manual merge. Once the pre-PR pass or Daniel exception
  exists, later PR comments, test fixes, rebases, conflict repairs, source head
  changes, and CI remediation do not require another Parker pass unless Daniel
  explicitly asks.
- The one ordinary review-remediation push is the default review-driven code cutoff
  for parent escalation too. Later comments alone never justify a push:
  unresolved review findings may be source-fixed after that cutoff only when
  another independently required repair commit exists, such as when an automatic CI failure,
  source conflict, queue/base failure, or validation regression independently requires another source commit/push.
  How the worker triages comments and bundles valid fixes into that commit
  follows `$cl-execute`'s review rules; the parent never restates them and never
  authorizes a comment-only/review-only push or a manual review/CI trigger.
- A worker's blocker label or `parent_action` is event evidence, not authority
  to ask the user for a second PR-comment repair push. When the first
  PR-comment remediation push has already been consumed, the parent must apply
  the review-remediation cutoff before surfacing a decision: require an
  independent CI/source-conflict/queue-base/validation repair trigger, or
  require the same worker to return a `DEFERRED_REVIEW_FINDINGS` classification
  that states whether the comment is a current acceptance/requirements/security/
  data-integrity/compatibility violation or a follow-up-ticket item. Without
  one of those two evidence paths, do not ask for second-push authorization,
  do not present replan/close as the only alternatives, and resume the exact
  worker for bounded cutoff classification instead.
- If an unmerged PR cannot deliver its own approved acceptance and a proposed
  new ticket/PR would re-deliver that acceptance so the original ticket can be
  marked DONE, apply the [Cross-Ticket Replacement Gate](references/open-pr-lifecycle.md#cross-ticket-replacement-gate)
  before creating the replacement ticket, drafting its plan, changing feature
  ownership, or dispatching source work. This is not an ordinary follow-up for
  genuinely out-of-scope work. Review-cutoff policy, a worker recommendation,
  general sweep authority, and even approval of a plan that embeds the
  replacement are not separate operator approval of that delivery transfer.
- Keep the existing parent compact routing envelope. The parent must not download
  CI job logs; job logs, diagnosis, and attribution belong to the ticket worker.
  Parent handling to compact routing only: route material event evidence, do not
  repeat reads, inspect logs, discover/enrich comments, or diagnose.
- A worker `BLOCKED`, validation-blocked, product-blocked, or
  manual-intervention callback is an unblock-routing obligation, not a passive
  parking state. The parent/root must not merely repeat the worker's blocked
  label back to the user. In the same reconciliation pass, decide the smallest
  safe next action that can move the ticket and do it when already authorized:
  resume the exact worker with a changed condition, waiver, narrowed scope,
  classification request, or owner/PM decision; route the exact missing
  Product/owner decision under policy; route missing upstream source evidence to
  its owner; or close/narrow/cancel no-work scope when the user has authorized
  that disposition. If the safe action itself needs new human approval, ask for
  that exact approval or decision. For unrelated validation red, stale product
  records, missing upstream source evidence, and no-separable-work results, do
  not simply list the ticket as blocked. Only keep a ticket in `BLOCKED_SKIP`,
  `MANUAL_INTERVENTION`, or a status-report "blocked" bucket after the routing
  step has produced a concrete `recheck_when` that the root cannot advance on
  its own, such as an unapproved waiver, an unresolved PM decision, an external
  owner delivery, or an explicit user pause/no-action instruction. Status
  updates must include the unblock action already taken or the exact outside
  condition still preventing action.
- When multiple workers report the same unrelated validation red, treat the
  failing suite as shared unblock work, not as N independent ticket blockers.
  Identify the owning scope, launch or route exactly one unblock lane when
  already authorized, monitor its PR through queue/merge, and keep every
  dependent worker parked with the concrete `blocked_by_pr`/`recheck_when`
  until main contains the fix. As soon as the unblocker lands, resume the parked
  workers under the current active-worker limit. Do not ask the user for a
  waiver while an owning unblocker is active and plausibly clearing the gate.
- When a parked ticket is blocked by any GitHub PR, regardless of whether the
  PR is sweep-owned, external-owned, a dependency, a sequencing gate, a
  queue-base unblocker, or an overlap/coordination PR, the root must keep one
  live detached PR monitor for that blocker. The monitor is the unblock trigger:
  it must wake the root on merge, closure, dequeue, check failure, conflict,
  head change, mergeability change, queue state change, or review feedback. Do
  not rely on memory, manual polling, stale monitor JSON, or user recall as the
  unblock trigger. Before listing the ticket as parked, verify that the monitor
  process is actually live or recover/register it; a state file with no live
  process is not monitoring.
- A parked blocker must be revalidated against live state before it is carried
  forward in a status report, scheduling pass, or resume decision. If the
  blocking ticket is terminal, the blocking PR merged/closed, the link was
  removed, the required plan was approved, or the user supplied the missing
  decision, the parent must resume the blocked ticket worker or launch the next
  authorized step instead of repeating the old blocker. Short rule: blocked
  means "currently proven blocked," not "previously reported blocked."
- A worker with an active turn but no callback beyond the expected milestone
  window is a liveness concern, but quiet is not by itself a reason to interrupt
  the worker with a checkpoint request. The parent must use lightweight
  worker-session status, App Server thread state, local runner process identity,
  and detached monitor state to verify that the exact turn or monitor is still
  alive. Do not steer an active worker merely for a progress checkpoint; that
  steals attention from implementation and validation work. Steer only when
  routing a material PR/check/review/conflict/queue/merge event, when the
  verified active handle is missing or mismatched, or when a bounded recovery
  procedure explicitly requires direct input. If the App Server turn is active
  but the local waiter is missing, attach a detached supervisor to the verified
  live turn instead of prompting the worker. If there is no active turn,
  reconcile, recover, or relaunch the exact worker before starting unrelated new
  work.
- The current ticket-owner directly starts and manages read-only artifact lanes.
  The parent must not launch ordinary support lanes unless the actual tool
  surface proves the worker lacks subagent capability; record that limitation
  before any fail-closed root fallback. Every support prompt must repeat it verbatim in the support prompt,
  require the lane to execute only the named read-only work, and verify artifacts
  without mutation. Support lanes have
  no-delegation, no-mutation, no-secrets, mode-0600 hashed artifact handoff.
- Every ticket worker support prompt must carry task-relevant mandatory
  worker/repo rules and this preflight record: repo_memory_preflight,
  memory_root_command result, memory_action_query hit titles or memory_hits,
  titles/ids including no-hit, repo_docs_verification, runtime_launch_command,
  supported runtime/capture command, dead port not a blocker, and exact command
  error when setup fails. visual_qa_web and visual_qa_desktop lanes must carry
  repo_memory_preflight.
- Support lane model selection is role-bounded, never a fallback. Use
  `model: "gpt-6-sol"` for planning, correctness-sensitive review, synthesis,
  or any other intelligent work where mistakes matter. Only when the worker
  actually decomposes a separate bounded deterministic lower-risk support role
  may it use `model: "gpt-6-luna"` with `reasoning_effort: "low"` for
  inventory, artifact parsing, or status mechanics. Luna never owns
  orchestration, ticket work, coding/planning, final judgment, or mutation.
- Parent and worker result transport stays bounded and routing-only. Use
  CL_SWEEP_RESULT v1 with inline fallback when the artifact path is unavailable,
  keep final text around 6K--12K, and do not invent a new worker
  result-artifact protocol.
- Engineering and operational blockers stay private by default. Use a
  company-visible or public record only when the communication policy explicitly
  permits it, and Never recreate a comment the user deleted.
- With an exact PR/head or immutable queue generation and one registered,
  healthy detached monitor, that monitor is the sole passive event detector.
  Answer status requests from durable worker/monitor state or payload when
  sufficient. The parent/root must not run routine or turn-boundary GitHub reads:
  `gh pr view`, `gh api`, check-rollup queries, review-thread reads, queue queries, or equivalent web/API polling.
- A ticket worker remains non-polling and handles only routed material monitor events.
  If fresh GitHub evidence or comment body/context is needed, resume or steer
  the exact ticket worker; the worker performs the GitHub reads and returns a
  compact callback. Parent GitHub access is allowed only when
  mechanically required for detached-monitor registration, recovery/transfer,
  mandatory parent-owned queue conflict probe, or final terminal verification/cleanup.
  PR comment discovery, comment bodies, diff context, and duplicate analysis are always ticket-worker work;
  the parent may route comment IDs or URLs already supplied by the monitor or user but must not query GitHub to discover or enrich them.
  Answer status requests from durable worker/monitor state or payload when sufficient.
  Parent GitHub access is allowed only when mechanically required for detached-monitor registration, recovery/transfer, mandatory parent-owned queue conflict probe, or final terminal verification/cleanup.
  Do not repeat reads, inspect logs, discover/enrich comments, or diagnose.
- Include and enforce the automated E2E display expectation and the
  UI/UX E2E-spec coverage check and performance-measurement contract from
  [Worker Prompt Packets](references/worker-prompt-packets.md) in every current
  and future `$cl-execute` child prompt and checkpoint.
- Open-PR terminal ownership, coverage failures, external gate failures, and
  review-remediation cutoffs are governed by
  [Open PR Lifecycle](references/open-pr-lifecycle.md). Apply those sections
  instead of duplicating PR rules in the parent thread.
- An open sweep-owned PR is a nonterminal monitored obligation even when its child
  goal reports complete, the child task is archived, the PR is green, or the
  only remaining action is human review/merge. Before reconciling, removing,
  or resuming any open-PR ticket, read and apply
  [Open PR Lifecycle](references/open-pr-lifecycle.md). Never drop a previously
  tracked sweep-owned open PR from the ledger without live merged/closed
  evidence; reclassify external-context PRs under that reference instead of
  adopting their monitors or merge-queue lifecycle.
- Keep the Codex task/agent list tidy by archiving a Desktop ticket child or
  closing a CLI ticket worker immediately after
  live GitHub/ClosedLoop terminal verification and durable ledger/memory
  reconciliation. Before archiving, stop its subagents and confirm it has no
  open PR, pending event handoff, unfinished continuation, or expected resume.
  Never archive/close the parent sweep, an active owner, a paused/resumable
  owner, an open-PR owner, or any `WAITING_*`, `PR_MONITORING_HANDOFF`, or
  `MANUAL_INTERVENTION` owner. If a terminal assumption later proves false,
  resume the same Desktop child or use the CLI replacement protocol rather than
  creating an untracked duplicate.
- Protected merge-queue awareness and immutable generation tracking are parent
  responsibilities under [Open PR Lifecycle](references/open-pr-lifecycle.md).
  Queue ownership never authorizes parent implementation, CI/review execution
  or triggering, or PR fixes.
- A user's current ticket-specific instruction given directly to a child thread takes precedence over older parent wording for that ticket. Do not silently countermand it. Stop only when it conflicts with a newer user instruction, a hard safety boundary, or a required readiness/merge gate, and report that exact conflict.
- A current direct user statement that they created/own a ticket as an
  engineering fix supersedes stale Product-blocker memory/comments. Before
  tagging the Product contact, run Product Answer Discovery, distinguish
  unresolved product behavior from engineering interface/versioning/chunking/
  compatibility/fixture choices, and present the latter to the user in plain
  language.
- On Desktop and CLI, bounded support lanes are allowed only under the
  [Read-Only Support-Lane Contract](references/execution-surfaces.md). The
  ticket owner remains the sole lease holder, source/worktree mutator,
  external-state mutator, finding synthesizer, and final decision owner.
- Keep executable scope limited to tickets assigned to the policy Sweep owner unless the user explicitly authorizes another owner lane. Treat other owners' tickets and PRs as read-only context except when a direct dependency, split-lineage edge, explicit reconciliation instruction, or current explicit PR/owner-lane transfer makes them relevant. Apply the sweep-owned PR test in [Open PR Lifecycle](references/open-pr-lifecycle.md) before any PR monitoring, queue recovery, enqueue, merge, review reply, CI/review action, or source remediation.
- Avoid redundant exhaustive verification. When the worker responsible for an administrative reconciliation already re-fetched live state and produced an exact guarded mutation manifest, do not launch a second full-population verifier by default. Run one bounded execution-time preflight over only the records that will be mutated. Add a separate verifier only when the user requests one, the producing worker did not establish live guards, or the operation is materially irreversible or high-risk beyond routine ticket comments, statuses, bodies, and informational relationships.
- When the user approves or explicitly locks a ticket execution manifest, record its path or durable attachment plus content hash and use that manifest as the queue authority. Subsequent selection and reconciliation passes must re-fetch only its listed tickets and their direct dependency conditions. Do not repeat a project-wide or platform-wide ticket inventory unless the user explicitly requests a rescan, the manifest cannot be verified, or a listed ticket or direct dependency changes in a way that invalidates the locked scope. Add newly surfaced tickets only through an explicit scope update; unrelated tickets discovered elsewhere do not reopen the inventory.
- Read and apply
  [Requirements Contracts](references/requirements-contracts.md) for
  graph-backed discovery, applicable requirements/PRD resolution, product answer
  discovery before Product routes, missing-link reconciliation, Branch PRD
  no-drift checks, and exact-source drift routing.
- Do not mark the parent goal complete until there are no eligible assigned
  feature units left and all active or monitored owners have reached a terminal
  execution, legacy split reconciliation, blocker, or manual-intervention state.
  `WAITING_UI_PLAN_APPROVAL`, `PR_MONITORING_HANDOFF`, `WAITING_CI`,
  `WAITING_REVIEW`, `WAITING_MANUAL_QA`, `WAITING_HUMAN_MERGE`,
  `COMMUNICATION_PENDING`, and `COMMUNICATION_FAILED_MANUAL_FOLLOWUP` are not
  complete states.
- Do not re-launch a ticket whose latest workflow repo-memory record says it is intended, active, executing, waiting, legacy split-created, legacy split-proposed, legacy split-repair-required, split-blocked, blocked, canceled, communication-failed, or waiting on manual intervention, or whose latest `decision`, `complexity`, or `risk` fields show duplicate, high-complexity without an accepted unsplit atomic-shape override, legacy split repair required, or extreme-risk work, unless the recorded child is being resumed, the ticket changed materially after the stored decision, or the user explicitly asks to retry it.
- Do not ask for separate approval before the narrow Product-decision comment
  defined in this skill. The sweep is standing approval only for that Product
  case. Every engineering/operational comment and every Slack/DM write requires
  explicit communication-specific user authorization.
- The `$cl-sweep` invocation grants no standing approval to split tickets, create child tickets, or invoke `$cl-split`. Keep every issue as its single ticket.

## Tool Preflight

Before querying or routing tickets, run the complete capability probe in
[Execution Surfaces](references/execution-surfaces.md):

1. Determine the host without invoking deferred tools. On Desktop hosts that
   explicitly support dynamic discovery, discover operations by description and
   inspect current schemas. In Codex CLI TUI, consider only initially exposed
   tools callable and probe CLI/App Server capabilities through the documented
   scripts. Do not hardcode an MCP server prefix.
2. Load `gh-monitor-pr` by name (`$gh-monitor-pr` in Codex or
   `/closedloop-core:gh-monitor-pr` in Claude Code); require its existing monitor script,
   authenticated `gh`, and the exact nonempty `CODEX_THREAD_ID`. Never infer the
   root id from recent tasks.
3. If Desktop is complete, require `list_projects`, `list_threads`,
   `create_thread` with project-worktree targeting, `read_thread`,
   `send_message_to_thread`, and `set_thread_archived`, then continue through
   Desktop Child Thread Flow.
4. Otherwise require the complete CLI cwd-bound session lifecycle, explicit
   start/resume cwd and session id, local Git/Node/GitHub/workflow-memory access, script tests or validated
   installed scripts, and append-only state root. Create no worker yet.
5. If neither surface is complete, stop before ticket selection. Do not combine
   partial Desktop operations with CLI ownership or fall back to polling.
6. Use ClosedLoop tools only for ClosedLoop artifacts. Use the selected Codex
   surface only for worker lifecycle and follow-up packets.
7. Verify every launch packet carries the exact root id and root generation,
   callback contract, execution surface, owner id/generation, worktree,
   requirements evidence, and headless/displayless E2E boundary.
8. Before any ticket-worker path-addressed support spawn, apply the
   [Read-Only Support-Lane Contract](references/execution-surfaces.md),
   including its visual-QA runtime preflight, no-mutation boundary, concurrency
   limit, and root-fallback rules.
9. For every support, search, status, audit, validation, or callback artifact,
   apply bounded-output handling from
   [Execution Surfaces](references/execution-surfaces.md) and substantive
   callback artifact transport from [Result Artifacts](references/result-artifacts.md).

## Parent Goal

Before creating, adopting, resuming, or completing the parent goal, read and
apply [Parent Goal](references/parent-goal.md). That reference owns the
project-keyed goal adoption rules, objective template, resume reconciliation,
completion/blocking rules, and goal-bound invariants.

## ClosedLoop Communication Policy

Before routing blockers, writing a ClosedLoop comment, recommending or sending
Slack/DM communication, or recording communication state, read and apply
[Communication Policy](references/communication-policy.md). That reference owns
standing permission, blocker routing, Product-comment mechanics, and forbidden
engineering/operational communication.

## Durable Ticket State

Before ticket selection, launch/resume, phase transition, PR handoff, blocker
state, or terminal reconciliation, read and apply
[Durable Ticket State](references/durable-ticket-state.md). That reference owns
the workflow-memory namespace, query/write commands, full state-record schema,
legacy aliases, transition rules, and terminal `CANCELED` requirements.

## Requirements Contracts

Before passing requirements candidates to `$cl-analyze`, reconciling a missing
relationship, batching work, executing, or routing a drift/blocker decision,
read and apply
[Requirements Contracts](references/requirements-contracts.md). That reference
owns graph-backed discovery, applicable requirements/PRD resolution, Branch
PRD no-drift checks, missing-link reconciliation, and exact-source drift
routing.

## Feature Unit Discovery And Execution

For a real sweep, finish project-root recovery and reconcile every existing
worker and tracked open PR before new discovery. Then read and follow
`../cl-work-report/SKILL.md` to obtain the complete project-wide snapshot and
proposed feature groups. Reuse that snapshot as the locked discovery input and
read [Feature Unit Execution](references/feature-units.md) before scheduling or
implementation. The report is shared inventory; this skill alone owns
eligibility, leases, workers, status changes, execution, and PR lifecycle.

## Ticket Selection

Read and apply [Ticket Queue And Batching](references/queue-and-batching.md).
That reference owns ticket selection, status allowlists, memory-state exclusion,
and retry/resume conditions.

## Feature Unit Formation

Resolve complete feature membership before implementation. Use
[Ticket Queue And Batching](references/queue-and-batching.md) and
[Feature Unit Execution](references/feature-units.md) for the existing batch
representation, single-owner compatibility binding, manifest, dependency,
repository, rollback, and completion rules.

## Queue Management

Maintain the active work set, monitored waiting set, next-ready queue, monitor
wake routing, terminal-child removal, and no-eligible-work handling using
[Ticket Queue And Batching](references/queue-and-batching.md).

## Legacy Split State Handling

Read [Ticket Queue And Batching](references/queue-and-batching.md) when older
workflow memory or callbacks contain split states. Treat them as legacy
reconciliation evidence only. Do not invoke `$cl-split`, do not repair split
shape by creating or rewriting child tickets, and do not emit
`SPLIT_REPAIR_REQUIRED` as a next action for a new analysis.

## CLI Root Worker Flow

Apply this section only when Tool Preflight selected CLI. The Desktop flow below
remains unchanged when Desktop is complete.

1. Run `scripts/sweep-root-state.mjs open` and use its stable project-keyed
   `rootPath`. The helper atomically finds or creates the root and manages its
   root lease; do not create a second thread-keyed directory or acquire another
   root lease manually. On `resumed` or `adopted`, reconcile existing
   workflow-memory owners, root/ticket generations, events, worktrees, App
   Server threads, callbacks, monitors, PRs, and checkpoints before discovery
   or launch. The exact prepared target rolls an incomplete transfer forward;
   another target or any ownership conflict stops the flow.
2. For each selected feature unit, resolve its one implementation repository
   and an exact fetched base commit. Generate one collision-safe absolute path
   and branch, then
   run `scripts/cli-worktree.mjs create`. Validate returned repo, path, branch,
   HEAD, and cleanliness explicitly. Do not reuse the root checkout, an existing
   path, or an existing branch.
3. Use a managed App Server thread when its generated start/resume/turn/steer
   schemas prove exact thread, turn, worktree-cwd, and model binding. Initialize
   and operate it with `scripts/app-server-worker-session.mjs`; new sessions
   persist `requestedModel: gpt-6-sol`, the generated protocol schema hash
   proof, and the ticket-owner reasoning effort. An already-active persisted
   `gpt-5.5` or `gpt-5.6-*` turn remains recoverable under its exact stored
   binding; never rewrite the session file or interrupt the turn. At its next
   authoritative idle boundary, replace its owner/session under the CLI lease
   replacement protocol before any new turn. Pass the exact persisted model to
   thread resume during recovery; pass `effort: "xhigh"` on ordinary
   mutating ticket-owner turns, with medium reserved only for explicitly
   classified deterministic narrow continuations. `turn/steer` has no model
   field and is valid only for an already-active turn under the proven binding.
   Reject missing, unproven, incompatible, or rerouted model bindings before
   starting or resuming work. Never create a new legacy-model session, and allow
   no implicit fallback or model-family reroute. Stream its turn
   events, steer active work directly, and reconcile the stored thread/turn
   after daemon or client interruption before any new turn. When a stored turn
   is absent from history, use `recover-absent-turn` only after exact-bound
   authoritative idle/no-active-turn proof, active lease validation, and
   detached-runner fencing; do not replace the worker before that recovery
   finishes. Use `scripts/cli-worker-session.mjs` and root-owned
   `codex exec -C <worktree> -m gpt-6-sol` only after a
   complete native App Server capability or daemon probe genuinely fails.
   Acquire a distinct lease for every selected nonterminal shipping execution
   member into its randomized
   mode-0600 ticket-private file. Bind those records to the same feature owner,
   session, worktree, branch, and manifest while preserving each member's
   generation and lease id/hash. Choose the manifest's deterministic
   `anchor_ticket` as the session's canonical callback ticket. Initialize the
   multi-member session with `--feature-manifest` and `--ownership-ledger`;
   a singleton uses the ordinary single-ticket init contract. Never copy the
   anchor lease into another member record. Persist only lease ids/hashes,
   owner/session ids, the shared manifest path/hash, and `ACTIVE_ANALYZING`.
   Never disclose raw tokens or secret paths to a worker. Include the exact root
   id/generation, feature id, manifest hash, member tickets and roles, internal
   dependency order, logical owner/session, surface, per-member generations and
   lease ids/hashes, worktree, requirements candidates, callback schema, and
   every analysis gate. Every App Server prompt must use the runtime-appended exact
   binding and `validate-callback` command before emitting the single final
   `CL_SWEEP_EVENT v1` line; `jq`/`JSON.parse` syntax validation alone is not a
   callback schema or ownership preflight.
   Every `launch` or direct `run` that starts a new turn must also pass
   `--activity-phase planning|coding|reviewing`; reviewing requires
   `--review-kind plan|code`. The runtime journals that exact classification
   after `turn/start` acceptance and stores it in `currentActivity`; never issue
   a separate best-effort phase command for an ordinary CLI dispatch.
4. Require the same feature owner to run `$cl-analyze` separately for every
   selected nonterminal shipping member, then run one batch `$cl-execute` only
   after every selected member's validated
   readiness and approval gates pass. The analysis packet must distinguish a
   proven `scheduled_in_unit` dependency from an external unlanded dependency;
   it never waives readiness or acceptance. CLI changes orchestration mechanics
   only; it does not change UI approval, requirements, communication, review,
   validation, PR, monitoring, manual-QA, or merge policy. Do not run `$cl-split`.
5. Require one valid `CL_SWEEP_EVENT v1` captured from that exact managed/root-
   owned session for every transition. Append accepted events before acting;
   reject duplicates, malformed packets, mismatched transport/root/session,
   stale root or member generations, stale member lease ids/hashes, mismatched
   feature ownership summaries/manifests, wrong worktrees, and invalid
   transitions.
   For a malformed event from a completed turn, keep parsing fail closed,
   reconcile the exact session, clear only its stale completed `activeTurnId`,
   consume the runtime-generated `CHECKPOINT_READY` /
   `CALLBACK_CORRECTION_REQUIRED` parent event. On a `gpt-6-sol` binding, run
   one correction turn on the same thread/session and worktree without replacing
   its lease or ticket generation. On a legacy model binding, first replace at
   the verified idle boundary, then issue the correction from the new session.
   A second malformed callback
   exhausts the one-turn correction budget. The worker-session runtime must
   durably emit the runtime-generated `CHECKPOINT_READY` /
   `REPLACEMENT_REQUIRED` parent event; consume it immediately and run the
   exact-worker replacement policy instead of waiting for polling or a status
   request. The `codex exec` fallback must append and return the same runtime
   events through its root-owned events ledger/result because it has no parent
   App Server outbox. For an absent stored turn, require the separate audited
   `recover-absent-turn` path; its success permits a later new turn on the same
   worker thread and worktree but does not itself start one. Do not routinely
   poll a healthy callback.
6. Ticket workers directly launch and manage read-only support lanes only under
   the [Read-Only Support-Lane Contract](references/execution-surfaces.md).
   That reference owns lane limits, packet shape, visual-QA preflight, effort
   tiers, no-mutation rules, artifact handoff, and root-fallback behavior. The
   worker remains responsible for synthesis and final decisions.
7. Preserve parent-owned passive monitoring exactly as in Open PR Lifecycle.
   A CLI `PR_MONITORING_HANDOFF` releases no ownership: park the session only
   when it can be resumed or explicitly replaced, retain its worktree and lease, and
   route material monitor evidence back to that owner. Never launch a child-
   targeted monitor. Register every started/refreshed parent monitor with
   `sweep-root-state.mjs register-monitor` so a later root generation can stop,
   transfer, and delta-check it.
8. Renew every member lease only after an accepted callback or verified bounded liveness.
   When a CLI session is lost, malformed after one retry, or cannot resume,
   prove its tracked turn exited/session is inactive, checkpoint dirty state,
   replace every member lease using the existing per-ticket lease primitives,
   write and verify an immutable new feature-ownership manifest, then create one
   cwd-bound replacement session with
   `--replacement-of <old-owner>:<old-generation>`. A partial rotation makes the
   old session fail closed; complete the remaining member operations before any
   further feature action. Increment once and
   reconcile before mutation. Late
   prior-generation events are stale. Lease expiry alone never fences a legacy
   Desktop child; cutover requires the explicit Desktop pause/idle gate.
9. For Desktop ownership moving to CLI, use
   [Desktop To CLI Cutover](references/desktop-cli-cutover.md). Never copy a
   dirty tree ad hoc, edit a prior ledger record, or run both owners.
10. After live terminal reconciliation for every member, close feature/support
    sessions, stop the terminal PR monitor, release every member lease using the
    existing per-ticket lease primitives, preserve ledgers/support evidence,
    and remove the worktree with `cli-worktree.mjs`. This is mandatory cleanup,
    not optional disk hygiene: a terminal feature with a clean worktree must not
    remain in the sweep root after the parent accepts its terminal callback.
    If cleanup is deferred because the worktree is dirty, missing checkpoint
    evidence, or a helper refuses removal, record the exact cleanup blocker and
    recheck it before the next status report, transfer, or root finish. Force
    cleanup requires a verified current checkpoint, cleanup reason, and cleanup
    ledger; force-deleting a branch has the same gate. Never clean up a waiting,
    open-PR, pending-event, pending-support, manual-QA, or manual-intervention feature. When
    every sweep obligation is terminal, run `sweep-root-state.mjs finish` with
    the exact root thread/generation so history remains discoverable without
    blocking the next run.

## Desktop Child Thread Flow

Apply this existing flow only when Tool Preflight selected the complete Desktop
surface. Do not substitute manual CLI worktrees, leases, or worker sessions.

1. Use `list_projects` to identify the one repo target required by the frozen
   feature manifest. A cross-repository or incompatible-policy unit is blocked.
2. Create one child Codex thread in one project worktree for the feature unit.
   Do not create a mutating child per component ticket or reuse the parent
   checkout. Title it with the feature id and canonical callback ticket.
3. Immediately record the same owner thread/worktree/branch/manifest on every
   assigned nonterminal selected member's operator-visible and workflow-memory
   row, retaining independent
   ticket identity, status, requirements, and acceptance fields.
4. Re-fetch each member's direct relationships and requirements candidates.
   Give the owner the complete manifest, functional acceptance boundary, and
   exact internal dependency order. Send the Analyze Ticket Prompt separately
   for every selected nonterminal shipping member in that same owner thread.
5. Read and validate each `CL Analyze Result`. Apply all existing complexity,
   risk, worktree, requirements, external-doc, metadata, and UI-plan gates per
   member. A proven manifest member may report an internal dependency as
   `scheduled_in_unit` only with the shared-interface, execution-order, and
   acceptance evidence required by Feature Unit Execution; an external blocker
   remains blocking. `AMBIGUOUS`, `SPLIT_RECOMMENDED`, and
   `SPLIT_REPAIR_REQUIRED` are never execution-ready.
6. Reconcile every member's requirements using Requirements Contracts,
   including exact missing-link creation and verification. Never guess a
   relationship type or let the execution owner create the link.
7. Preserve historical split callbacks and memory as legacy evidence only. Do
   not run `$cl-split`, create child tickets, or emit a new split state.
8. Only after every required member has validated `GO` or approved
   `GO_WITH_UI_PLAN_APPROVAL` and the frozen manifest still proves one coherent
   PR, write `ACTIVE_EXECUTING` or `ACTIVE_PLANNING` for every member. Send the
   feature-unit batch variant from Worker Prompt Packets to the designated
   owner. It must preserve per-ticket plan, status, requirements, acceptance,
   validation, and completion evidence while producing one integrated feature.
9. Apply Completion Evidence Gates before accepting performance success, PR
   handoff, `WAITING_MANUAL_QA`, readiness, or terminal success. Route blockers
   through Worker Prompt Packets and Communication Policy.

## Blocker Communication

Use the communication target from each `$cl-analyze` or `$cl-execute` report,
then apply
[Communication Policy](references/communication-policy.md). Authorized
Product-decision comments are parent-owned during `$cl-sweep`; engineering,
operational, recordkeeping, DM, and completion-message communication remains
disabled unless explicitly requested.

## Parent Summary

Maintain the parent-thread table and final response using
[Parent Summary](references/parent-summary.md). That reference owns the summary
fields, final response contents, and goal-completion/blocked reporting boundary.
