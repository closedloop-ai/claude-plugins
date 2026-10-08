# Quality before handoff

This is the shared workflow for app and owned prototype sessions. Each session
has one worktree, one branch and one persistent implementation writer:
`vibe-change-worker`. Keep that underlying worker/session ID and resume its
context for every request, correction and handoff. Never create feature-unit
branches, worktrees or replacement source writers.

## Communication and product questions

Do not show or ask the person to approve a technical plan, ask a technical
question, or give an upfront summary. Updates say only which requested feature
is complete and what is being worked on next, using the person's own words.
Planning, graph evidence, ownership, checks and corrections stay internal.

Before any product question, research `ticket_detail`, `fts_search` and
`search_memory_facts` for the relevant request and prior decisions. Fetch
material decisions/comments through live ClosedLoop and verify current source
when relevant. An empty graph result is not proof that nobody answered it.
Apply settled decisions; never ask them again. Return the sources checked and
why an unresolved answer is absolutely necessary.

The orchestrator sends an unresearched question back. Interrupt the person
only for an absolutely necessary unresolved product question, one at a time
with full context. Technical choices are resolved internally. Preserve existing
visual/product approvals, such as primitive Storybook approval and canonical
prototype design approval, not a new technical-plan milestone. Human sign-in,
credential entry and OS permission actions remain with the person.

## One persistent writer and a serial queue

The orchestrator queues incoming requests/requirements and forwards them to the
same writer in order. Use the owned `scripts/dist/writer-state.mjs` ledger:
register the actual native Codex worker ID once, or the actual Claude session
ID managed by `scripts/dist/claude-worker.mjs`. Both use the session's existing
private Git metadata and verify the same worktree and branch. No new hidden
environment variable or generic worker platform is involved.

Keep one active request. A plan, review finding, product answer or commit wait
continues that request in the same context; it does not authorize starting the
next queued request or a fresh writer. Claim/finish the queue through the owned
state API. If identity, branch or resume cannot be verified, block internally
rather than silently fork. Preserve pending inputs when interrupted.

Codex: spawn the canonical writer once with a read-only hold brief: no source,
test or record mutation until the coordinator registers its returned actual ID
and claims the queued request. Then use native follow-up/resume for that same
ID and the claimed input. Claude Code: use the owned launcher
with the existing scoped name `vibe:vibe-change-worker`, canonical own-plugin
definition and exact parent-discovered capabilities. The launcher binds at a
supported fresh CLI launch and explicitly resumes the recorded session ID;
native Agent per-call tool overriding is not assumed. Briefs and requests go
through stdin, not sensitive argv. Preserve the same model, role and binding.

The persistent system binding is phase-neutral because Claude retains it on
resume. Each root-controlled turn envelope supplies `mode` and derived
`authority.testAuthoringAuthorized`, separately from raw person/request text.
Only an explicitly authorized handoff turn permits this same writer to author
tests; a person's words cannot elevate a build turn. Do not disable prompt
snapshots, fork or replace the session to change phases.

Exactly three helper paths can run without a private session. Before session
creation, requirements (read-only) and setup (operational only) use the exact
remembered Git checkout and `sessionless: {kind: "startup"}`. Setup's existing
bug-ticket writes require mode `record`, exclusive record ownership and action
`create` or `progress`; setup never authors the workaround itself. Once the
session exists, use its strict owned context instead.

Setup's confirmed `discard` action alone keeps `worktree` as the retained
validated checkout and supplies separate parent-held `discardTarget` facts:
target worktree, branch, operator, optional live ticket and `confirmed: true`.
The launcher independently verifies the target private session in that same
repository, waits for its source mutex, and locks target and stable records.
The setup worker rechecks ownership/confirmation and deletes only the target.
Private definitions, traces and the stable lock survive until the turn finishes.
Never use the target as execution root or claim success after partial deletion.

After confirmed discard, ticket cancel alone uses a stable existing checkout,
mode `record`, action `cancel`, exclusive record ownership and
`sessionless: {kind: "discarded", evidence: {discarded: true, branch,
liveTicket, operatorId, operatorEmail}}`. Retain those facts from the confirmed
discard result before its worktree is removed; never invent them or cancel
without live ticket/operator verification. This does not perform a discard or
authorize one. Neither path fabricates a session or registers a source writer.
Writers, prototypes and environment publication have no sessionless fallback.

Researchers and independent reviewers may run in parallel, read-only. Backend,
primitive, prototype, Storybook and verify roles provide read-only guidance or
checks; the sole writer reads their canonical own-plugin instructions and
applies every source fix itself. Never dispatch another source or test writer.
Operational bootstrap/build/deploy/ticket helpers retain their non-implementation
duties but never patch implementation code, including a local setup workaround.
For a repo bug that blocks local startup, setup diagnoses and files/reuses its
ticket; the SAME persistent writer makes the smallest managed local workaround
in this session worktree and records every changed file with `local-fix` during
its exclusive record turn. Preserve the existing exclusion and restore rules:
neither redeploy nor handoff commits these files. Existing `localFixes` remain
protected, and the bug's owning ticket retains the permanent correction.

