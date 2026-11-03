---
name: handoff
description: Finish a vibe session and hand it to whoever picks it up next, usually design and then engineering. Settles in plain words how the session ends: a pull request the person takes through review and merge (plain-language intent such as "I'll get the PR merged" counts as asking for one), or passing it to someone, asking for a name or email only then. When the person later asks for changes on that pull request, resumes the session so the same writer fixes it, pushes to the same branch and answers each review thread with the fixing commit. Use when someone says "handoff", "hand this off", "send this to engineering", or "I'm done with this". Pairs with the vibe skill.
---

# Handoff

The person ran `vibe` and built something they are happy with. You
orchestrate making it safe and complete for the next people, without asking
them to understand any of the engineering. The session's live ClosedLoop
ticket was created when the session started and the workers kept it current;
handoff checks it is complete rather than writing it. The session ends one
of two ways. The person can ask for a pull
request they take through review and merge themselves ("A requested pull
request"): handoff opens it as its last step and the ticket stays with them.
Or they pass it to someone, and the ticket is assigned to whoever they name.
Usually that is design, who reviews the components in the branch's Vercel
Storybook and comments on the ticket on sign-off, then engineering, who
finishes the work through analysis, a pull request, and merge; sometimes it
goes straight to engineering. The ticket stays In Progress throughout. Never
say "handoff" to the person as if they know the word, and never offer to send
them the branch to merge.

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
product decisions first, then the precedent check ("Precedent before
asking"), and ask only an absolutely necessary unresolved one, never a
technical question. Route the answer as "Answers from the person"
below says. Every word the person sees follows
`../vibe/references/plain-words.md`, including its "Links to what the
person should look at" (a story or page link comes from
`../vibe/scripts/vibe-sessions.mjs link`), and every question goes through
`../vibe/scripts/session-questions.mjs` as the vibe skill's "Questions are
asked once" says, so nothing settled in the session is asked again. Updates mention only completed features and next work; planning,
reviews and the checklist stay internal. Every
reviewer, verifier and critic follows `../vibe/references/review-premises.md`.
Before endorsing or forwarding a finding, independently recheck each material
premise against its cited code line, read-only result or current official
document. A citation alone does not prove a premise, and an idle notice is not
a final report. Every
check narrowed or left for CI is named in the existing progress or handoff
summary in plain words (`../vibe/references/guardrails.md`, "Checks"). Every
worker brief says closedloop-graph is required
(`../vibe/references/closedloop-graph.md`): a worker that locates, changes or
reviews code ends with a Graph block listing its calls; otherwise dispatch the worker again saying so. On `unreachable` the step goes on; dispatch `vibe-setup-worker` to restore the connection before the next one. Every worker that edits the live ticket
follows `../vibe/references/ticket-template.md`. You and every worker leave
plugins, plugin marketplaces and plugin caches alone, and never clone the
plugin's repository to run other tooling (`../vibe/references/guardrails.md`,
"Plugins and tooling"). Read the person-facing reply rule in
`../vibe/SKILL.md` before a handoff reply or relaying worker text. If a
human-only blocker remains after both worker and vibe root exhausted safe
paths, the handoff reply must offer to pass saved or pushed work to a named next owner
now. Never end that reply with only a stop or wait (`../vibe/references/guardrails.md`,
"Plugins and tooling"). A check
that also fails on the main the session captured is not a needed
fix and never stops the handoff: it is recorded for engineering and the handoff
goes on (`../vibe/references/quality-loop.md`, "Failures already on main").
Only a failure the session caused blocks.

Handoff authors no tests (`../vibe/references/guardrails.md`, "Tests"). It runs the existing affected tests; on a failure the SAME persistent `vibe-change-worker` fixes the session's own code, never what the test asserts, and repairs only an existing test or fixture the change broke ("Repair, don't author"). Tests still needed go on the live ticket under Missing tests. Verification/review helpers are read-only, and no check is weakened. Never ask the person about tests or any other engineering choice.

