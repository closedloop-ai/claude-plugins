---
name: handoff
description: Finish a vibe session in symphony-alpha and hand it to whoever picks it up next, usually design and then engineering. Through workers, completes internal scope and Storybook checks, runs lint, typecheck and the existing tests without writing any (it lists the missing tests for engineering), drafts marked edits to existing product docs pages, reviews the integrated result and fixes confirmed findings, and verifies each touched screen in the running web app and Desktop with the repo's control skill. Asks who should pick the work up next, checks the live ticket is complete, publishes the final app environment or canonical prototype preview, and assigns the ticket with status left In Progress. It ends at the branch; no pull request is opened. Use when someone says "handoff", "hand this off", "send this to engineering", or "I'm done with this". Pairs with the vibe skill.
---

# Handoff

The person ran `vibe` and built something they are happy with. You
orchestrate making it safe and complete for the next people, without asking
them to understand any of the engineering. The session's live ClosedLoop
ticket was created when the session started and the workers kept it current;
handoff checks it is complete rather than writing it. The person says who
picks the work up next, and the ticket is assigned to them. Usually that is
design, who reviews the components in the branch's Vercel Storybook and
comments on the ticket on sign-off, then engineering, who finishes the work
through analysis, a pull request, and merge; sometimes it goes straight to
engineering. The ticket stays In Progress throughout, and no pull request is
opened here.

## Your role: orchestrate, never do the work

The same rule as the `vibe` skill, without exception: you never read source
files, search the codebase, edit files, read diffs or tickets in full, or run
builds, tests, linters, reviews, git, or `gh` yourself. You keep an internal
checklist, talk to the person, run this skill's inventory script, the
vibe session script, and the vibe commit script (short JSON), and dispatch
workers. You commit, through `../vibe/scripts/commit-worktree.mjs`; no worker
ever commits, because a commit runs the repository's commit hooks. Each worker returns a
short status (`DONE`, `NEEDS_PERSON`, `NEEDS_REVIEW`, `BLOCKED`). Apply
`../vibe/references/quality-loop.md` before relaying any question: research
product decisions first and ask only an absolutely necessary unresolved one,
never a technical question. Route the answer as "Answers from the person"
below says. Updates mention only completed features and next work; planning,
reviews and the checklist stay internal. Every
worker brief says closedloop-graph is required
(`../vibe/references/closedloop-graph.md`): each worker that locates,
changes, or reviews code makes its required calls and ends its result with a
Graph block. A result without one, or with one that lists no calls, is
incomplete; dispatch the worker again saying so. A Graph block that says
`unreachable` keeps that step moving; dispatch `vibe-setup-worker` to restore
the connection before the next step. Every worker that edits the live ticket
follows `../vibe/references/ticket-template.md`. You and every worker leave
plugins, plugin marketplaces and plugin caches alone, and never clone the
plugin's repository to run other tooling (`../vibe/references/guardrails.md`,
"Plugins and tooling"); a needed tooling fix stops the handoff as that section
says.