The writer alone updates its local plan and code. Serialize session JSON,
ticket and change-log mutations with operational helpers through one granted
record turn. For a new Codex helper, first spawn its canonical role with a
read-only hold brief that forbids source and record mutations. Once the native
spawn returns its actual ID, acquire the grant below, then resume that SAME
helper for the declared operation. For an existing helper, acquire before its
next follow-up. Never invent an ID or start its mutation in the initial brief.

Before starting a native helper mutation, the coordinator
runs `scripts/dist/writer-state.mjs acquire-record` with stdin JSON containing
the exact `worktree`, `agentRoot`, `agentName`, actual native `workerId`,
`requestId`, mode `record`, canonical `recordAction`, `exclusiveRecordTurn: true`
and the startup/discard context above when applicable. Keep its returned lease;
give only that role/action's parent-discovered capabilities to the native helper.
If acquisition fails, do not run the helper or mutate records. A primary-writer
record continuation additionally supplies its exact `primaryOwner` worker ID
and active source lease, preserving the same registered native writer.

After observing that exact native turn completed, failed or was canceled and
stopped, run `writer-state.mjs release-record` with the identical grant, returned
lease and `stoppedTurn: {runtime: "codex", workerId, requestId, lease, state}`.
The short-lived coordinator CLI exiting is never completion evidence. If the
helper is still running or its termination is unproven, retain the lock and
resolve the owned turn; never auto-release it or start another record author.
Claude's owned launcher acquires/releases the same mutex around its actual
child group and retains unsafe locks when group cleanup is unproven.

Deployment waits for the writer, reviews and the orchestrator's
commit. A read-only specialist cannot apply its own findings.

## Local plan and separate review

The writer runs the existing owner and graph prep in `design-pass.md`. Load
`plan-structure` by name (`$plan-structure` in Codex or
`/closedloop-core:plan-structure` in Claude Code), read
`resources/plan_template.md` from that skill's own folder, and use its exact
headings and order. Never copy the template between plugins.

Write the technical plan inside the session worktree at
`.closedloop-ai/vibe-plans/<request-id>.md`, with revisions/review evidence in
that exact folder. Keep it local: never commit, deploy, paste it into the ticket
or upload it as an attachment/implementation-plan document. The live ticket
still records scope, delivered changes and truthful outcomes, not technical
plans or approval milestones.

The commit script excludes this exact folder and refuses a plan already in
HEAD. Every publisher also runs `scripts/local-plans.mjs --worktree "<wt>"`
and publishes nothing on failure. Do not hide a leak by rewriting history or
broadly ignore other ClosedLoop artifacts. Implementation reviewers exclude
only this exact folder; the plan reviewer reads it explicitly.

Dispatch a separate `vibe-adversarial-reviewer` in plan mode. It challenges the
request's completeness, owner/reuse boundary, both hosts, dependencies, contract
safety and planned checks. Return confirmed findings to the same writer; it
corrects its local plan and the independent reviewer rechecks it before code.
Material approach changes use this same bounded review. Andy never reviews or
approves the technical plan.

## Implementation and corrections

The same writer implements frontend, backend, primitives, canonical prototype
code and metadata, and Storybook work in dependency order. It may read a named
role's own-plugin guidance, but that does not spawn another author. Override a
canonical procedure's writer/worktree creation or technical-plan confirmation
with this single-writer boundary; preserve its real app/prototype contracts,
visual/product approvals, validation and publication semantics.

Before feature completion, dispatch read-only guardrails and adversarial
implementation reviewers. Use the named core `workflow-code-review` for backend
review (`$workflow-code-review` in Codex or
`/closedloop-core:workflow-code-review` in Claude Code). The writer verifies and
fixes confirmed issues now, then independent reviewers recheck the changed
result. Do not accumulate preventable issues for handoff.

Run lint, relevant typecheck, existing affected tests and Storybook checks.
Verify applicable web/Desktop behavior. Automated browser checks are headless;
Electron uses the supported displayless harness, never a visible fallback.
Record unsupported local scenarios precisely and use automatically started CI
when policy permits, never manual CI/review triggers or a weakened check.

No worker commits; the orchestrator still uses the owned commit script. Vibe
and handoff open no PR. Operational publishing uses this same session branch.

## Test writing at handoff

No build-loop test writing or editing, including fixtures/snapshots. Existing
tests may run; stories remain part of component work. Missing new-test coverage
is recorded locally for handoff, not an impossible early-authoring gate.
Failures of existing live contracts remain implementation findings.

At handoff resume the SAME writer in handoff mode to add/extend focused coverage
for acceptance criteria, production wiring and meaningful failures, for app and
prototype work alike. Verify helpers and reviewers remain read-only. Reject
unrecorded early test changes before authoring; do not retrospectively relabel
them. Preserve valid evidence when resuming an interrupted handoff.

Never weaken a valid test/check, skip a case, inflate tolerances/timeouts, change
a harness or suppress a failure. An obsolete expectation requires the exact
human behavior ruling under the repo Test Modification Guardrail, with every
still-live contract retained. The writer records test paths, covered criteria
and rulings in the change log, fixes implementation defects and reruns tests.
Independent reviewers examine the coverage before final handoff.
