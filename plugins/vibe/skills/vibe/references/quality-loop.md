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
own words; after visual QA they also say what it found and changed ("Visual QA
during the session").
Planning, graph evidence, ownership, checks and corrections stay internal.

Before any product question, research `ticket_detail`, `fts_search` and
`search_memory_facts` for the relevant request and prior decisions. Fetch
material decisions/comments through live ClosedLoop and verify current source
when relevant. An empty graph result is not proof that nobody answered it.
Apply settled decisions; never ask them again. Return the sources checked and
why an unresolved answer is absolutely necessary.

A ticket's or plan's Decisions section is a record, not a ruling. A decision
is settled only when it traces to a human statement: who made it, where, and
which question it answered. An unratified or conflicting decision is not
settled: a product one goes through this section's research and necessity
gate, and a technical one becomes an `Engineering decision` item
(`ticket-template.md`, "Engineering decisions"). Never resolve a conflict by
recency or by assuming one author meant to change an earlier record. Every
"settled" in this skill means this.

The orchestrator sends an unresearched question back, and runs the precedent
check below before asking any question it can settle. Interrupt the person
only for an absolutely necessary unresolved product question, one at a time
with full context. Technical choices are resolved internally. Preserve existing
visual/product approvals, such as canonical prototype design approval, not a
new technical-plan milestone. A reference product's behavior list, a
request's new Storybook components and the endings line in a new session's
first reply are notices the person may interrupt, never approval gates
(`SKILL.md`, section 5, "Notices that never wait"). Human
sign-in, credential entry and OS permission actions remain with the person.

### Precedent before asking

Operator ruling, 2026-10-16: walk a fine line on product questions during a
session. A question is asked only when neither the graph research above nor
another app's precedent answers it. When the graph and live decisions do not
settle how the product should behave in a situation (someone cancels a GitHub
authorization halfway, a list is empty, an action is undone), what a mature
app does in the same situation is the default answer. The order is Asana, the
reference app the operator named; then, when Asana does not have the
situation, another established app with the same flow (for example Linear,
or GitHub's own authorization screens); then, when no browser can look, those
apps' public help centers, Asana's first. Only when none of these settles it
does the question go to the person, under the gate above.

`scripts/precedent-check.mjs` holds the research brief and its safety rules
once, for both harnesses:

- Claude Code: a session's Claude in Chrome tools are bound when it starts,
  so the orchestrator runs `node scripts/precedent-check.mjs run --question
  "<question>" --situation "<what to reproduce>"` in the background. It
  starts a separate headless `claude -p --chrome` limited to the Chrome
  tools, web search and fetch, with the brief on stdin, and that run falls
  back to the help centers itself when Chrome is not available.
- Codex: `node scripts/precedent-check.mjs prompt --question "<question>"
  --situation "<what to reproduce>"` prints the brief, and the orchestrator
  follows it itself, in a tab of its own in the in-app Browser (never the
  person's app tab) or with the Computer Use plugin. With neither, dispatch
  read-only `vibe-requirements-worker` in precedent mode for the help
  centers.

The brief's rules bind every look: the account already signed in is used,
and nobody signs in, creates an account or types a credential. Nothing that
already exists is touched. Test data goes only in one new private project
named `zz vibe precedent check (temp)`, with no members and notifications
off, every created task prefixed `zz test`; everything created is deleted at
the end and confirmed gone in the report. A flow that would connect an app,
invite or notify someone, share, pay or change a setting goes only as far as
its confirmation step and is canceled there. Every state is verified (reload
and look again; a hover can look like a completed task) before it is
recorded, what was observed directly stays separate from help center or
forum material, on-screen wording is quoted exactly as evidence, and a
situation nothing settles is reported as `undocumented`, never guessed. A failed run, or an
`undocumented` answer from every app, leaves the question to the person.

The answer goes to the SAME writer, which records it in the session decision
table as the decision for the affected rows, with its source: the ticket or
PRD slug for a graph answer, `Asana, observed <date>` or `<app>, observed
<date>` for a look in the browser, or the help-center URL. A precedent is the
default, not a human ruling: it never overrides a settled decision, a later
human statement supersedes it with an explicit `Superseded` entry, and it
settles behavior, never user-visible words (`guardrails.md`, "Copy").

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
A finding that a mechanism, a one-way door, or an unratified or conflicting
decision needs a human decision is never the writer's to resolve, downgrade
or absorb: it becomes an `Engineering decision` item on the live ticket's
Engineering checklist (`ticket-template.md`, "Engineering decisions"), never
a question for the person.

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
behind a remaining Open Question are not frozen. Frozen rows describe
user-visible behavior, never mechanism: no intervals, transports or storage
choices. The writer rewrites this one
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
- Reference check: only when the person gave a reference image, before
  `DONE` on a UI change the writer screenshots the touched screen, in light
  and in dark wherever it supports both, and compares it with that image
  ("Visual references", "The reference check before ready" below).
- Commit, deploy and show: after each finished change the orchestrator
  commits with its script and deploys through the existing publication gate
  without being asked (`SKILL.md`, section 6), batching changes that arrive
  while a deploy runs into the next one, then tells the person it's ready to
  look at. That gate's own fixed validation
  (`environment.md`, "Main-sync before publication") is unchanged.

Browser E2E, visual QA, logical QA, product-contract QA, the guardrails and
adversarial reviews, `workflow-code-review`, the existing test suite,
Storybook footprint, running app checks and any other heavy validation run
at `$handoff`, never during the loop, even where a repository protocol
asks for them before a change is done: handoff runs them. The acceptance
check's single test, script or control read per criterion is not one of them.
The reference check before ready is the one exception to this rule (operator
ruling, 2026-10-15), and it runs only with a reference image.
Visual QA can also run between requests, outside the loop, when the person
accepts the offer at a visible milestone or asks for polish ("Visual QA
during the session"; operator ruling, 2026-10-16): after a deploy, never
inside a request's build, and it never holds a deploy back.
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

## Visual references

A reference the person gives reaches the writer as an image it reads, and
every visual and UX property it shows becomes an acceptance criterion
(operator ruling, 2026-10-15: "we're missing visual cues"). A person built UI
from two screenshots, one of another product; the session missed a drop
shadow, a larger text size and bold type, and fixed each once she pointed it
out. The writer received the saved path beside the orchestrator's own text
description, never read the image before its first build, and reference mode
was scoped to behaviors, so those properties never became criteria. This
section is the rule's one canonical statement; the skills and workers point
at it. The build loop stays lean: the reference check below is the one
exception to its no-automated-visual-QA rule, and it runs only when there is
a reference image.

It serves every person running a session, and nobody is asked which kind
they are. Someone who works from references (a screenshot or image, a
prototype or Storybook link, an existing page or screen, "make it look like
X") gets the reference saved, read, turned into criteria and checked against
a screenshot before ready. Someone who describes what they want in words gets
criteria from their words, checked as before, with no render or compare.

### Recording it in the table

The rules below leave their evidence in the session decision table, one line
each, in these shapes. Criterion lines sit under `## Acceptance Criteria`,
above `### Checks`; only check lines go below it.

- `### Checks`: `Reference read <request ID>: <image path>: <what it shows>`,
  one per reference image on the session, every one the person gave and not
  only the one the latest request names (a screenshot of our page as it is
  now included), before any criterion or code for that request, a correction
  included.
- `## Acceptance Criteria`: `AC-n (source: <request ID>, reference <image
  path>): <one property as the reference shows it>; <the design token or
  catalog component that delivers it>`. One property per criterion: a shadow,
  a type size and a type weight are three criteria, never one "match the
  reference". A correction ("it still doesn't look like it") adds a criterion
  for each property the reference shows that no criterion names yet, even
  when a broad one such as "make ours like the second one" exists, before it
  fixes anything.
- `### Checks`: `<request ID>, AC-n, AC-m: reference check (<light|dark>),
  compared <screenshot path> with <image path> after the last edit:
  <differences found and fixed>; met`, or `not met yet` with the difference
  that remains, one line per theme the surface supports.

With no reference image, a criterion from the person's words quotes them,
`AC-n (source: <request ID>): "<their words>"`, and is checked with the
cheapest honest evidence ("Acceptance criteria before ready"), never a
render.

### Saving the reference

The writer is a separate context that receives text, so an image the person
attaches in chat reaches it only as a saved file it opens itself. When the
person attaches an image, before forwarding the request the orchestrator runs
`node scripts/reference-images.mjs attached --worktree "<wt>" --request-id <id>`,
which decodes the images on their latest message from this harness's own
transcript, or `save --file <path>` for an image they gave as a file path or
one the harness already saved to a file.
Both store the image in the session's private Git metadata and record it on
the session as `referenceImages`, so later turns and handoff reuse it. The
request to the writer names every saved path. The orchestrator never
replaces the image with its own description as the only reference; its words
may go alongside the path, never instead of it.

Claude Code's owned launcher adds the recorded `referenceImages` to every
writer, requirements and verify turn. In Codex, `writer-state.mjs take-input`
returns them with the claimed input; forward each path with it, also as a
`local_image` input item when the native follow-up accepts input items. The
writer opens each path as an image: `Read` in Claude Code, `view_image` in
Codex. A reference given as a link, a page or screen, or "make it look like
X" (a screen in our own product) is captured as an image before building
(`environment.md`, "Capturing a reference") and saved with `save --file`.

Reading the reference is a required step with a recorded result. Before it
plans or builds, including a correction such as "it still doesn't look like
it", the writer opens every reference image and appends a
`Reference read` line per image to the `### Checks` log: the path and what it
shows (shadow and elevation, type sizes and weights, colors, spacing, radius,
borders, alignment, icons, and the visible states). A plan or criterion
written before that line exists is incomplete, and so is a `DONE` whose
request had a reference image and no `Reference read` line for it. The
orchestrator's text description of an image never stands in for that read,
however detailed.

### Requirements from a reference

A reference image of an outside product goes through the reference-product
notice (`SKILL.md`, section 5, "Notices that never wait") with its saved
paths, whether or not the person named the product. `vibe-requirements-worker`
reads the image itself and researches the product when it is named or
identifiable. It returns two lists:

- Visual: elevation and shadow, type hierarchy (size and weight), color roles,
  spacing, radius, borders, iconography and density.
- UX: layout and hierarchy, what is emphasized, the interactive affordances
  and states visible or implied (hover, selected, disabled, empty, loading,
  overflow), grouping, labels, and the behavior a user would expect from that
  pattern.

The orchestrator never scopes the visual list out: a brief that asks only for
layout, behaviors or hierarchy still gets the visual requirements, and
"behaviors, not wording" is about copy only. Each requirement is mapped to
the existing catalog component and design token that delivers it. Build to
the design system; never copy pixel values or another product's markup. A
requirement with no design-system equivalent goes to the existing
missing-primitive path (`NEEDS_PRIMITIVE`, built by the writer from the
read-only design-system steward's spec). Before any raw value, the writer
reads the tokens the touched surface actually bundles, in each stylesheet's
`:root` and `.dark` blocks (`guardrails.md`, "Check the bundled tokens
first"; operator ruling, 2026-10-16). A bundled token is always used. Only a
token the surface genuinely lacks (a page generated outside the app shell can
lack some) is logged, per token and with the stylesheets and blocks searched,
as `Engineering needed (token not bundled): <surface>; <token>; checked
<each stylesheet and block searched>; uses <the token's exact value>`, and
that property alone uses the token's exact value with the token cited beside
it; it never invents a value no token defines. Never copy the outside
product's words; user copy follows `guardrails.md`, "Copy".

The writer adds each requirement to the session's `## Acceptance Criteria`
as a criterion (source: the request ID and the reference image path), naming
its token or component. A correction adds each property the reference shows
that the list still lacks, before it fixes anything. The same applies to a reference in our own product:
each visible property becomes a criterion. A visual criterion with a
reference image is met by the reference check below, never by a source trace
alone. UX criteria, and visual criteria with no reference image, are checked
like every other criterion ("Acceptance criteria before ready"), with the
cheapest honest evidence that list allows, a source trace included.

### The reference check before ready

Only when the person gave a reference image (a screenshot or image, or a
link or page captured as one) and the change renders UI (operator ruling,
2026-10-15). With no reference image there is no render and no compare.

Before returning `DONE`, the writer takes one screenshot of each touched
screen or component at the reference's viewport (`environment.md`,
"Capturing for the reference check") and opens it beside the reference
image. It renders that final state in both light and dark wherever the
surface supports both (operator ruling, 2026-10-16) and compares each theme's
screenshot: the reference's properties in the reference's own theme, and in
the other theme the same properties delivered by the same tokens, none lost,
unreadable or turned back into a raw value. It looks only at the properties
the reference shows (shadow and elevation, font size, weight, color,
spacing, radius, borders, alignment and icons, as the reference shows them),
plus regressions on the touched element: properties that were right before
this change and are not now, such as a removed tap-target minimum height or
button text turned too bold by a font change. It fixes each difference with
design tokens, never arbitrary values, and takes the screenshots again until
no difference remains in either theme. Each comparison is a line in the
`### Checks` log: request ID, criterion IDs, the theme, both image paths and
the result. `DONE` on such a change carries a Reference check line per
touched screen and theme (the screenshot path, the reference path and the
differences found and fixed); without them the `DONE` is incomplete. When
the writer cannot screenshot a touched screen locally, it says so in that
line and the orchestrator's look after the deploy is the comparison
(`SKILL.md`, section 6, step 5).

The result gates the ready message. A difference still visible is not ready:
it goes back to the SAME writer in the same request and is deployed again
first.

It is not a design review: no critique of craft or hierarchy beyond the
reference, and no full design pass; those stay at handoff. Never ask the
person to confirm the comparison, and never show them the screenshots or
their paths unless a real difference cannot be resolved: a product choice becomes one plain
question through the research gate above, and anything else is logged as an
engineering note under the existing rules.

### What the orchestrator says

The orchestrator never tells the person the result matches the reference,
or that a visible property is done, when it has seen a gap, in a screenshot
or anywhere else. A gap it sees goes back to the SAME writer in the same
request; the ready message names it plainly as not done yet until the writer
has fixed it.

## Visual QA during the session

Operator ruling, 2026-10-16, newer than the lean-loop ruling (2026-10-13,
after the PRD-720 live test) that left visual QA to handoff alone. It adds an
opt-in visual QA the orchestrator offers during the session, in Codex and
Claude Code alike; the build loop above is otherwise unchanged. This section
is the rule's one canonical statement, and handoff's visual QA compares
against the same basis.

### What it checks

Visual QA uses the repository's own design pack: its read-only visual
QA skill (`/visual-qa` in Claude Code, `$visual-qa` in Codex), which `/design`
and `$design` route production review through.

- When the linked ticket or its PRD has acceptance criteria, visual QA checks
  the change against them: the run gets the session decision table's
  `## Acceptance Criteria` list (those criteria, plus any the person's
  requests added) and reports each visual and UX criterion as met or not,
  with what it saw.
- When neither has any, it falls back to the design pack's best-practice
  review, against `.claude/design/soul.md`, as the skill does when there is
  no spec.

Run it the way handoff runs its visual QA (the handoff skill, "Browser E2E
and the repository's QA passes"): the skill dispatches its own read-only
agents on the session's last deployed commit, with the session's app link
and the screens the change touched. It changes no code. Its confirmed
findings go to the SAME writer as one fix request in the queue, under the
usual rules: design tokens and catalog components,
never new user-visible words (`guardrails.md`, "Copy"), and a finding that
needs a product choice goes through the research and necessity gate above.
That fix deploys like any other request, and the ready message names what
the check found and changed, in the person's terms. Owned prototype sessions
keep their canonical single design review at handoff instead.

### When it is offered

At each visible milestone, the ready message offers it, without waiting for
the person to think of it: when a user-visible change is first ready to look
at, and again after a major visible change (a new screen or part of one, or
a reworked layout). Never on a small edit (a spacing, color, wording or
single-control fix), and never for a change that shows nothing visible. Ask
it through `scripts/session-questions.mjs` with the key `visual-qa:<request
ID>` of the milestone's request, so each milestone's offer is asked once, in
exactly these words when the ticket or its PRD has acceptance criteria:

```
Want me to check how it looks against the ticket's requirements and fix anything that's off?
```

and otherwise:

```
Want me to check how it looks against our design standards and fix anything that's off?
```

A yes runs it. A no is recorded and declines visual QA for that version of
the change, until the next visible milestone.

### When the person asks for polish

When the person says it looks good and wants to see it polished ("looks
good, make it polished", "polish it", "clean it up so it looks finished",
"make it look production ready", or words meaning the same), run visual QA
before handoff without asking, and send its findings and the request to the
SAME writer together. Skip it only when the change shows nothing visible, or
when the person already declined visual QA for this version of the change
(the recorded no for the latest milestone, with no major visible change
since); then the request goes to the writer as an ordinary request under
`guardrails.md`, "Making something look better".

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
session's own code when one fails, never what a test asserts. A failure
`main-sync-validate` classifies `main-preexisting` is not the session's to fix:
it is recorded for engineering ("Failures already on main" below). It lists every
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

## Failures already on main

Operator ruling, 2026-10-16, for handoff in Codex and Claude Code alike. A
handoff check can fail because it is already red on main, not because of
anything the session did. `main-sync-validate` settles which, so neither the
orchestrator nor the writer judges it:

- When a handoff check fails, the executor runs that same check on the main
  the session captured (the transaction's `mainSha`) in a disposable checkout
  of that commit. The checkout is bootstrapped once with the repository's own
  `.closedloop-ai/loops-setup.sh`, the same pristine bootstrap the input
  readiness uses, shared by every failing check, and removed afterwards. A
  check whose selection follows the session's diff (the affected wrappers, the
  pinned Turbo filter) runs the same task over the packages the session
  selected. A check that passed is never rerun. Each run is bounded by that
  check's own time limit through `scripts/run-bounded.mjs`.
- `main-preexisting`: it fails on the captured main too. The session did not
  cause it, and it blocks neither publication nor assignment. The executor
  returns it under `mainPreexistingFailures` and its receipt keeps the session
  run and the main run.
- `session-caused`: it passes on the captured main and fails again on one
  rerun of the session's commit. It blocks, and the SAME writer fixes the
  session's own code as before. The receipt keeps all three runs.
- `flaky`: it passes on the captured main and on that one rerun. It counts as
  passed, returned under `flakyChecks` with both session runs kept.
- A check that cannot run on the captured main (no bootstrap, a failed or
  timed out bootstrap, a time limit, a checked file main does not have) is
  `session-caused`, the conservative reading, and blocks.
- Each `main-preexisting` failure goes once on the live ticket's Engineering
  checklist as a Known main failure (`ticket-template.md`, "Known main
  failures"). It is not a needed tooling fix (`guardrails.md`, "Plugins and
  tooling"), never a reason to stop the handoff and never a question for the
  person. What the person hears stays in plain words (`plain-words.md`) and
  never presents it as a stop.
- The build loop's quick checks are unchanged: a failure there still blocks
  that deploy.