Handoff authors no tests (`../vibe/references/guardrails.md`, "Tests"; Daniel
Ochoa's ruling, 2026-10-13). It runs the existing affected tests, and when one
fails the SAME persistent `vibe-change-worker` fixes the session's own code,
never what the test asserts; it only repairs an existing test or fixture the
session's change broke ("Repair, don't author"). The tests the session still
needs go on the live ticket under Missing tests as engineering's scope of
work. Verification/review helpers are read-only. Preserve test integrity and
fix implementation defects rather than weakening a check. Never ask the
person about tests or any other engineering choice: those rules decide it, or
it goes to engineering.

The build loop is lean (`../vibe/references/quality-loop.md`, "Lean build
loop"), so handoff is where the session's reviews and heavy validation run:
the guardrails and adversarial reviews, browser E2E, visual QA, logical QA,
Metal Andrew, the existing tests, Storybook footprint and the running app
checks. Handoff opens no pull request; "A requested pull request" below is the
one exception to the no-tests rule.

Harness notes match the `vibe` skill: in Codex invoke as `$handoff` and spawn
plugin agents from `../../agents/<name>.md` with the file's body as the
subagent's instructions; in Claude Code use `/vibe:handoff` and the
`vibe:<name>` agents. Repo agents live in `<repo>/.claude/agents/`. Paths like
`scripts/...` and `../vibe/...` are relative to this skill's own folder, not
the repository. Resolve the plugin root (two levels above this file, as the
`vibe` skill describes) to an absolute path and start every worker brief with
the same plugin-root line: worker paths starting with `../` are relative to
`<root>/agents`, never to the worktree the worker runs in.
Read the existing writer summary/queue and resume its actual recorded ID.
Claude uses the owned capability-bound launcher; Codex uses the same native
follow-up/resume ID. Do not start a new handoff/backend/test source writer.
Preserve the existing session's original recorded binding and actual ID while
its definition matches. If missing or provably upgraded, use quality-loop's
recorded definition migration through the current `writer-state.mjs migrate`
command in either harness. Resume the returned current writer with the same
plan, decision table, checkpoint and change log; refresh old-actor validation
proof. Never copy definitions, replace via registration or bypass a refusal.
A writer turn stranded by a plugin upgrade (its own record grant retained
because `release-record` fails with `ENOENT` for the removed root, or `BLOCKED`
with `blockReason` `recorded-definition-removed`) uses the same command with
`retainedRecord`; then publication, the ticket update and assignment take
fresh grants and fresh validation, never the old ones.
This recovery is internal; never ask Andy about it or send them to Daniel Ochoa.

## Answers from the person

Every answer the person gives during handoff (to a worker's `NEEDS_PERSON`,
or as a correction to the summary in step 2) is one of two kinds, and the
worker that asked says which (`behavior` or `wording`). The one exception is
who picks the work up next, which step 8 asks and routes itself.

- **Behavior**: it decides what the product does. A rule, a permission (who
  may do something), what happens in a case, an acceptance criterion, or a
  change to what they built. Treat an answer as behavior when the worker did
  not say, or when you are unsure.
- **Wording**: it only changes how the ticket describes what is already
  built (the summary, a name, how the scope reads).

A behavior answer resumes the SAME `vibe-change-worker` in fix mode first, with the
question and the person's answer verbatim. It checks the code against the
answer on every screen it touches and either reports the code already meets
it (with the evidence, no file changed) or builds it under its usual rules
(backend guidance may be read-only; this writer builds the backend too). If
it changed any file, re-run before the ticket is finished: step 3 (inventory
and guardrails), step 4 when a component or story changed, step 5 (checks),
step 6 on the result (lighter: both reviewers; backend: one
`workflow-code-review` pass), step 7 (the redeploy) and step 8's running app
verification. Only then does the answer go to `vibe-ticket-worker`.
Before code, extend the same session decision table with the answer's source,
row IDs, cross-request interactions and explicit Superseded decisions, and add
the answer to its `## Acceptance Criteria` list
(`../vibe/references/quality-loop.md`, "Acceptance criteria before ready"). Preserve
earlier frozen targets. Handoff reruns use the whole table, not just this answer.

A wording answer goes straight to `vibe-ticket-worker`.

Every `vibe-ticket-worker` handoff dispatch carries all the answers so far,
each with the question, the person's exact words, and how it was handled:
`built` (with the change worker's one-line summary), `already met` (with its
evidence), or `wording`. Never send the ticket worker a behavior answer the
change worker has not handled; it refuses one with `NEEDS_CHANGE`.

## Workers

| Step | Worker |
|---|---|
| Summary | `vibe-handoff-summarizer` |
| ALL source fixes, behavior answers, the missing tests list, product docs drafts and the frozen behavior rows (tests only for a requested pull request) | the SAME persistent `vibe-change-worker` context |
| Judgment guardrails, shared-owner placement, and red flags | `vibe-guardrails-reviewer` |
| Commits | you, with `../vibe/scripts/commit-worktree.mjs` |
| Storybook placement and advice only | read-only `vibe-storybook-decomposer`; the SAME writer applies it |
| Existing code checks, coverage advice, suite and footprint | read-only `vibe-verify-worker` |
| Running app checks with `pnpm control` | read-only `vibe-verify-worker` (control mode) |
| Lighter: tough review | repo `review-soul` and `vibe-adversarial-reviewer`, in parallel |
| Visual QA, logical QA and Metal Andrew | the repository's own read-only skills (step 6) |
| Backend: two review passes | the `workflow-code-review` skill (itself orchestrator-only) |
| Last push and Vercel check | `vibe-environment-worker` (redeploy mode) |
| Next owner, ticket check, and assignment | `vibe-ticket-worker` (lookup mode, then handoff mode, then assign mode) |

## A requested pull request

Without the person's explicit request for a pull request, nothing in vibe or
handoff writes a test. When the person explicitly asks for a pull request to
be raised, full tests for every change in the session are required before it
opens. Resume the SAME writer in `pull-request` mode, the only turn whose
envelope authorizes tests, to write them: every acceptance criterion and
unsuperseded row, production wiring and failure paths, on web and Desktop
where their adapters differ, and every entry on the missing tests list. Run
`node scripts/handoff-inventory.mjs --worktree "<wt>" --phase pull-request`,
then step 3's guardrail check, step 5's checks with the new tests included and
step 6's review on the result, then step 7's commit. The pull request does not
open until those tests pass and their independent review is clean. Handoff
itself still opens none.

## 0. Pick the session

Run `node ../vibe/scripts/vibe-sessions.mjs list` (it uses the checkout the
vibe preflight remembered). Use the session whose worktree you are in. If you
are not in one and more than one session is `active`, list them in plain
words and ask which one to hand off. Read its `liveTicket` and `localFixes`.

If the session has no `liveTicket` (it started before live tickets existed),
dispatch `vibe-ticket-worker` in create mode first; it records the slug on
the session. If it is `handed-off`, tell the person it was already
handed off and stop.

Then run `node ../vibe/scripts/vibe-sessions.mjs codex-sessions --worktree "<wt>"`
so this conversation is recorded on the session too.

### Owned prototype sessions

Use the same recorded persistent writer, owned `prototype/<slug>` worktree,
branch and live ticket. Never create a prototype/handoff/test source writer.
Give the writer the canonical absolute
`<repo-root>/.claude/skills/prototype/SKILL.md` guidance, current inventory and
publication. It performs all source fixes, registry/local metadata and the
missing tests list in its same context, writing no tests. Read-only
specialists/design reviewers return advice; they do not apply it.

The inventory still returns files/base when publication is stale or missing.
Use that provisional evidence for independent checks; only publication freshness
is deferred while code is reviewed. Enforce every other guard, including test
provenance and private-plan checks. Source generation or metadata fixes
resume this SAME writer, never the operational share helper.

Have that writer follow canonical step 7's single design review and
ReadyForReview/tag semantics without a technical-plan approval or another
source/worktree delegation. Preserve the already completed design-review
outcome on the ticket so a continuation does not repeat it.
PrototypeStatus.HandedOff remains owned by prototype-approve; the vibe session
marker is only ownership bookkeeping.

After independent current-result checks/reviews and the missing tests list, the
orchestrator commits. Operational `vibe-prototype-worker` share mode publishes
that exact result through canonical Vercel sharing without editing source.
`NEEDS_REVIEW`/`NEEDS_COMMIT` returns to the same writer/root sequence; missing
registry/source work is never repaired by a publishing helper.

Re-run inventory after share and require every gate, including current
publication, before completing or assigning the ticket. Never give a stale
preview as current. Shared story/footprint rules, next-owner lookup and ticket
assignment stay intact. The final links truthfully name the immutable prototype
preview, full SHA, slug and resolved next owner, not fabricated app/API fields.
Neither vibe nor handoff opens a PR.

## 1. Internal checklist

Run `node scripts/handoff-inventory.mjs --worktree "<wt>" --phase handoff` (the JSON stays out
of the chat). Its `backendChanged` picks how hard the work is checked: the
lighter checks when the session changed no backend code (`backendFiles`, such
as `apps/api`, `packages/api`, `packages/database`, Desktop's main process,
and any migration), the backend checks when it did. If a later inventory run
reports `backendChanged` true (a fix or a behavior answer added backend code),
use the backend checks from then on and update the internal checklist.

Keep the remaining checklist internal: inventory and shared-owner checks,
Storybook coverage and footprint, existing tests and the missing tests list,
validation, integrated review and corrections, browser E2E and the
repository's QA passes, publication, running app checks
with control, next-owner lookup, ticket completion and assignment. Do not show
the person a technical task list, upfront summary or plan to approve. Preserve
the lighter versus backend validation and review weights below.

## 2. Summarize internally

The inventory from step 1 covers the session's redeploy commits and anything
not committed yet. Dispatch `vibe-handoff-summarizer` with the worktree and
the inventory path.

The inventory's `localFixes` are managed local workarounds for symphony-alpha
bugs, each with its owning ticket. Historical entries may be setup-authored;
new entries are authored only by the SAME persistent implementation writer. They
are not the person's work: the inventory already leaves them out of
`changedFiles` and its guardrail checks, and every worker brief from here on
(summarizer, guardrails reviewer, change and backend workers, decomposer,
verify worker, reviewers, environment worker, ticket worker) lists their paths
as out of scope, not to be described, reviewed, edited, or committed. Keep the
summary internal for the ticket; it is not a technical approval request.
Route any correction the person volunteers as "Answers from the person" says: a correction that changes what
the product does goes to the change worker now; the rest go to the ticket
worker in step 8.

## 3. Guardrail check

Read-only guardrails review treats every test the session added, deleted or
changed as a finding, except the inventory's `testRepairs` whose diffs it
confirms changed no assertion and the change log records as repairs, its
`retiredTests` whose deleted files or cases it confirms covered only code the
request retires, and a requested pull request's recorded tests. Reject other test edits and never
retrospectively relabel them. Preserve valid evidence
when resuming interrupted handoff.

Non-publication inventory failures, outside-allowed paths, owner/duplicate
findings and other confirmed source defects resume the SAME persistent writer
in fix mode. It verifies and applies corrections; no backend/guardrails/setup
helper edits source. A `forbidden` or outside-allowed path the request
genuinely needed is removed and logged as
`Engineering needed (forbidden path)` (`../vibe/references/guardrails.md`,
"What may change"), and the ticket worker puts it on the Engineering
checklist. Re-run inventory and independent read-only guardrails
checks. Keep the writer's Design blocks for the ticket.

## 4. Storybook

Read-only `vibe-storybook-decomposer` advises on components/stories/catalog
gaps in handoff mode: its precedent search covers every story or shared
component the session added, retitled or moved, checked against the Placement
blocks in the writer's local plan. Each placement goes on the live ticket's
Storybook placement line; the SAME writer logs each Conflict with its
audience, and the ticket worker places it by that audience
(`../vibe/references/ticket-template.md`, "Conflicts"), never to the person.
Every new story follows the repo's `apps/storybook/TAXONOMY.md`, a v1.0
story file is never edited and any other existing story file keeps its title
and tag
(`../vibe/references/guardrails.md`, "Storybook taxonomy"); the inventory's
`v1Stories` and `retitledStories` block handoff. Resume the SAME writer to perform every extraction, story and catalog
source change. Read-only verify footprint mode measures the sidebar and
reports remaining problems; they return to the writer, never another author.
Collect Design Review evidence from the verified final diff and existing
Storybook tooling: added/changed/removed components and stories, actual IDs
and direct links, controls/Docs/plays declared versus inspected/executed,
intentional ID/category moves/sidebar folds and retained state access. Keep
actual compiled footprint/canonical catalog reports and unresolved advisories.
Source inspection alone does not clear a compiled warning or prove appearance.

## 5. Checks and the missing tests list

Resume the SAME writer with an explicit handoff continuation, inventory,
private local coverage plan and the whole session decision table, including
its `## Acceptance Criteria` list and checks log. It first checks every
unsuperseded criterion against the final code
(`../vibe/references/quality-loop.md`, "Acceptance criteria before ready"),
and that list is where its whole-table alignment starts.
Read all requests, stable row IDs, cross-request interactions and its
`Required Tests`, including positive, negative and mixed-state production-boundary
cases. It authors no tests. It runs the existing affected tests, fixes the
session's own code when one fails, never what a test asserts (it only repairs
an existing test the session's change broke), and lists every missing
test as engineering's scope of work: the behavior and row ID that needs it,
the files to cover, and any existing test a recorded human behavior ruling
made obsolete, with that ruling. The verify worker never writes or fixes tests.
The same writer checks implementation and executed existing coverage against
every required unsuperseded row, including earlier requests. Planned coverage
is not executed coverage; a row without an existing test goes on the missing
tests list, never counted as covered.

Lighter: read-only verify checks mode runs Biome without write flags, gates,
affected types/tests and relevant existing lanes. Backend: full-suite mode
runs every required lane. Both report defects back to this same writer.
Do not weaken tests, skip required coverage or fall back to visible automated
browser/Electron windows. Record exact unsupported local limitations.

### Existing feature docs

In the same handoff continuation, the SAME writer updates the product docs
pages under `apps/web/content/docs/` that already exist for the features this
session changed, on this branch, under `../vibe/references/guardrails.md`,
"Feature docs at handoff". It never edits the internal engineering `docs/`
folder; those docs belong to engineering's pull request. It edits existing
pages only and never creates one; every edit is marked as
an agent draft that design or engineering approves before merge. This is
Daniel Ochoa's explicit, scoped exception to the rule that agents do not
author user-visible words. It covers only those marked drafts and gives no
license for product copy or any other words. The writer records each edited page, or
that no existing page covers the changed features, for the ticket's Feature
docs line. Owned prototype sessions skip this step. Step 6 reviews these
edits with the rest of the diff.

## 6. Independent integrated review

Exclude exactly `.closedloop-ai/vibe-plans/` and historical `localFixes` from
deliverable review, not other artifacts. Reviewers may read the local plans
for context. Pass phase handoff, the inventory's `testRepairs` and
`retiredTests`, and the writer's missing tests list.
Pass the whole session decision table and actual row/test evidence to each
reviewer. The alignment below starts from the table's Acceptance Criteria
list and the writer's latest check of each criterion; a criterion not met is
a source gap for the SAME writer or a product question under "Answers from
the person", never counted as met. They read the actual artifact and use named core decision-table's
consistency, review-prevention and applicable adversarial rules. Missing source,
existing-test run or independent-review evidence blocks final handoff; a test
that does not exist yet is listed under Missing tests instead. Require defensible
`Final Alignment Status: Aligned` for the whole table before step 7 or final
ticket completion; Not aligned is a stop, not a success with a test-later note.

Lighter: repo `review-soul` and `vibe-adversarial-reviewer`
may review independently in parallel, read-only. Backend: named core
`workflow-code-review` runs its two existing review passes
(`$workflow-code-review` in Codex or `/closedloop-core:workflow-code-review` in
Claude Code). ALL confirmed code/story findings resume the SAME writer,
which verifies and corrects them; recheck its current result and repeat
validation. A coverage gap goes on the missing tests list; nobody writes a
test here.

### Browser E2E and the repository's QA passes

These run here and never in the build loop (Daniel Ochoa's ruling,
2026-10-13). Browser E2E runs headless in step 5's checks and step 7's
validation. For the screens the session touched, run the repository's own
read-only passes where its root `AGENTS.md` calls for them on this change:
visual QA (`/visual-qa` in Claude Code, `$visual-qa` in Codex) for a UI
change, logical QA (`/logical-qa`, `$logical-qa`) for a data or metric
surface, then Metal Andrew (`/metal-andrew`, `$metal-andrew`) once that
evidence is visible. Each skill dispatches its own read-only agents. Confirmed
findings resume the SAME writer in fix mode, then steps 3 to 6 run again on
the result. Their reports feed the Design Review evidence in step 8. Owned
prototype sessions keep their canonical single design review instead.

## 7. Upload the last changes

ROOT commits the reviewed deliverable LOCALLY through the existing commit
script/normal hooks, still unpushed, before `commit-worktree.mjs --prepare-main-sync`.
This includes the SAME writer's reviewed handoff fixes and docs drafts, not
private plans or protected localFix source. No change needs no extra local commit.

Resume the same actor for source-owned `main-sync-inputs` before preparation
and again after the Root-owned committed merge/fix result, using environment.md.
End readiness's record turn, then ROOT grants its returned opaque witness as
`mainSyncValidation` for that same actor's validation continuation. Preserve
private diagnostics/retained reports; unknown generated inputs or consumed
retained evidence block, never a directory exemption or old report PASS.
Readiness is not test authority or completed coverage. `requiredE2eComplete`
must still be actually true before final coverage/assignment.

First repeat `../vibe/references/environment.md`, "Main-sync before publication",
with handoff purpose. The SAME writer extends/checks its whole session table
before fixes; a separate exact publisher preparation turn fetches fresh main,
stages an ordinary NONCOMMITTING merge after the owned Desktop stops, then ends.
Every source/conflict/generator fix stays with the original
writer/registration; ROOT alone commits. Captured synced main separates imports
from feature work, retaining original history and real test-edit violations.

Run `node ../vibe/scripts/vibe-sessions.mjs codex-sessions --worktree "<wt>"`
again, then ROOT commits the staged merge and any subsequent reviewed fixes as one more
commit (nothing is squashed or amended):
`node ../vibe/scripts/commit-worktree.mjs --worktree "<wt>" --subject "<live ticket slug>: <plain imperative summary of the handoff fixes>" --body "<what was fixed, one per line>"`
(under 72 characters, no mention of AI tools). `committed: false` means
nothing changed. A commit the hook refused goes back to step 5's fixing, then
this step again. Resume the SAME writer's source-owned `progress` continuation
with parent-controlled handoff purpose/transaction to execute
`main-sync-validate` against committed input. Dirty tracked localFix source is
NOT a check exception: preserve/block through its same-writer workaround flow,
never stash/copy/delete or accept different checked/deployed bytes.
Then dispatch `vibe-environment-worker` in redeploy mode
from handoff with the worktree, the live ticket slug, the confirmed summary,
the inventory's `localFixes` paths, the missing tests list (including any
obsolete expectation with its human ruling) and any verified pre-existing
failures outside this work. It runs the tests, pushes through the repo's pre-push
checks, requests the environment again so that commit is deployed, and
updates the ticket. Pass matching `mainSyncTransactionId`, handoff purpose and
actual new grant context on stdin. `main-sync-push` returns
`alreadyPublished: true`, `pushed: false` only for the exact checked/verified
current result; issue NO synthetic request/redeploy then. Explicit flags/Desktop
work remains distinct under its own request-only grant, never publisher rights.
A push refused by the
repo's checks goes back to step 5's fixing, then the commit and this step
again. On `NEEDS_DESKTOP_STOP`, dispatch
`vibe-setup-worker` to stop Desktop, then this step again (Desktop is not
started again at handoff).
Every publication helper also receives the same required table path and
whole-table alignment/row evidence from step 6; it never authors or replaces
that artifact or claims missing final evidence is a successful handoff.

Publication readiness may precede external E2E completion for this FINAL
handoff snapshot: retain exact named limitations, safely publish the committed
SHA for existing CI/live QA, and keep final coverage/assignment incomplete.
No feature PR or automatic manual-CI trigger is added. ROOT routes CI permission
internally; never ask the vibe coder for technical-plan approval.
For actual authorized/completed evidence, ROOT binds `mainSyncCiRun: {runId, attempt}`
in the SAME writer's actual source progress/handoff grant, then resumes
`main-sync-validate` on the same captured-main transaction without another fetch
loop. The consumer verifies real canonical run/job/step identity and actual
checkout-action/pre-test env SHA against unchanged HEAD/tree/input, not caller
PASS or workflow main head_sha. Changed source invalidates proof and returns
to this same writer's fresh preparation/correction flow. Keep whole-table
tests/reviews and source-phase authority separate from the CI reader.
Do not proceed to final assignment/alignment with `requiredE2eComplete: false`
or any other required coverage gap, even when publicationReady is true.

## 8. Choose who picks it up, then check the ticket

### Running app verification

After step 7 verifies the final publication, dispatch read-only
`vibe-verify-worker` in control mode with the worktree, the inventory and the
screens the session touched. It drives the running web app and Desktop with
the repository's control skill (`<repo-root>/.claude/skills/control/SKILL.md`,
the `pnpm control` CLI) on that final commit, for each touched screen, and
follows that skill's own rules: hidden browser and app only (never
`--headed`, and never a visible window on the person's Mac; on Linux, Desktop
runs displayless), read-only sessions (never `--allow-write`), and
`pnpm control down` for every session it started. Control's own throwaway Desktop
profile is separate from the session's Desktop, which stays stopped. It
captures each screen's evidence (capture, console errors and page errors,
network, API reads and Desktop IPC reads where relevant), before and after
when a baseline exists, and returns each artifact path with what it proves.

