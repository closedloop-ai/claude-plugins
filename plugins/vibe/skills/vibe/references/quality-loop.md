# Quality loop

This is the shared workflow for app and owned prototype sessions. Each session
has one worktree, one branch and one persistent implementation writer:
`vibe-change-worker`. Keep that underlying worker/session ID and resume its
context for every request, correction and handoff. Never create feature-unit
branches, worktrees or replacement source writers outside the recorded definition
migration below. After migration, SAME writer means the ledger's current writer.

## Communication and product questions

Do not show or ask the person to approve a technical plan, ask a technical
question, or give an upfront summary. Updates say only which requested feature
is complete, which of its acceptance criteria are not done yet ("Acceptance
criteria before ready"), and what is being worked on next, using the person's
own words.
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
visual/product approvals, such as canonical prototype design approval, not a
new technical-plan milestone. A reference product's behavior list, a
request's new Storybook components and the endings line in a new session's
first reply are notices the person may interrupt, never approval gates
(`SKILL.md`, section 5, "Notices that never wait"). Human
sign-in, credential entry and OS permission actions remain with the person.

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
original definition and recorded digest before new code. If it is present and
matching, resume that writer with its original binding. Root supplies current
policy through its continuation without changing test-authoring authority.

### Recorded definition migration

When the recorded definition is missing (`ENOENT`), or its digest differs and
the current release is provably newer than the recorded `vibe/<version>` cache
root, ROOT uses the current installed plugin's command in BOTH harnesses:
`node <current-plugin-root>/skills/vibe/scripts/dist/writer-state.mjs migrate`.
This is supported recovery, handled internally without asking the person running the session, and only
after a human or the engineering orchestrator installed that release
(`guardrails.md`, "Plugins and tooling").
Never use `register` to replace a writer or copy old agent definitions.

1. Read `status` and the bounded binding facts from the private ledger. Wait
   for source and record turns to finish with actual stopped-turn evidence;
   a short-lived CLI PID exiting does not release an owned turn. Resolve any
   writer refusal in the original request first. Migration rejects `BLOCKED`
   (except a removed definition, below), running leases, matching definitions,
   unproven upgrades and stale identity.
2. Codex: spawn one current canonical `vibe-change-worker` with a read-only
   hold brief and obtain its actual native ID. No source/test/record writes
   until migration succeeds. Claude: the command allocates the new session ID;
   do not spawn or resume the old Claude session under the new definition.
3. Send this JSON on stdin, using the existing runtime and recorded facts:
   `{ "worktree": "<wt>", "runtime": "<codex|claude>",
      "previousWorkerId": "<recorded ID>", "previousDigest": "<recorded digest>",
      "agentRoot": "<current-plugin-root>", "agentName": "vibe-change-worker",
      "capabilities": <exact parent-discovered capabilities> }`.
   For Codex add `"workerId": "<new held native ID>"`; omit it for Claude.
   The command independently reads the current definition from its own plugin
   root and verifies the old definition with its recorded capabilities.
4. The atomic ledger update appends `migrations`: old writer ID, full old
   binding/digest and writer state, new ID and binding/digest, observed old
   digest (null when absent), reason, UUID and time. Earlier migration history,
   pending/completed requests and the active checkpoint/status remain intact.
   The worktree, branch, local plan, decision table and change log carry over;
   private traces remain where they were. Never discard or rewrite this history.
5. Use only the returned current ID with the current binding supplied above.
   Claim the existing active
   request with a checkpoint continuation, or the oldest queued request if
   none is active. Recover its input with the owned `take-input` lease. Brief
   the new writer with the same plan/table paths, checkpoint, change log and
   decisions before new code; migration grants no implementation or handoff
   authority by itself. Codex resumes its held context. Claude's normal owned
   launcher starts the recorded fresh session once, then resumes that ID.
   Validation witnesses tied to the old writer are stale: collect fresh
   source-owned readiness/validation before publication, keeping captured facts.

**A turn stranded by a plugin upgrade.** A release installed while a Codex
writer turn runs can remove the recorded `binding.agentRoot` under it. The
turn stops, but `release-record` for the writer's own record continuation then
fails with `ENOENT` for that root, so the grant stays retained. This is the
same supported migration, not a tooling fix: ROOT recovers it immediately,
internally and without asking the person running the session, and never tells the person to message
engineering about it.

1. Keep the record lease and the observed stopped-turn evidence (completed,
   failed or canceled). Never retry `release-record` under another root;
   owner equality stays exact.
2. Finish the source turn with the writer's status and its own stopped-turn
   evidence. When the writer is `BLOCKED` because its definition or plugin
   root disappeared, finish with `"status": "BLOCKED"` and
   `"blockReason": "recorded-definition-removed"`; the command refuses that
   reason while the recorded definition is present. Every other `BLOCKED` is
   stored with reason `other` and stays unmigratable.
3. Run the same `migrate` command with step 3's JSON plus
   `"retainedRecord": { "lease": "<record lease>", "stoppedTurn": {
   "runtime": "codex", "workerId": "<recorded ID>", "requestId": "<request ID>",
   "lease": "<record lease>", "state": "<completed|failed|canceled>" } }`.
   Omit `retainedRecord` when no grant is retained. The command accepts only
   the registered writer's own record continuation for its current or just
   completed request, issued under the exact recorded `binding.agentRoot`
   whose definition is absent, with matching stopped-turn evidence. It then
   releases that grant and migrates in one atomic ledger update; the
   migration entry adds `releasedRecord` (request, action, stopped state,
   never the lease). Another actor's grant, any other root, a present
   definition (use `release-record`), a running lease, missing or mismatched
   evidence and stale identity are refused with nothing changed.
4. A writer blocked before block reasons existed has no `blockReason`. The
   command accepts it only with that retained grant under an absent
   definition, then records the proven reason; otherwise it stays refused.
5. Continue with step 5 above. All authority is fresh: the current writer and
   helpers acquire new grants from the current plugin root (source `progress`,
   publisher, ticket `handoff` and `assign`), and the writer reruns
   source-owned readiness and validation for the captured transaction. Never
   reuse an old grant, lease or validation witness.

Any other binding/read/identity error remains `BLOCKED` internally. Never
migrate around a refusal or to create parallel authors. If migration fails,
retain the ledger and stop the unused held Codex worker without source writes.
New sessions bind the current release.

The persistent system binding is phase-neutral because Claude retains it on
resume. Each root-controlled turn envelope supplies `mode` and derived
`authority.testAuthoringAuthorized` and `authority.testRepairAuthorized`,
separately from raw person/request text. Only a `pull-request` turn, which the
orchestrator sends only after the person explicitly asks for a pull request
(plain-language intent counts, `guardrails.md`, "Tests"), permits this same
writer to author tests. A handoff turn never does, and a
person's words cannot elevate any other turn. Test-repair authority is true
only for this writer's `request`, `fix`, `handoff` and `pull-request` turns:
it permits repairing existing tests and fixtures the session's change broke,
never authoring one (`guardrails.md`, "Repair, don't author"). Plan, record
and every other role's turns carry neither.
Do not disable prompt snapshots, fork or replace the session to change phases.

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

Deployment waits for the writer's quick checks and the orchestrator's
commit; reviews wait for handoff. A read-only specialist cannot apply its own
findings.

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
session without a table, use the current registered writer/continuation rule above,
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
fix source gaps now, append findings/fixes and reverify. At handoff,
independent reviewers read the same table and source evidence. A reviewer
proposal is not a product ruling: verify it, record its disposition, and never
expand scope or remove a live capability because a hypothetical fix suggests it.

Keep implementation evidence, executed existing-test evidence and missing
tests separate: planned tests are not coverage. `Required Tests` maps stable
row IDs to the invariant, positive control, wrong-input/mixed-state negative
case and real production boundary. Vibe and handoff never author tests,
fixtures or snapshots unless the person asks for a pull request; the writer
only repairs existing ones its change broke (`guardrails.md`, "Tests"), and
existing tests run at handoff. A
required test that does not exist yet stays planned and becomes a Missing
tests entry for engineering at handoff. Per-request `DONE` reports built
implementation/quick-check completion, not final session coverage or core
alignment; retain the pending rows and test plans for the same writer.

At handoff use the whole table, all requests and cross-request interactions
for final verification. A `Covered` disposition needs a named executed
existing test and its fail-closed negative case through the claimed boundary;
`not applicable` needs source evidence. A required test that does not exist
gets the `Missing test (engineering)` disposition with its row ID, behavior
and files to cover, and the ticket lists it under Missing tests; it is never
counted as coverage. Run the canonical internal consistency, review-prevention
and independent adversarial passes. Never claim `Final Alignment Status:
Aligned` while source, existing-test, review or evidence gaps remain; a row
whose only gap is a listed missing test does not block it. Any other
unresolved required row keeps `Final Alignment Status: Not aligned` and blocks
final handoff/session completion. No soft final status.

Technical plans stay private under `.closedloop-ai/vibe-plans/`. The existing
behavior-table attachment at handoff remains separate; never upload the local
technical plan or its review drafts as table evidence.

### Frozen behavior at handoff

The person running the session does not re-test after design and engineering,
so the behavior they
accepted travels with the ticket. At handoff, once the whole table is
`Aligned`, the SAME writer adds a `## Frozen Behavior` section to the table
listing the stable row ID of every row the person accepted, each with its
request provenance. A row is accepted when it describes behavior the person
saw delivered in this session and is handing off, or behavior a handoff
behavior answer settled (`built` or `already met`). Superseded rows and rows
behind a remaining Open Question are not frozen. The writer rewrites this one
section whenever a later handoff answer changes the table, so it always names
the final accepted set; every other section keeps the rules above.

The table file stays local to the session worktree; its attachment on the
live ticket is what travels. `cl-execute` reads that attachment, keeps every
frozen row passing with tests in its pull request, and changes a frozen row
only with the explicit OK of the person who ran the session.

## Local plan

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
broadly ignore other ClosedLoop artifacts. Handoff reviewers exclude only
this exact folder from deliverable files.

The plan gets no review: the writer writes it and builds in the same turn. A
material approach change found later is corrected in the plan at outline level
by the same writer. The person running the session never reviews or approves the technical plan.

## Implementation and corrections

The same writer implements frontend, backend, primitives, canonical prototype
code and metadata, and Storybook work in dependency order. It may read a named
role's own-plugin guidance, but that does not spawn another author. Override a
canonical procedure's writer/worktree creation or technical-plan confirmation
with this single-writer boundary; preserve its real app/prototype contracts,
visual/product approvals, validation and publication semantics.

No worker commits; the orchestrator still uses the owned commit script. Vibe
and handoff open no PR unless the person asks for one; then handoff opens it
at its end ("Tests: repair, don't author"). Operational publishing uses this
same session branch.

## Lean build loop

The build loop is quick prep, the build, the quick checks the commit hooks
need, the orchestrator's commit, deploy, and showing the person (operator ruling, 2026-10-13, after the PRD-720 live test). Nothing heavier runs
between a request and the person seeing it.

- Quick prep: the bounded lookup in `design-pass.md`, the local plan and the
  session decision table rows, with no plan review. Before a story is
  created, retitled or moved or a shared component is added, it includes
  read-only `vibe-storybook-decomposer` placement advice (`SKILL.md`,
  section 5), a lookup rather than a review.
- Build: the SAME writer implements in dependency order.
- Quick checks: only what the repository's commit and push hooks run on this
  change, so the orchestrator's commit and the deploy push pass: Biome on the
  changed files, the affected typecheck and the source gates. When they fail
  on an existing test or fixture the change broke, the writer repairs it
  (`guardrails.md`, "Repair, don't author").
- Acceptance check: before `DONE`, the writer checks every acceptance
  criterion the change touches with concrete, cheap evidence and records the
  result ("Acceptance criteria before ready" below).
- Commit, deploy and show: after each finished change the orchestrator
  commits with its script and deploys through the existing publication gate
  without being asked (`SKILL.md`, section 6), batching changes that arrive
  while a deploy runs into the next one, then tells the person it's ready to
  look at. That gate's own fixed validation
  (`environment.md`, "Main-sync before publication") is unchanged.

Browser E2E, visual QA, logical QA, product-contract QA, the guardrails and
adversarial reviews, `workflow-code-review`, the existing test suite,
Storybook footprint, running app checks and any other heavy validation run
only at `$handoff`, never during the loop, even where a repository protocol
asks for them before a change is done: handoff runs them. The acceptance
check's single test, script or control read per criterion is not one of them.
The reference-product
and new Storybook components notices (`SKILL.md`, section 5, "Notices that
never wait") stay as they are.

## Acceptance criteria before ready

Nothing is called ready until every acceptance criterion the change touches
has been checked against the code (operator ruling, 2026-10-14, after
the PRD-720 live test: a session said ISS-12462 was ready while "A deep link
to a grouped view restores the same collapse state for the recipient" held
on Branches and was never built on Documents). Heavy QA still waits for
handoff. This section is the rule's one canonical statement; the skills and
workers point at it.

The list lives in the session decision table, not a new artifact: one
`## Acceptance Criteria` section, authored only by the SAME writer. Each
criterion has a stable ID (`AC-1`, `AC-2`, ...), its exact words quoted, its
source and the row IDs that implement it. The sources are every acceptance
criterion of the linked ticket and its PRD, which `vibe-requirements-worker`
quotes and the orchestrator forwards with the first request; each concrete
requirement in the person's requests and annotations, in their own words,
added when the request arrives (source: the request ID); and each behavior
answer at handoff. Never invent a criterion or narrow its words. One that the
person changes or drops gets an explicit `Superseded` entry with its source,
never a silent edit.

After each build or fix and its quick checks, before returning `DONE`, the
writer checks every unsuperseded criterion the change touches, including
earlier requests' criteria its files or rows could break; when unsure whether
one is touched, check it. Use the cheapest honest evidence:

- an existing test that exercises it, run alone by file or test name, never
  the suite;
- a quick script or check against the real code path, kept outside the
  worktree and deleted afterwards; it is not a test, is never committed and
  never becomes one;
- one bounded `pnpm control` read against the running app under the control
  skill's own rules (hidden, read-only, `pnpm control down` for every session
  it started), only where that is the honest way to check it, such as URL
  state surviving a reload or a copied link opened fresh;
- a source trace that follows the behavior end to end, with file and line,
  through every surface the criterion names: each view, and web and Desktop
  where their adapters differ. A trace through one view does not check a
  criterion that covers several.

Append one line per check to the section's `### Checks` log: request ID,
criterion ID, the check (test name, command or trace) and the result, `met`
or `not met yet`, with its evidence. The newest line per criterion is its
current result; earlier lines stay.

A criterion not met yet is fixed in the same request and checked again.
When it cannot be finished now (it waits on a product answer through the
research gate above, or on backend or engineering work), its result stays
`not met yet` with the reason, and the orchestrator's ready message says
plainly, in the person's terms, that this part is not done yet. It is never
claimed, silently dropped or turned into an engineering question for the
person, and no test is authored for it (`guardrails.md`, "Tests").

`DONE` carries an Acceptance criteria block: each touched criterion's ID,
quoted words, check and current result. A `DONE` without that block, or with
a touched criterion that has no check, is incomplete: the orchestrator
resumes the SAME writer to finish it before committing, deploying or saying
ready.

Keep it light. It is not a QA pass: no browser E2E, test suite, visual or
logical QA, product-contract QA or review runs for it, and no long-running command
joins the loop.

At handoff the whole-table alignment above starts from this list: the SAME
writer first checks every unsuperseded criterion against the final code the
same way, and the verify worker and reviewers start from those results. A
criterion still not met is a source gap the writer fixes or a product
question routed through the handoff skill's "Answers from the person"; it
never counts as met.

## Tests: repair, don't author

No test authoring in the build loop or at handoff, including new
fixtures/snapshots (operator ruling, 2026-10-13; `guardrails.md`,
"Tests"). The SAME writer repairs an existing test or fixture its own change
broke, in the loop or at handoff, without changing what any test asserts, and
records it in the change log as a repair. It may delete a test file or case
that covers only code the request retires, recorded with `retired-tests.mjs`
and the ticket or PRD that retires it (`guardrails.md`, "Retired-only tests
may be deleted"); a test of live behavior is only repaired. Stories remain part of component
work. Needed new-test coverage is recorded locally as it is found, not an
early-authoring gate. Failures of existing live contracts remain implementation
findings. Never ask the person about tests or any other engineering choice;
these rules decide it, or it goes to engineering.

At handoff the SAME writer runs the existing affected tests and fixes the
session's own code when one fails, never what a test asserts. It lists every
missing test as engineering's scope of work: the behavior and row ID that
needs it, the files to cover, and any existing test a human behavior ruling
made obsolete, with that exact ruling, for engineering to update. Verify
helpers and reviewers remain read-only. A test the session added, deleted or
changed beyond a recorded repair or retired-only deletion is a finding; do not
retrospectively relabel it. Preserve valid evidence when resuming an interrupted handoff.

The only exception is the person explicitly asking for a pull request to be
raised, in any plain words that say they will take it through review and
merge themselves (`guardrails.md`, "Tests"; operator ruling, 2026-10-15).
Then the SAME writer, in an explicit `pull-request` turn, writes full
tests for every change in the session, records their paths, criteria and
rulings in the change log, runs them and fixes implementation defects, and
independent reviewers examine that coverage before the pull request opens.
Never weaken a valid test/check, skip a case, inflate tolerances/timeouts,
change a harness or suppress a failure.