The build loop is lean (`../vibe/references/quality-loop.md`, "Lean build
loop"), so the guardrails and adversarial reviews, browser E2E, visual QA, logical QA and product-contract QA run here. Handoff opens a pull request only when the person asks for one ("A
requested pull request" below), the one exception to the no-tests rule.

Harness notes match the `vibe` skill: in Codex invoke as `$handoff` and spawn
plugin agents from `../../agents/<name>.md` with the file's body as the
subagent's instructions and the `model` and `reasoning_effort` that
`node ../vibe/scripts/worker-model.mjs codex <name>` prints; the vibe skill's
usage-limit check runs here the same way; in Claude Code use `/vibe:handoff` and the
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
This recovery is internal; never ask the person running the session about it or send them to engineering.

## Answers from the person

Every answer the person gives during handoff (to a worker's `NEEDS_PERSON`,
or as a correction to the summary in step 2) is one of two kinds, and the
worker that asked says which (`behavior` or `wording`). The exceptions are
how the session ends, which step 0 settles, and who picks the work up next,
which step 8 asks and routes itself.

- **Behavior**: it decides what the product does. A rule, a permission (who
  may do something), what happens in a case, an acceptance criterion, or a
  change to what they built. Treat an answer as behavior when the worker did
  not say, or when you are unsure.
- **Wording**: it only changes how the ticket describes what is already
  built (the summary, a name, how the scope reads).

A behavior answer resumes the SAME `vibe-change-worker` in fix mode first, with the
question and the person's answer verbatim. It checks the code against the
answer on every screen it touches and reports it already met (with evidence)
or builds it under its usual rules. If
it changed any file, re-run before the ticket is finished: step 3 (inventory
and guardrails), step 4 when a component or story changed, step 5 (checks),
step 5's final main-sync/pre-push candidate, then step 6's reviews and
running-app verification (lighter: both reviewers; backend: one
`workflow-code-review` pass). Only then may step 7 commit and publish. Only then does the answer go to `vibe-ticket-worker`.
Before code, extend the same session decision table with the answer's source,
row IDs, cross-request interactions and explicit Superseded decisions, and add
the answer to its `## Acceptance Criteria` list
(`../vibe/references/quality-loop.md`, "Acceptance criteria before ready"). Preserve
earlier frozen targets. Handoff reruns use the whole table, not just this answer.

A wording answer goes straight to `vibe-ticket-worker`.

Every `vibe-ticket-worker` handoff dispatch carries all the answers so far:
the question, the person's exact words, and `built` (with the change worker's
summary), `already met` (with evidence) or `wording`. A behavior answer the
change worker has not handled is refused with `NEEDS_CHANGE`.

## Workers

| Step | Worker |
|---|---|
| Summary | `vibe-handoff-summarizer` |
| ALL source fixes, behavior answers, the missing tests list, the feature docs record and the frozen behavior rows (tests only for a requested pull request) | the SAME persistent `vibe-change-worker` context |
| Judgment guardrails, shared-owner placement, and red flags | `vibe-guardrails-reviewer` |
| Commits | you, with `../vibe/scripts/commit-worktree.mjs` |
| Storybook placement and advice only | read-only `vibe-storybook-decomposer`; the SAME writer applies it |
| Existing code checks, coverage advice, suite and footprint | read-only `vibe-verify-worker` |
| Running app checks with `pnpm control` | read-only `vibe-verify-worker` (control mode) |
| Lighter: tough review | repo `review-soul` and `vibe-adversarial-reviewer`, in parallel |
| Consolidated review, only when `review-scope.mjs` says so (step 6) | `vibe-consolidated-reviewer` |
| Requested pull request: review of the tests the writer wrote | repo `review-soul`, required (step 6) |
| Visual QA, logical QA and product-contract QA | the repository's own read-only skills (step 6) |
| Backend: two review passes | the `workflow-code-review` skill (itself orchestrator-only) |
| Last push and Vercel check | `vibe-environment-worker` (redeploy mode) |
| Opening a requested pull request | `vibe-environment-worker` (`pull-request` mode) |
| Next owner, ticket check, and assignment | `vibe-ticket-worker` (lookup mode, then handoff mode, then assign mode; a requested pull request skips lookup and assign) |

## A requested pull request

Without the person's explicit request for a pull request, nothing in vibe or
handoff writes a test. The person's plain-language intent to take the work through review
and merge themselves IS that request (`../vibe/references/guardrails.md`, "Tests"):
"raise a PR", "open a pull request", "I'll get the PR merged", "I'll get it
merged", "I'll ship it myself", "I want to take it through review", or
choosing the pull request in step 0's question, whenever it comes; it is
never answered with a branch to merge.

> Read `references/handoff-pr.md` (block `requested-pull-request`) once the person has asked for a pull request, in the words above.

## 0. Pick the session

Run `node ../vibe/scripts/vibe-sessions.mjs list` (it uses the checkout the
vibe preflight remembered). Use the session whose worktree you are in. If you
are not in one and more than one session is `active`, list them in plain
words and ask which one they want to finish. Read its `liveTicket` and `localFixes`.