A surface it cannot drive comes back with the exact control command and the
reason, never as verified. A console error, page error, failed request or
broken screen this session caused resumes the SAME writer in fix mode, then
steps 3 to 7 and this check again. Owned prototype sessions skip this check
and record why: a mockup changes no web app or Desktop screen. The build loop
has no control step; this check runs only here. The writer's single control
read for an acceptance criterion (`../vibe/references/quality-loop.md`,
"Acceptance criteria before ready") is not this check. Its evidence goes into the
Design Review's Visual evidence and the Handoff Running app checks line,
separated from source-only claims.

### Design Review evidence at handoff

After step 7 verifies the final publication, collect the design-facing packet
from the verified final diff, environment/prototype receipts, existing
Storybook inventory/footprint/catalog tooling and actual design/visual-QA
reports. The SAME writer assembles detailed design evidence in existing
private Git metadata, not the local technical plan. Read-only summary,
Storybook and verify helpers contribute facts and existing report paths; no
new source author or runtime tool is created. A compact helper response points
to the detailed evidence instead of truncating required component/story rows.

Collect the existing ticket template's **Production impact**, **Flag changes
and gates**, and **Open Questions** fields in that same detailed final packet.
Production impact is production-only added/changed/removed paths and effects
**if merged**, including shared-parent consumers and relevant web/Desktop
effects; it is not already shipped. Keep story/test/prototype-only inventory
separate. The flag evidence covers exact new/existing modified/removed keys
and relevant entry/read/mutation/host gates, including existing gates when
there are no new flags. Keep source defaults, timestamped actually verified
production values and local QA toggles distinct; unavailable/stale verification
is not permission to guess or overwrite/refresh the machine snapshot.
For Open Questions, reuse quality-loop's graph plus live answered-decision
research; include sources, context and the necessary Product/Design/Scope
decision, excluding settled answers and engineering limitations. Record None
when none remain, not a technical approval request or invented product copy.
Summary and verify helpers contribute these source/evidence facts; the SAME
writer assembles them under the template's canonical field rules. After a
source/deployment/answer change, refresh affected metadata before ticket fill
and distinguish historical evidence from the final delivered result.

