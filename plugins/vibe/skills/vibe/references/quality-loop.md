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

For an already registered session, retain its actual recorded writer ID and
original recorded binding: `binding.agentRoot`, role and exact
`binding.capabilities`. Recover these only from the original registration
evidence or a read-only helper's bounded private-ledger inspection; return
binding/identity facts, never private queued inputs or credentials. Verify the
original definition and recorded digest remain available. A changed plugin
root/body changes that digest. Never re-register the primary with the new
release's binding, copy legacy agent files, relax validation or replace it.

Root supplies this release's mandatory-table policy through the existing
root continuation to that SAME context, while retaining the original canonical
definition and tool/capability binding. It is additive request guidance, not a
system-prompt reset or new test-authoring authority. If the original binding
is unavailable, mismatched or unverified, return `BLOCKED` before new code.
Do not claim an automatic upgrade. New sessions bind the current release.

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

Main-sync's source-owned input readiness uses the SAME registered actor's
exclusive progress turn, never an ops helper or another implementation worker.
Follow environment.md: `main-sync-inputs` before capture and after the Root-owned
merge/fix commit; finish the turn, then pass its opaque `validationWitness` in
the parent grant as `mainSyncValidation`. Only identity/digest-bound validation
derives a finite owned Claude envelope; general worker limits remain unchanged.
Generated origin and retained-report exclusion are not test authority or PASS.

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

## Session decision table before code

The named core decision-table workflow is mandatory for every Vibe request,
including frontend-only, backend, primitive, Storybook, owned prototype and
trivial edits, before the first line of code. Load `$decision-table` in Codex
or `/closedloop-core:decision-table` in Claude Code and use that skill's actual
artifact format, edge-case expansion, review-prevention and adversarial rules.
Never copy its skill, checklist or template into this plugin.

Keep one living table for the whole session at
`.closedloop-ai/decision-tables/<session-slug>.md`, in the SAME worktree and
branch, authored only by the SAME persistent writer. New requests extend that
file before code; they never start or replace a per-request table. Use real
source-backed rows with stable row IDs, request provenance and grouped behavior
sections. Inventory actual callers, contracts, gates and host capabilities;
read visibility does not prove a write path works on every host. Model the
request's applicable cases and cross-request interactions with prior rows.

Preserve frozen `Current Code` and `Intended Change` blocks once their request's
implementation starts. Append a later request's sourced baseline/target rows
or behavior sections without rewriting earlier expectations. A changed human
decision gets an explicit `Superseded` entry: source, prior row IDs and new row
IDs. Never retarget history to agree with the implementation. On a legacy
session without a table, use the original binding/continuation rule above,
reconstruct current behavior and prior sources honestly, and identify missing
historical evidence; a table made now is not proof it existed before.

Once the writer has begun a scoped request, every session-scoped worker brief
includes the same path, current request, affected and interacting prior row IDs,
and current findings; operational helpers do not author its rows.
Read the actual table before code, advice or review; a returned path, checkbox
or placeholder is not evidence that it exists or represents the behavior.
Only the writer authors/extends it. Before session creation, requirements and
operational setup collect sources or restore prerequisites, not a fictional
table; initial bootstrap/ticket creation can precede the first scoped writer
turn. This gate blocks implementation, not legitimate bootstrap.
Every post-table worker result names that artifact and read row IDs, with
role-appropriate source/check evidence or unresolved findings. Advice and
operational results never claim the writer applied a fix or tests ran.

After implementation and every correction, the SAME writer compares actual
code and observable behavior with the affected and interacting prior row IDs.
Apply the named skill's applicable edge-case and review-prevention passes;
fix source gaps now, append findings/fixes and reverify. Independent reviewers
read the same table and source evidence before feature completion. A reviewer
proposal is not a product ruling: verify it, record its disposition, and never
expand scope or remove a live capability because a hypothetical fix suggests it.

Keep implementation evidence, executed existing-test evidence and planned
handoff tests separate: planned tests are not coverage. `Required Tests` maps
stable row IDs to the invariant, positive control, wrong-input/mixed-state
negative case and real production boundary. Until handoff, plan these tests
only; never write/edit tests, fixtures or snapshots. Existing tests may run.
Never claim `Final Alignment Status: Aligned` while required tests remain
unexecuted or source/review/evidence gaps remain. Per-request `DONE` reports
reviewed implementation/check completion, not final session coverage or core
alignment; retain the pending rows and test plans for the same writer.

At handoff use the whole table, all requests and cross-request interactions
for authoring and final coverage verification. A `Covered` disposition needs
a named executed test and its fail-closed negative case through the claimed
boundary; `not applicable` needs source evidence. Run the canonical internal
consistency, review-prevention and independent adversarial passes. Unresolved
required rows keep `Final Alignment Status: Not aligned` and block final
handoff/session completion. No soft final status or "test later" waiver.

Technical plans stay private under `.closedloop-ai/vibe-plans/`. The existing
behavior-table attachment at handoff remains separate; never upload the local
technical plan or its review drafts as table evidence.

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