If the session has no `liveTicket` (it started before live tickets existed),
dispatch `vibe-ticket-worker` in create mode first; it records the slug on
the session. Existing tickets apply `../vibe/references/quality-loop.md`,
"Local plan", before final checks without pausing handoff. If it is `handed-off`, first dispatch `vibe-ticket-worker` in
plan mode with `mergeCheck: true` when its `livePlanStatus` is `APPROVED`, so
a merged pull request moves the PLN to `EXECUTED`. When its pull request is still open, read its threads first
(`vibe-environment-worker`, `reviewThreads: read`) on every look: any
`awaitingReply` thread starts section 10, "Changes on the open pull request",
unasked. Otherwise tell the person it is
already finished and stop, unless they are asking for changes on the pull
request it opened: then follow section 10.

Then record this conversation using `codex-sessions` in Codex or
`claude-sessions --transcript "<this Claude session's actual transcript path>"`
in Claude Code, both with `--worktree "<wt>"`, so the actual orchestrator
session is recorded. Never substitute a worker ID.

### Settle how it ends

Settle the ending before the checks, because a requested pull request changes
what they run. Use the ending the person already chose (in the vibe skill's
section 8 or in their own words here); never re-ask it.

- Words that say they will take it through review and merge themselves (the
  list in "A requested pull request") choose the pull request: follow that
  section. Ask nothing more.
