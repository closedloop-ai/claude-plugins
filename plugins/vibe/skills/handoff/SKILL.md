---
name: handoff
description: Finish a vibe session in symphony-alpha and hand it to whoever picks it up next, usually design and then engineering. Through workers, completes internal scope and Storybook checks, writes focused tests at handoff, runs lint, typecheck and tests, reviews the integrated result and fixes confirmed findings. Asks who should pick the work up next, checks the live ticket is complete, publishes the final app environment or canonical prototype preview, and assigns the ticket with status left In Progress. It ends at the branch; no pull request is opened. Use when someone says "handoff", "hand this off", "send this to engineering", or "I'm done with this". Pairs with the vibe skill.
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
follows `../vibe/references/ticket-template.md`.

Test writing happens only here at handoff, through the SAME persistent
`vibe-change-worker` in handoff mode (`../vibe/references/guardrails.md`, "Tests").
Verification/review helpers are read-only. Add coverage for delivered behavior, preserve
test integrity and fix implementation defects rather than weakening a check.
Code quality and implementation reviews already run before handoff; these are
final integrated checks, not the first attempt to correct preventable issues.
Handoff opens no pull request.

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
Preserve the existing session's original recorded binding and actual ID;
quality-loop's root continuation supplies this policy without a changed
definition/root registration. Unavailable original binding blocks new code,
not permission to copy a legacy agent, reset or replace the writer.

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
`workflow-code-review` pass), and step 7 (the redeploy). Only then does the
answer go to `vibe-ticket-worker`.
Before code, extend the same session decision table with the answer's source,
row IDs, cross-request interactions and explicit Superseded decisions. Preserve
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
| ALL source fixes, behavior answers and test authoring | the SAME persistent `vibe-change-worker` context |
| Judgment guardrails, shared-owner placement, and red flags | `vibe-guardrails-reviewer` |
| Commits | you, with `../vibe/scripts/commit-worktree.mjs` |
| Storybook advice only | read-only `vibe-storybook-decomposer`; the SAME writer applies it |
| Existing code checks, coverage advice, suite and footprint | read-only `vibe-verify-worker` |
| Lighter: tough review | repo `review-soul` and `vibe-adversarial-reviewer`, in parallel |
| Backend: two review passes | the `workflow-code-review` skill (itself orchestrator-only) |
| Last push and Vercel check | `vibe-environment-worker` (redeploy mode) |
| Next owner, ticket check, and assignment | `vibe-ticket-worker` (lookup mode, then handoff mode, then assign mode) |

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
publication. It performs all source fixes, registry/local metadata and
handoff-only tests in its same context. Read-only specialists/design reviewers
return advice; they do not apply it.

The inventory still returns files/base when publication is stale or missing.
Use that provisional evidence for independent checks; only publication freshness
is deferred while code is reviewed. Enforce every other guard, including early
test provenance and private-plan checks. Source generation or metadata fixes
resume this SAME writer, never the operational share helper.

Have that writer follow canonical step 7's single design review and
ReadyForReview/tag semantics without a technical-plan approval or another
source/worktree delegation. Preserve the already completed design-review
outcome on the ticket so a continuation does not repeat it.
PrototypeStatus.HandedOff remains owned by prototype-approve; the vibe session
marker is only ownership bookkeeping.

After independent current-result checks/reviews and handoff test coverage, the
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
Storybook coverage and footprint, handoff-only test authoring, validation,
integrated review and corrections, publication, next-owner lookup, ticket
completion and assignment. Do not show the person a technical task list,
upfront summary or plan to approve. Preserve the lighter versus backend
validation and review weights below.

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

Before test authoring, read-only guardrails review checks already changed tests
against an existing handoff authoring record from this SAME writer. Reject
early/unrecorded edits, never retrospectively relabel them. Preserve valid
evidence when resuming interrupted handoff.

Non-publication inventory failures, outside-allowed paths, owner/duplicate
findings and other confirmed source defects resume the SAME persistent writer
in fix mode. It verifies and applies corrections; no backend/guardrails/setup
helper edits source. Re-run inventory and independent read-only guardrails
checks. Keep the writer's Design blocks for the ticket.

## 4. Storybook

Read-only `vibe-storybook-decomposer` advises on components/stories/catalog
gaps. Resume the SAME writer to perform every extraction, story and catalog
source change. Read-only verify footprint mode measures the sidebar and
reports remaining problems; they return to the writer, never another author.
Collect Design Review evidence from the verified final diff and existing
Storybook tooling: added/changed/removed components and stories, actual IDs
and direct links, controls/Docs/plays declared versus inspected/executed,
intentional ID/category moves/sidebar folds and retained state access. Keep
actual compiled footprint/canonical catalog reports and unresolved advisories.
Source inspection alone does not clear a compiled warning or prove appearance.

## 5. Checks and handoff-only tests

Resume the SAME writer with an explicit handoff continuation, acceptance
criteria, inventory, private local coverage plan and the whole session decision table.
Read all requests, stable row IDs, cross-request interactions and its
`Required Tests`, including positive, negative and mixed-state production-boundary
cases. It alone writes/extends tests
and fixes implementation defects, records criteria/paths/human rulings and
runs them. The verify worker never writes or fixes tests.
The same writer checks implementation and actual executed coverage against
every required unsuperseded row, including earlier requests. Planned coverage
is not executed coverage; missing cases return to that writer now.