The live ticket's Design Review section gives design everything needed to
grade the finished code and its appearance/Storybook implementation:

- Exact App and Storybook previews, full verified deployed commit and
  protection/access evidence and timestamp. Never change protection or include
  credentials/private Desktop bridge URLs. For an owned prototype preserve
  its immutable canonical preview and source-backed unavailable/N/A surfaces,
  not an invented app or Storybook environment.
- Requested scope/screens and relevant hosts/states, with actual inspection
  separated from source-only and unverified coverage.
- Added/changed/removed components/stories with IDs/direct links (full
  Storybook UI links, never the bare `iframe.html` canvas;
  `../vibe/references/environment.md`, "Storybook links"), controls,
  Docs and plays, intentional ID/category moves/sidebar folds and retained
  state access; removed/unavailable historical links are identified honestly.
- Actual footprint/canonical catalog commands, baseline/current commits and
  reports, including unresolved advisories and their dispositions.
- Actual design/visual-QA reports and screenshots with inspected commits,
  viewports/dimensions, hosts and states, and accessible links/attachments,
  including the running app verification's control captures with their
  artifact paths and what each proves. Source-only, unverified, failed and
  unsupported coverage remains explicit, with the exact control command and
  reason for a surface control could not drive.
- Known gaps and remaining design decisions/owners, with no invented copy and
  no technical approval request to the Vibe coder. Existing required visual
  and product approval gates remain intact; the next owner still grades it.