- Words that say someone else finishes it ("send it to design", "give it to
  <name>", "someone else can finish") choose passing it on. When they gave no
  name, ask step 8's question for a name or email now, so the lookup in step 8
  has it; never ask it again there.
- Otherwise ask one plain question, in exactly these words:

```
Do you want me to open a pull request so you can take it through review and merge, or pass it to someone, usually design and then engineering, to finish?
```

Never ask for a name before they choose passing it on; once they choose it
without naming anyone, ask step 8's question right away. If they are confused
about what happens next (for example "oh i thought you were going to code
it"), explain the two endings plainly in a line or two and ask the same
question; never jump straight to asking for a name.

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
Neither vibe nor handoff opens a PR unless the person asks for one ("A
requested pull request").

## 1. Internal checklist

Run `node scripts/handoff-inventory.mjs --worktree "<wt>" --phase handoff` (the JSON stays out
of the chat). Its `backendChanged` picks how hard the work is checked: the
lighter checks when the session changed no backend code (`backendFiles`, such
as the API app, shared API types, the database package, Desktop's main process,
and any migration), the backend checks when it did. If a later inventory run
reports `backendChanged` true (a fix or a behavior answer added backend code),
use the backend checks from then on and update the internal checklist.
Its `serverOnly` true skips step 4, Desktop runs and visual QA (record why).
The checklist stops immediately when `blocking.forbiddenPaths` is false
(every `forbidden` or `outsideAllowed` path; only inventory-proven
`shrinkOnlyAllowlists` entries are exempt) or `blocking.diffRulesClear` is
false: each `diffRules` finding goes to the SAME writer, which fixes it or
records the change log line it names. A `frozen-render` finding is settled
only by `scripts/frozen-render.mjs`, run in step 4 by
`vibe-storybook-decomposer`: the writer records the `Frozen render
unchanged` line that command prints, and nobody captures frozen stories any
other way. Give it the prepared base worktree, never base or head server URLs:
the renderer starts both through the verifier's owned run wrapper and stops
both before it returns, including after failure. The line names the session
files it rendered and counts only while their story states and dependency
inputs are unchanged. A later commit or main
merge reruns it only when `qa-impact.mjs` names one of those states or the
frozen-render dependency digest changes (ISS-13411). A finding's `fix` is written for the writer, never relayed to the
person as a step (`../vibe/references/plain-words.md`, "What the person is
asked to do").

Keep the remaining checklist internal; never show the person a technical
task list, upfront summary or plan to approve. Preserve
the lighter versus backend validation and review weights below.

### Start the lane run in the background

When `../vibe/scripts/verify-run.mjs` exists and the worktree is clean at its
head (it refuses a dirty one), start the CPU-bound checks now, before steps 2
to 6, and keep working while they run:
`node ../vibe/scripts/verify-run.mjs --background --worktree "<wt>" --head "<full SHA>"`
prints a run id at once. Record it. The summary, the guardrail and adversarial
reviews, the Storybook work and the ticket worker's and PLN work that does not
need the lane result all proceed while it runs; the lanes are scheduled, never
skipped. With uncommitted work, or without the script, start nothing and
run the steps below unchanged. A new head after a fix needs a new run.

## 2. Summarize internally

The inventory from step 1 covers the session's redeploy commits and anything
not committed yet. Dispatch `vibe-handoff-summarizer` with the worktree and
the inventory path.

The inventory's `localFixes` are managed local workarounds for repository
bugs, each with its owning ticket; new entries come only from the SAME
persistent writer. They are not the person's work: the inventory leaves them
out of `changedFiles` and its checks, and every worker brief from here on lists
their paths as out of scope (never described, reviewed, edited or committed).
Keep the summary internal for the ticket.
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
checklist. A finding marked `engineering decision` follows step 6's rule
for decisions. A removal never silently undoes a visible change the person
already saw (for example, an approved heading style that needed a change
outside the allowed paths). When a removal does undo one:

- tell the person in one plain line which part will look different until
  engineering makes it;
- the affected criterion goes back to `not met yet` with that reason;
- the touched screen is rendered again in the verify worker's control mode on
  the final commit, never left as last seen.

Re-run inventory and independent read-only guardrails checks; every cleared
`Control:` citation must name that control on that surface. Keep the writer's Design blocks for the ticket. A flag key without
the person's recorded yes gets its approval question once, as the vibe
skill's section 7 says; with no yes the writer removes the gate.

> Read `references/handoff-ui.md` (block `step-4-storybook`) unless the inventory's `serverOnly` is true.

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
an existing test the session's change broke), leaves a failure that also fails
on the captured main to step 7's comparison and engineering, and lists every missing
test as engineering's scope of work: the behavior and row ID that needs it,
the files to cover, and any existing test a recorded human behavior ruling
made obsolete, with that ruling. The verify worker never writes or fixes tests.
The same writer checks implementation and executed existing coverage against
every required unsuperseded row, including earlier requests. Planned coverage
is not executed coverage; a row without an existing test goes on the missing
tests list, never counted as covered.

Read-only verify checks mode runs the same targeted checks whether or not
backend changed (`../../agents/vibe-verify-worker.md`, "Existing checks"):
Biome without write flags on the changed files, gates, the affected typecheck
and only the tests selected for each file of the whole branch diff
(`code_tests_for`, the repo's related-test command where the graph has none,
and e2e specs by reference), never a broad or full local suite. Backend changes add the two review passes, not a
wider test run. It reports defects back to this same writer.
Do not weaken tests, skip required coverage or fall back to visible automated
browser/Electron windows. Record exact unsupported local limitations.

### Existing feature docs

Nothing agent-written goes into public docs (`../vibe/references/guardrails.md`,
"Feature docs at handoff"). In the same handoff continuation the SAME writer only
records which existing product docs pages under `apps/web/content/docs/`
describe a feature this session changed, with the passage that no longer
matches, or that no page covers them, for the ticket's Feature docs line. It
edits, creates and drafts nothing there or in the internal engineering
`docs/` folder; design or engineering updates those pages. The inventory
reports any change under either folder as outside the allowed paths in every
phase, and step 3 sends it back to the writer to remove. Owned prototype
sessions skip this step.

Before step 6, stop Desktop, pin current `origin/main`, and prepare its merge
without committing. The SAME writer resolves the final candidate uncommitted;
rerun only checks and QA that `qa-impact.mjs` selects. Any source change repeats
this preparation before independent review.

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
The missing tests list may say `None` only when every acceptance criterion has
executed coverage through both the real web host adapter and the real Desktop
host adapter. Coverage on one host, a shared unit test or a mocked router
leaves a named missing test for the uncovered host.
No criterion or PLN task that depends on external work is complete until the
deployed collector, selector, monitor or other dependency evidence is present.
An explicitly missing dependency keeps final alignment open, with one
exception (ISS-13321): when the person chose passing it on, a criterion whose
only gap is work another ticket owns (an API or data ticket that has not
shipped) is marked `not met yet: waits on <ticket>`, and the table may then
say `Final Alignment Status: Aligned except criteria waiting on <tickets>`.
Each such criterion goes on the Engineering checklist (`../vibe/references/ticket-template.md`,
"Criteria waiting on other work"), so the people who close the dependency
receive the work. A requested pull request still needs every criterion met.

Consolidated review (ISS-13352), off unless `VIBE_CONSOLIDATED_REVIEW=1`: when a
precomputed findings file exists (`vibe.guardrails-findings/1`), run
`node scripts/review-scope.mjs --worktree "<wt>" --findings <file> --inventory <inventory json>`.
Only when it prints `"mode": "consolidated"` does one `vibe-consolidated-reviewer`
take the place of step 3's guardrails reviewer and the adversarial reviewer
below, on the final diff; `review-soul` on a requested pull request's tests and
the backend passes still run. Any other output, a missing script or file, a
skipped check or an error means the existing reviewers run unchanged. The
escalation numbers are `REVIEW_SCOPE_DEFAULTS` in that script, unruled.

Triage manifest (ITEM 2 = A, the owner's ruling): when the session has a
triage manifest file (`../vibe/references/triage.md`), add
`--manifest <file>` to that command, and run it for the manifest even when no
findings file exists (the decision is then the existing full review). The script reads the manifest only when
it passes `vibe-triage.mjs check`; a missing or invalid one changes nothing.
When its `triage.applied` is `true` (the triage switch was on at classify
time), also run each `triage.addedReviews` entry (`vibe-adversarial-reviewer`
beside the consolidated reviewer, when the manifest scope asks for it) and each
`triage.extraGates` entry (`workflow-code-review`, `logical-qa`) as an
additional gate on the final diff, skipping one this handoff already ran for
this head; their confirmed findings are handled like any handoff reviewer's.
The manifest only adds review work: `mode` and its reasons stay as the diff
decided them, so it never removes a review. With `applied` `false`, run
nothing extra.

Lighter: repo `review-soul` and `vibe-adversarial-reviewer`
may review independently in parallel, read-only. Backend: named core
`workflow-code-review` runs its two existing review passes
(`$workflow-code-review` in Codex or `/closedloop-core:workflow-code-review` in
Claude Code). ALL confirmed code/story findings resume the SAME writer,
which verifies and corrects them; recheck its current result and repeat
validation. A coverage gap goes on the missing tests list; nobody writes a
test here.
Save the exact JSON stdout from each mandatory vibe reviewer launcher turn in
the private git directory. Keep its trace path and completion identity; do not
retype a summary into a receipt. Guardrails, adversarial and Storybook
decomposer each need a clean final-source turn before the PR gate.

A finding from any handoff reviewer, step 3's guardrails check included,
that a mechanism, a one-way door, or an unratified or conflicting decision
needs a human decision is never the writer's to resolve, downgrade or
absorb, including after verification. The SAME writer logs it in the change
log as `Engineering decision: <question>; built: <what the session built>;
evidence: <files, records or finding>`, and the ticket worker puts it on the
live ticket's Engineering checklist (`../vibe/references/ticket-template.md`,
"Engineering decisions"), never to the person.

On a requested pull request, lighter and backend alike, the repo's
`review-soul` critic is REQUIRED on the tests the writer wrote in its
`pull-request` turn, not optional: give it
those test files and the code they cover. It checks above all that each
test can fail when the behavior it names breaks and that no test name claims
more than its assertions pin. Its confirmed findings resume the SAME writer
in its `pull-request` turn, and the pull request does not open, or take a new
push, until its rerun on the corrected tests is clean.

### Join the background lane run

Before `Final Alignment Status: Aligned`, before the PLN is left Approved and
before anything is called ready, join the run from step 1:
`node ../vibe/scripts/verify-run.mjs --wait <run id> --worktree "<wt>" --head "<the head under review>"`.
Only `state: passed` (exit 0) joins. `running` (4) means keep waiting;
`failed` (1) goes to the SAME writer; `orphaned` (3) and `head-moved` (5) mean
start a new run at the current head. None of these is a pass, and the result's
head must be the head under review. Nothing here is counted as aligned, approved or ready
while the lanes are pending, running or failed.

### Browser E2E and the repository's QA passes

These run here and never in the build loop. Browser E2E runs headless in
step 5's checks and step 7's validation:

- Run every e2e spec the session touched, and every spec covering a touched
  screen, and no other spec.
- Run them through the repo's containerized path (the `local-ci` skill's
  `dagger call e-2-e`) in the verify worker's checks mode, one stack per machine through `../vibe/scripts/e2e-lock.mjs` (the verify worker's
  "Existing checks"), never natively on the person's Mac. The lock gives
  each run its own compose project, so a teardown removes only its own
  stack; `--foreign-compose <project>` names a stack started outside the
  lock, which keeps the machine busy while it runs.
- A missing Docker or Dagger is recorded as that exact limitation, never a
  pass.

No worker claims what CI runs or ran without first reading
`.github/pr-test-event-tiers.md` and citing the job's tier.

For the screens the session touched, run the repository's own
read-only passes where its root `AGENTS.md` calls for them on this change:
visual QA (`/visual-qa` in Claude Code, `$visual-qa` in Codex) for a UI
change, against the session's acceptance criteria when the ticket or its PRD
has them and otherwise as the design pack's best-practice review
(`../vibe/references/quality-loop.md`, "Visual QA during the session",
"What it checks"); its rendered-control inventory flags anything with no
sourced requirement. For shared scope it compares each consumer page against
that page's approved prototype route and flags every control present in the
prototype but missing in production. Run logical QA (`/logical-qa`, `$logical-qa`) for a data or metric
surface, then product-contract QA (`/metal-andrew`, `$metal-andrew`) once that
evidence is visible. Each skill dispatches its own read-only agents. Confirmed
findings resume the SAME writer in fix mode for every touched surface, even when
they predate the branch, already exist on main or were called the component
owner's decision; approved copy is reused and unsourced wording is escalated. Then
steps 3 to 6 run again on the result. Before handoff, the findings file must pass
`node ../fleet-orchestrator/scripts/finding-brief.mjs <orchDir> --findings
<findings.json> --require-disposition`; every finding on a touched surface has
`fixed: <sha>` or a follow-up `ticket: <id>`. Their reports feed the Design Review evidence in step 8. Owned
prototype sessions keep their canonical single design review instead.

Storybook plays run in a real browser, and card or narrow-layout
interactions on WebKit iPhone and Chromium Pixel, as the verify worker's
checks mode says; a requested pull request cannot open without them (step 9).

> Read `references/handoff-ui.md` (block `running-app-verification`) unless the inventory's `serverOnly` is true.

### Pinned-base Storybook train

Read the final branch's Storybook version and inspect every open pull request's
files and claimed version. Record matching PR numbers or `None` in the ticket
and PR packet. Before the first commit, verify the bump, single release-history
entry and component/story counts against the pinned base. The SAME writer fixes
wrong counts or bumps before readiness. Inspect each train PR's reserved version;
a reservation is coordination evidence, never a stop. Take the next free version,
say so in the pull request packet with the reserving pull request's number.
Main moving after the pin is not stale: one merge after QA suffices. Classify it
with `scripts/qa-impact.mjs`; never sync main again only to chase a newer Storybook
release. The queue settles later collisions (ISS-13321).

### Candidate audits and pre-PR verification

Before the first commit/push, after independent review and running-app
verification, audit the uncommitted candidate:
`scripts/criteria-audit.mjs --ticket <body> --worktree "<wt>" --audit <audit> --matrix <matrix>`
(every audit row carries the verdict, its evidence type and its ref, `../vibe/references/spec-card.md`, "Audit rows";
`../vibe/scripts/spec-card.mjs audit-skeleton` prints the rows; a test ref names a file that exists at HEAD)
`node scripts/rulings-check.mjs --ticket <body> --record <QA record> --plan <each linked PLN's get-document JSON> --plan-body <its latest text>`
`node scripts/rollout-gate.mjs --worktree "<wt>" --ticket <body> --slug <ticket> --prd <PRD body> --prd-slug <PRD>`.
Record each rollout requirement as `Rollout: <id>:` with code or a ticket/PRD-specific
human ruling. The ticket carries every ruling and amended criterion; no plan
excludes scope without human authority. QA evidence names screen, host, state and
flag arm. Later changes use `scripts/qa-impact.mjs` with importers, FEATURE_MAP,
lane report and that evidence; `None` runs no local lane, screenshot, audit or
critic, otherwise only its scope. `pre-pr-lanes.mjs check --impact` enforces
selected lanes; CI remains per push. Re-audit only criteria on affected screens.

Before declaring push-ready, read the repository CI workflow and run **all CI
lanes** locally in their exact job shapes: checkout depth, runtime/toolchain,
install, lint/typecheck/test commands, matrix jobs, builds, and generated-dist
checks. Focused subsets never substitute for this full pre-PR verification.

On a requested pull request, skip assign mode: the ticket stays with the
person, In Progress. Before dispatch, require the refreshed pinned-base
Storybook train check. Dispatch `vibe-verify-worker` in `pre-pr` mode on the candidate
HEAD plus diff/tree hashes. It records read-only inventory, results, SHAs, E2E probe and tier in
`<gitdir>/vibe-pr-evidence.json`; after a fix only failed cases rerun.
Keep the verifier's actual tested HEAD and source hashes. After publication,
bind that evidence to the committed tree only when the source hash matches;
metadata binding never claims a rerun. Resolve behavior answers, code gaps and
Frozen Behavior before declaring readiness; later ticket filling is metadata-only.

Before readiness in step 6, resume the SAME writer to add the
session decision table's `## Frozen Behavior` section, listing the rows the
person accepted (`../vibe/references/quality-loop.md`, "Frozen behavior at
handoff"). Have it refresh that section after any behavior answer that changes
the table, before the ticket worker sees the table again.

The read-only verifier runs `scripts/live-ticket-check.mjs` on the private candidate ticket
before readiness. Behavior questions and code gaps return to the SAME writer
and repeat these gates before the first commit. After publication, the ticket
worker binds accepted evidence and deployment metadata. A metadata-only mismatch
is corrected there; any required source correction follows the new-commit recovery
below, never a readiness-only refusal or rewrite of a published commit.

## 7. Upload the last changes

ROOT commits the reviewed deliverable LOCALLY once through normal hooks, still
unpushed, excluding private plans/localFix source:
`node ../vibe/scripts/commit-worktree.mjs --worktree "<wt>" --subject "<ticket>: <summary>" --body "<fixes>"`.
Its tree must match the accepted candidate.
Then follow [Main-sync before publication](../vibe/references/environment.md#main-sync-before-publication)
for handoff. `--prepare-main-sync` fetches fresh `origin/main`; when it stages a
merge newer than step 5's reviewed pin, the SAME writer resolves it uncommitted
and reruns affected review, verification, and all CI lanes. ROOT then records
that staged result as an ordinary merge commit through `commit-worktree.mjs`.
This is the one extra main-sync commit allowed after the reviewed feature commit;
it brings in main and is not iteration. Only the settled committed merge tree
reaches the same actor's one `main-sync-inputs` pass and real
`mainSyncValidation`. Its retained reports are never PASS, readiness is not test
authority, and `requiredE2eComplete` remains a separate final-coverage gate.
Every main sync is checked for capability removal, this one included. Use
`qa-impact.mjs`, dispatch `vibe-guardrails-reviewer` for its check 13 on that
merge, and rerun the inventory's `requiredChecks` on the merged tree before
accepting it; a source change returns to the uncommitted review loop.

A result listing `mainPreexistingFailures` still has `publicationReady: true`:
carry every entry to step 8's ticket worker as a Known main failure; never send
it to the writer as a fix, never stop and never ask the person about it
(["Failures already on main"](../vibe/references/quality-loop.md#failures-already-on-main)).
Dispatch `vibe-environment-worker` in redeploy mode with the accepted review,
verification and check evidence. It runs the normal pre-push hook, pushes that
exact commit, deploys it, and carries verified main-only failures to the ticket.
If the pre-push hook refuses after the single local commit, the SAME writer
fixes uncommitted source and reruns the affected review and verification. ROOT runs
`commit-worktree.mjs --worktree "<wt>" --amend` on that still-unpushed commit,
then reruns the normal pre-push checks; it never creates a second repair commit.
Once pushed, that commit is immutable in this flow. Any later required source fix
from CI, review, or ticket/source verification goes through the SAME writer and
all affected checks, then ROOT makes a new commit; never amend a pushed commit and
never force push. The pull request body records why the local pre-push evidence
missed the required correction.
Preserve canonical no-ops, `NEEDS_DESKTOP_STOP`, request-only flags/Desktop
rights, CI identity and no manual CI/review triggers.
`requiredE2eComplete: false` blocks assignment; Desktop comes back under
`e2eLeftForCi` instead and does not hold it. Record its `desktop-e2e/validated`
Engineering checklist entry. A Desktop lane under `e2eLeftForCi` is not such a gap.
No PR opens here.

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
- Actual design/visual-QA reports with screens, viewports, hosts, states and
  flag arms, plus accessible evidence,
  including the running app verification's control captures, embedded rather
  than named by local path, and what each proves. Source-only, unverified, failed and
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

On a requested pull request (step 0), skip the question and the lookup: the
next owner is the session's operator, the person who ran it, and the ticket
stays with them.

When they chose passing it on, use a next owner the person already named for
this handoff; never re-ask that settled choice or infer an owner from a
company default. If nobody was named, have the ticket worker check the
current session's prior decisions first. Only if the necessary choice remains
unresolved, ask one plain question in exactly these words:

```
Who should I pass it to? A name or email is fine.
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
ticket slug, the next owner (full name and email), whether the person asked
for a pull request, the inventory path, the
confirmed summary and the person's corrections, the footprint, check, and
review summaries, the Design blocks from build and handoff fixes, the required session decision table
at `.closedloop-ai/decision-tables/<session-slug>.md` with whole-table alignment,
row/test evidence and its Frozen Behavior row IDs, the writer's feature docs
record, the missing tests list, the inventory's `retiredTests` with each deleted
file or case, every `mainPreexistingFailures` entry from step 7 with its main
run's log, the running app verification's artifact paths
with what each proves and any surface it could not drive with its command and
reason, the detailed Design Review evidence packet/report paths,
including Production impact, Flag changes and gates, and researched Open
Questions per `../vibe/references/ticket-template.md`,
and every answer from the person so far with how it was handled. For a source
PRD, also pass every child classification and its current
ownership, status and activity. The ticket worker moves to In Review only
the children `scripts/live-ticket-check.mjs --child-evidence` passes and
lists the rest as uncovered. Never include a plan's body in
this dispatch: the plans under
`.closedloop-ai/vibe-plans/` reach ClosedLoop only as the session's PLN. It
refreshes the record sections (the Environment base commit from the current
inventory), re-derives every section an answer touches, fills the Handoff and
Grading sections, reconciles the backend sections, attaches the files,
verifies the source link (source PRODUCES ticket), the PLN, its link (ticket
PRODUCES PLN) and that the PLN matches the current local plans, repairs any
that is missing or stale, and leaves the PLN `APPROVED` before a pull request
opens, then runs
`scripts/live-ticket-check.mjs`, which refuses a session with local plans and
no `APPROVED` PLN recorded. It returns:

- `DONE` when the ticket is complete.
- `NEEDS_PERSON` for ticket wording or owner metadata: ask the person and
  refresh only that metadata. Missing behavior criteria should have failed
  candidate preflight; if discovered after publication, follow the new-commit
  source recovery below rather than treating it as an invariant-only block.
- `NEEDS_CHANGE` for private plan or ticket metadata that would publish a local
  path, username, secret or private input: correct that metadata. A source or
  criterion mismatch returns to the SAME writer: repeat steps 3 through 7 on
  the corrected source and have ROOT make a new commit; never amend a pushed
  commit. The pull request body says why local checks missed the correction;
  publish the repaired head, then retry ticket fill.

Repeat until it returns `DONE`. Never go on to step 9 while a behavior answer
has not been through the change worker, while its re-run checks, reviews,
or redeploy are unfinished, or, when passing it on, without a next owner the
lookup resolved to exactly one user.

## 9. Hand it over

Use the accepted uncommitted evidence from step 6. Publication only binds it
to the pushed tree; it never substitutes a new source-validation round.

> Read `references/handoff-pr.md` (block `step-9-pull-request`) when the person asked for a pull request.

When they chose passing it on, dispatch `vibe-ticket-worker` in assign mode with the worktree, the live
ticket slug, and the next owner's user id and email from step 8. It confirms
the ticket is still assigned to the session's operator, the person who ran it
(if engineering or design already took it, it returns `BLOCKED` and you stop:
that branch is theirs now), assigns it and its PLN to the next owner, and
leaves the ticket status In Progress.

Then mark the session handed off:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree "<wt>" --status handed-off`,
and stop local Storybook and Desktop with
`node ../vibe/scripts/vibe-sessions.mjs stop --worktree "<wt>"`, which signals
only a recorded process it proves is still the session's own (ISS-13321).

Tell them, in a few lines, each as a link that opens it
(`../vibe/references/plain-words.md`, "Links to what the person should look
at"): the ticket link, the app link as
`<appUrl>/sign-in` (the app's root sends a signed-out visitor to account
creation), the Storybook link (the full Storybook UI per
`../vibe/references/environment.md`, "Storybook links"), the ticket's
"Keys to see this work", and what happens next. On a requested pull request: the pull request link, and that they take
it through review and merge from there; never the branch to merge. When
passing it on: the branch name, and that the next owner, by name, picks it up
from the ticket (usually design reviews the components in Storybook and
comments on the ticket on sign-off, then engineering finishes it). Say that the Storybook link opens only after
signing in to Vercel with a team account. If you open it and land on a
`vercel.com` sign-in or `sso-api` page, say exactly that rather than that
Storybook is broken, and do not try to get around it.

## 10. Changes on the open pull request

A pull request handoff opened for the person is not the end of the work when
someone asks for changes on it. Review fixes made outside this path leave the
pull request body stale and skip the guardrails. When
the person asks for changes on their vibe pull request ("please fix the
review comments", "engineering asked for changes on my PR", a link to the
pull request, or engineering's request passed on through them), the session
resumes and every fix goes through this path, never around it:

> Read `references/handoff-pr.md` (block `section-10-changes`) when a handed-off session's pull request is open or the person asks for changes on it.