Lighter: read-only verify checks mode runs Biome without write flags, gates,
affected types/tests and relevant existing lanes. Backend: full-suite mode
runs every required lane. Both report defects back to this same writer.
Do not weaken tests, skip required coverage or fall back to visible automated
browser/Electron windows. Record exact unsupported local limitations.

## 6. Independent integrated review

Exclude exactly `.closedloop-ai/vibe-plans/` and historical `localFixes` from
deliverable review, not other artifacts. Separate plan review reads the local
plan explicitly. Pass phase handoff and the writer's test-authoring record.
Pass the whole session decision table and actual row/test evidence to each
reviewer. They read the actual artifact and use named core decision-table's
consistency, review-prevention and applicable adversarial rules. Missing source,
test or independent-review evidence blocks final handoff. Require defensible
`Final Alignment Status: Aligned` for the whole table before step 7 or final
ticket completion; Not aligned is a stop, not a success with a test-later note.

Lighter: repo `review-soul` and `vibe-adversarial-reviewer` implementation mode
may review independently in parallel, read-only. Backend: named core
`workflow-code-review` runs its two existing review passes
(`$workflow-code-review` in Codex or `/closedloop-core:workflow-code-review` in
Claude Code). ALL confirmed code/story/test findings resume the SAME writer,
which verifies and corrects them; recheck its current result and repeat
validation. Missing handoff coverage is written only by that writer.

## 7. Upload the last changes

Run `node ../vibe/scripts/vibe-sessions.mjs codex-sessions --worktree "<wt>"`
again, then commit everything the checks and reviews changed as one more
commit (nothing is squashed or amended):
`node ../vibe/scripts/commit-worktree.mjs --worktree "<wt>" --subject "<live ticket slug>: <plain imperative summary of the handoff fixes>" --body "<what was fixed, one per line>"`
(under 72 characters, no mention of AI tools). `committed: false` means
nothing changed. A commit the hook refused goes back to step 5's fixing, then
this step again. Then dispatch `vibe-environment-worker` in redeploy mode
from handoff with the worktree, the live ticket slug, the confirmed summary,
the inventory's `localFixes` paths, the test-authoring record and any verified
pre-existing failures outside this work. It runs the tests, pushes through the repo's pre-push
checks, requests the environment again so that commit is deployed, and
updates the ticket. If nothing changed since the last redeploy, it confirms
the branch and the environment are current instead. A push refused by the
repo's checks goes back to step 5's fixing, then the commit and this step
again. On `NEEDS_DESKTOP_STOP`, dispatch
`vibe-setup-worker` to stop Desktop, then this step again (Desktop is not
started again at handoff).
Every publication helper also receives the same required table path and
whole-table alignment/row evidence from step 6; it never authors or replaces
that artifact or claims missing final evidence is a successful handoff.

## 8. Choose who picks it up, then check the ticket

### Design Review evidence at handoff

After step 7 verifies the final publication, collect the design-facing packet
from the verified final diff, environment/prototype receipts, existing
Storybook inventory/footprint/catalog tooling and actual design/visual-QA
reports. The SAME writer assembles detailed design evidence in existing
private Git metadata, not the local technical plan. Read-only summary,
Storybook and verify helpers contribute facts and existing report paths; no
new source author or runtime tool is created. A compact helper response points
to the detailed evidence instead of truncating required component/story rows.

The live ticket's Design Review section gives design everything needed to
grade the finished code and its appearance/Storybook implementation:

- Exact App and Storybook previews, full verified deployed commit and
  protection/access evidence and timestamp. Never change protection or include
  credentials/private Desktop bridge URLs. For an owned prototype preserve
  its immutable canonical preview and source-backed unavailable/N/A surfaces,
  not an invented app or Storybook environment.
- Requested scope/screens and relevant hosts/states, with actual inspection
  separated from source-only and unverified coverage.
- Added/changed/removed components/stories with IDs/direct links, controls,
  Docs and plays, intentional ID/category moves/sidebar folds and retained
  state access; removed/unavailable historical links are identified honestly.
- Actual footprint/canonical catalog commands, baseline/current commits and
  reports, including unresolved advisories and their dispositions.
- Actual design/visual-QA reports and screenshots with inspected commits,
  viewports/dimensions, hosts and states, and accessible links/attachments.
  Source-only, unverified, failed and unsupported coverage remains explicit.
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

Then dispatch `vibe-ticket-worker` in handoff mode with: the worktree, the live
ticket slug, the next owner (full name and email), the inventory path, the
confirmed summary and the person's corrections, the footprint, check, and
review summaries, the Design blocks from build and handoff fixes, the required session decision table
at `.closedloop-ai/decision-tables/<session-slug>.md` with whole-table alignment
and row/test evidence, the detailed Design Review evidence packet/report paths,
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
creation), the Storybook link, the
branch name, and what happens next: the next owner, by name, picks it up
from the ticket (usually design reviews the components in Storybook and
comments on the ticket on sign-off, then engineering finishes it). Say that the Storybook link opens only after
signing in to Vercel with a team account. If you open it and land on a
`vercel.com` sign-in or `sso-api` page, say exactly that rather than that
Storybook is broken, and do not try to get around it.