Never claim looks good or Storybook correct without actual inspection/check
evidence. If the source or deployment changed after collection, refresh the
packet and distinguish historical evidence from the actual delivered result.
Unavailable evidence is a truthful gap, not a fabricated pass. This section is
finished-work metadata, never a technical plan uploaded for approval.

Use a next owner the person already named for this handoff; never re-ask that
settled choice or infer an owner from a company default. If nobody was named,
have the ticket worker check the current session's prior decisions first.
Only if the necessary choice remains unresolved, ask one plain question in
exactly these words:

```
Who should pick this up next? A name or email is fine.
```

Dispatch `vibe-ticket-worker` in lookup mode with the worktree and their
exact words. It reads every ClosedLoop user, matches the words through
`scripts/match-assignee.mjs`, changes nothing, and returns:

- `DONE` with one user's id, full name, and email. Keep the assignment progress
  internal and ask nothing more about it; report the next owner at completion.
- `NEEDS_PERSON` with several users. Ask
  `More than one person matches "<their words>". Which one?` and list each
  on its own line as `<full name> (<email>)`. Dispatch lookup mode again with
  the email of the one they pick.
- `NEEDS_PERSON` with no match. Say
  `I couldn't find anyone in ClosedLoop matching "<their words>".` and ask
  the question again.

