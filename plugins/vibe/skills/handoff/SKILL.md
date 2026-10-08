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

Test writing happens only here at handoff, through `vibe-verify-worker` in
`tests` mode (`../vibe/references/guardrails.md`, "Tests"). Build-loop workers
never write or edit tests. Add coverage for the delivered behavior, preserve
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

A behavior answer goes to `vibe-change-worker` in fix mode first, with the
question and the person's answer verbatim. It checks the code against the
answer on every screen it touches and either reports the code already meets
it (with the evidence, no file changed) or builds it under its usual rules
(a backend need comes back as `NEEDS_BACKEND` for `vibe-backend-worker`). If
it changed any file, re-run before the ticket is finished: step 3 (inventory
and guardrails), step 4 when a component or story changed, step 5 (checks),
step 6 on the result (lighter: both reviewers; backend: one
`workflow-code-review` pass), and step 7 (the redeploy). Only then does the
answer go to `vibe-ticket-worker`.

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
| Guardrail and review fixes, behavior answers | `vibe-change-worker` (fix mode: give it the findings, or the question and the person's answer); backend findings to `vibe-backend-worker` (fix mode) |
| Judgment guardrails, shared-owner placement, and red flags | `vibe-guardrails-reviewer` |
| Commits | you, with `../vibe/scripts/commit-worktree.mjs` |
| Storybook | `vibe-storybook-decomposer` |
| Test authoring only at handoff, code checks, whole test suite, Storybook footprint | `vibe-verify-worker` |
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

An owned session on `prototype/<slug>` follows the same summary, guardrails,
lighter checks and reviews, next-owner lookup, complete-ticket check, and
assignment below. The inventory's `prototype` publication identifies this
path; an arbitrary prototype branch without the matching private ownership
record is refused. Give every worker that publication and the canonical
prototype skill's absolute `<repo-root>/.claude/skills/prototype/SKILL.md` path.
Keep every `localFixes` path excluded as usual.

The inventory always returns the owned prototype's files and base, including
when publication is missing or stale. If its
`blocking.prototypePublicationCurrent` is false, dispatch the prototype worker
in share mode with `publicationProblem`, then re-run inventory before the
checks. This recovers an unshared or newly committed iteration through the
canonical share procedure; a failed share stays blocked with its evidence.

Route behavior answers and all guardrail/review/check fixes to
`vibe-prototype-worker` in fix mode, using the same person's words and findings.
Run steps 3 through 6 again after changes. Storybook decomposition and footprint
cover the canonical shared surface and its stories, not the mock sandbox host;
the prototype worker also runs the canonical catalog, registry, decision-log,
lint and type checks. Mock-only sandbox state is intentional under that
canonical contract; do not create app backend stubs or a production flag
snapshot to satisfy the app-only checks.

In step 7 dispatch `vibe-prototype-worker` in prepare-handoff mode instead of
the environment worker; on its `NEEDS_COMMIT`, commit with
`../vibe/scripts/commit-worktree.mjs` using the message it gives, then
dispatch it again. It preserves canonical step 7's single design review,
ReadyForReview and tags, retains the review outcome on the ticket, and shares
the resulting commit through canonical step 5.5 without opening a PR.
PrototypeStatus.HandedOff remains owned by prototype-approve. Re-run inventory
on the returned publication before ticket completion. A failed or stale share
blocks handoff until the same work is repaired and published.

At every prototype recovery share or prepare-handoff call, route `NEEDS_REVIEW`
through independent guardrails/adversarial reviewers and the verify worker,
with phase `handoff` and the existing test-authoring record (or its absence for
the early-test check). Fix and recheck the current diff, then resume the same
canonical worker with that evidence; keep its single completed design review.
If tests need authoring, run the handoff tests mode after the early-test check.
While obtaining this review evidence, use the inventory's files and base even
when only `prototypePublicationCurrent` is false: publication freshness is a
deferred publication gate, not a reason to skip code checks or repeatedly fix
an unshared preview. All other blocking checks stay enforced. After sharing,
rerun inventory and require every gate, including publication freshness, before
ticket completion or assignment. No stale preview is reported as current.

Steps 8 and 9 remain unchanged: the person names the next owner, lookup resolves
them, the complete live ticket is checked against this owned publication,
assignment is verified with status In Progress, and the private vibe session
is marked handed-off. That session marker does not approve prototype metadata.
The final links are the ticket and immutable prototype preview, with full
deployed SHA, slug, branch, and resolved next owner. Do not report app, API,
or Storybook deployments for a prototype session. No PR is opened here.

Use the lighter task list below for this flow, naming the prototype preview
in the upload item using the canonical prototype label instead of promising
an app deployment. Shared component stories and their footprint remain part
of the handoff.

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

The inventory's `localFixes` are files the setup worker changed on this Mac to
work around a symphony-alpha bug (each with the ticket that reports it). They
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

Before test authoring, have the guardrails reviewer check every already changed
test against an existing explicit handoff test-authoring record. Early or
unrecorded build edits are rejected now, not retrospectively relabeled as
handoff coverage by writing a new record. Preserve valid recorded coverage
when resuming an interrupted handoff; do not revert another worker's work.

If any non-publication `blocking` check fails, or `outsideAllowed` is non-empty,
dispatch `vibe-change-worker` in fix mode with those findings. Then dispatch
`vibe-guardrails-reviewer`, and pass any findings to `vibe-change-worker`
(backend findings to `vibe-backend-worker`), both in fix mode. Its
shared-owner findings and red flags (`../vibe/references/design-pass.md`,
"Quality depth before handoff") are fixed by restructuring the code to the right owner
(behavior the children of a shared parent share goes in the parent; each
child keeps only what is specific to it), with a sibling sweep, without
asking the person; keep each fix's Design
block for step 8. Re-run the inventory until every blocking check passes.

## 4. Storybook

Dispatch `vibe-storybook-decomposer` with the inventory's
`componentsWithoutStories` and the changed `packages/design-system`
components. Then dispatch `vibe-verify-worker` in footprint mode: it runs
`pnpm vibe storybook-diff`, sends every governance `problem` back through the
decomposer, and confirms every new component appears in the sidebar. Keep its
footprint summary for the ticket.

## 5. Checks

First dispatch `vibe-verify-worker` in `tests` mode with explicit phase `handoff`, acceptance criteria,
inventory and local plan's coverage needs, for app and prototype sessions.
It writes or extends focused tests only at this handoff boundary. Route any
implementation defect it proves to the owning worker, then rerun the tests.

Lighter: dispatch `vibe-verify-worker` in checks mode. It runs Biome, source
gates, affected typecheck and tests, fixes failures in the session's own
changes, never weakens a test, and returns a short pass/fail summary plus any
pre-existing failures it left alone.

Backend: dispatch `vibe-verify-worker` in full-suite mode instead. It runs every
lane, fixes failures in the session's own changes, and never weakens a test.

## 6. Reviews

Exclude only the exact local-plan folder `.closedloop-ai/vibe-plans/` from
deliverable review, as well as recorded `localFixes`; do not broadly exclude
other `.closedloop-ai` files. Plan-mode review reads the local plan explicitly.

Lighter: dispatch the repo agent `review-soul` (`.claude/agents/review-soul.md`)
and `vibe-adversarial-reviewer` in implementation mode in parallel on the worktree. Pass their
findings to `vibe-change-worker` in fix mode; it verifies each finding against
the code before fixing and reports fixed and rejected (with one line why).
Then run step 5 again.

Give all handoff reviewers phase `handoff` and the verify worker's test-authoring
record, so they review legitimate coverage rather than applying the build-loop
test-writing ban to it.

Backend: run the `workflow-code-review` skill (`$workflow-code-review` in Codex,
`/closedloop-core:workflow-code-review` in Claude Code) on the worktree's changes against
the session's base. It dispatches its own reviewer workers; you only receive
its consolidated findings. Send frontend findings to `vibe-change-worker` and
backend findings to `vibe-backend-worker`, both in fix mode, then run the full
suite again (step 5). Then run `workflow-code-review` a second time on the
result and repeat the fix and suite steps for anything it confirms. Keep both
passes' fixed and rejected lists for the ticket.

In both weights, route a confirmed missing-test finding to `vibe-verify-worker`
in `tests` mode, then rerun step 5 and review the added coverage. Never weaken
an existing test or check to clear a finding.

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

## 8. Choose who picks it up, then check the ticket

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
review summaries, the Design blocks from build and handoff fixes, the decision tables in `.closedloop-ai/decision-tables/` if
any, and every answer from the person so far with how it was handled. Keep
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
  against. Send it to `vibe-change-worker` in fix mode and continue the same
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