Never pick the person yourself and never fall back to anyone by default: the
ticket goes only to the user the person named. Design reviewing first and
engineering finishing is the usual route, but the person decides.

Before the handoff-mode dispatch below, resume the SAME writer to add the
session decision table's `## Frozen Behavior` section, listing the rows the
person accepted (`../vibe/references/quality-loop.md`, "Frozen behavior at
handoff"). Have it refresh that section after any behavior answer that changes
the table, before the ticket worker sees the table again.

Then dispatch `vibe-ticket-worker` in handoff mode with: the worktree, the live
ticket slug, the next owner (full name and email), the inventory path, the
confirmed summary and the person's corrections, the footprint, check, and
review summaries, the Design blocks from build and handoff fixes, the required session decision table
at `.closedloop-ai/decision-tables/<session-slug>.md` with whole-table alignment,
row/test evidence and its Frozen Behavior row IDs, the writer's feature docs
record, the missing tests list, the inventory's `retiredTests` with each deleted
file or case, the running app verification's artifact paths
with what each proves and any surface it could not drive with its command and
reason, the detailed Design Review evidence packet/report paths,
including Production impact, Flag changes and gates, and researched Open
Questions per `../vibe/references/ticket-template.md`,
and every answer from the person so far with how it was handled. Keep
technical plans under `.closedloop-ai/vibe-plans/` local: never upload them or
include their body in this ticket dispatch. It
refreshes the record sections (the Environment base commit from the current
inventory), re-derives every section an answer touches, fills the Handoff and
Grading sections, reconciles the backend sections, attaches the files, and
runs
`scripts/live-ticket-check.mjs`. It returns:

- `DONE` when the ticket is complete.
- `NEEDS_PERSON` with what only the person can supply (for example acceptance
  criteria they never stated), marked `behavior` or `wording`. Ask the person,
  then route their answer as "Answers from the person" says: a behavior
  answer goes through the change worker, the checks, the reviews, and the
  redeploy before the ticket worker sees it again.
- `NEEDS_CHANGE` with an answer or criterion the code has not been checked
  against. Resume the SAME persistent writer in fix mode and continue the same
  way.

Repeat until it returns `DONE`. Never go on to step 9 while a behavior answer
has not been through the change worker, while its re-run checks, reviews,
or redeploy are unfinished, or without a next owner the lookup resolved to
exactly one user.

## 9. Hand it over

Dispatch `vibe-ticket-worker` in assign mode with the worktree, the live
ticket slug, and the next owner's user id and email from step 8. It confirms
the ticket is still assigned to the session's operator, the person who ran it
(if engineering or design already took it, it returns `BLOCKED` and you stop:
that branch is theirs now), assigns it to the next owner, and leaves the
status In Progress.

Then mark the session handed off:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree "<wt>" --status handed-off`,
and dispatch `vibe-setup-worker` to stop local Storybook or Desktop if either
runs.

Tell them, in a few lines: the ticket link, the app link as
`<appUrl>/sign-in` (the app's root sends a signed-out visitor to account
creation), the Storybook link (the full Storybook UI per
`../vibe/references/environment.md`, "Storybook links"), the
branch name, and what happens next: the next owner, by name, picks it up
from the ticket (usually design reviews the components in Storybook and
comments on the ticket on sign-off, then engineering finishes it). Say that the Storybook link opens only after
signing in to Vercel with a team account. If you open it and land on a
`vercel.com` sign-in or `sso-api` page, say exactly that rather than that
Storybook is broken, and do not try to get around it.
