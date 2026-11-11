# Provider text for skills/handoff/SKILL.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: intro -->
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
<!-- end: intro -->

<!-- block: graph-and-ticket-briefs -->
summary in plain words (`../vibe/references/guardrails.md`, "Checks"). Every
worker brief says closedloop-graph is required
(`../vibe/references/closedloop-graph.md`): a worker that locates, changes or
reviews code ends with a Graph block listing its calls; otherwise dispatch the worker again saying so. On `unreachable` the step goes on; dispatch `vibe-setup-worker` to restore the connection before the next one. Every worker that edits the live ticket
follows `../vibe/references/ticket-template.md`. You and every worker leave
<!-- end: graph-and-ticket-briefs -->

<!-- block: control-row -->
| Running app checks with `pnpm control` | read-only `vibe-verify-worker` (control mode) |
<!-- end: control-row -->

<!-- block: pick-session -->
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
<!-- end: pick-session -->

<!-- block: background-lanes -->
When `../vibe/scripts/verify-run.mjs` exists and the worktree is clean at its
head (it refuses a dirty one), start the CPU-bound checks now, before steps 2
to 6, and keep working while they run:
`node ../vibe/scripts/verify-run.mjs --background --worktree "<wt>" --head "<full SHA>"`
prints a run id at once. Record it. The summary, the guardrail and adversarial
reviews, the Storybook work and the ticket worker's and PLN work that does not
need the lane result all proceed while it runs; the lanes are scheduled, never
skipped. With uncommitted work, or without the script, start nothing and
run the steps below unchanged. A new head after a fix needs a new run.
<!-- end: background-lanes -->

<!-- block: selected-tests -->
Read-only verify checks mode runs the same targeted checks whether or not
backend changed (`../../agents/vibe-verify-worker.md`, "Existing checks"):
Biome without write flags on the changed files, gates, the affected typecheck
and only the tests selected for each file of the whole branch diff
(`code_tests_for`, the repo's related-test command where the graph has none,
and e2e specs by reference), never a broad or full local suite. Backend changes add the two review passes, not a
wider test run. It reports defects back to this same writer.
Do not weaken tests, skip required coverage or fall back to visible automated
browser/Electron windows. Record exact unsupported local limitations.
<!-- end: selected-tests -->

<!-- block: feature-docs -->
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
<!-- end: feature-docs -->

<!-- block: alignment -->
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
<!-- end: alignment -->

<!-- block: extra-gates -->
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
<!-- end: extra-gates -->

<!-- block: join-lanes -->
Before `Final Alignment Status: Aligned`, before the PLN is left Approved and
before anything is called ready, join the run from step 1:
`node ../vibe/scripts/verify-run.mjs --wait <run id> --worktree "<wt>" --head "<the head under review>"`.
Only `state: passed` (exit 0) joins. `running` (4) means keep waiting;
`failed` (1) goes to the SAME writer; `orphaned` (3) and `head-moved` (5) mean
start a new run at the current head. None of these is a pass, and the result's
head must be the head under review. A required check that was a no-op with its reason (no file Biome checks, nothing for the lane report to cover) counts toward `passed`. Nothing here is counted as aligned, approved or ready
while the lanes are pending, running or failed.
<!-- end: join-lanes -->

<!-- block: qa-passes -->
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
evidence is visible. Each skill dispatches its own read-only agents. For every
touched metric, summary, or card surface, visual QA compares the card's
container, width, order and responsive placement with the established grid or
that page's official prototype story. Counting cards is never layout evidence.
Confirmed findings resume the SAME writer in fix mode for every touched surface, even when
they predate the branch, already exist on main or were called the component
owner's decision; approved copy is reused and unsourced wording is escalated. Then
steps 3 to 6 run again on the result. Before handoff, the findings file must pass
`node ../fleet-orchestrator/scripts/finding-brief.mjs <orchDir> --findings
<findings.json> --require-disposition`; every finding on a touched surface has
`fixed: <sha>` or a follow-up `ticket: <id>`. Their reports feed the Design Review evidence in step 8. Owned
prototype sessions keep their canonical single design review instead.
<!-- end: qa-passes -->

<!-- block: candidate-audits -->
Before the first commit/push, after independent review and running-app
verification, audit the uncommitted candidate:
`scripts/criteria-audit.mjs --ticket <body> --worktree "<wt>" --audit <audit> --matrix <matrix>`
(add `--member <slug>=<body>` for each of the session's `memberTickets`, the other tickets a fleet unit delivers in this PR; their rows are `<slug>:AC-n`, and run rulings-check and rollout-gate for each member too)
(a unit, meaning member tickets or a PRD, also passes `--prd <slug>=<PRD body>` and `--review <review.json>`: the review of the completed work in `scripts/unit-review.mjs`. Every member criterion and every PRD criterion for the touched pages needs a code review row (`file:line`) AND a visual QA capture for each page and each surface (Web, Desktop) it names, from the visual QA pass below; one page or surface never stands in for another. Every grouped, sorted or paginated list query the unit touches is listed in `listQueries` and needs a criterion naming its page, kind and a load time, met by a `measured` row (command, dataset rows, timing). Send its `GAP <ticket> <criterion>` lines to the SAME writer, and to the person before anything is called ready)
(every audit row carries the verdict, its evidence type and its ref, `../vibe/references/spec-card.md`, "Audit rows";
`../vibe/scripts/spec-card.mjs audit-skeleton` prints the rows; a test ref names a file that exists in the worktree, and handoff-gate checks it at HEAD; a `source-trace` ref is the file and line the trace ends at)
`node scripts/rulings-check.mjs --ticket <body> --record <QA record> --plan <each linked PLN's get-document JSON> --plan-body <its latest text>`
`node scripts/rollout-gate.mjs --worktree "<wt>" --ticket <body> --slug <ticket> --prd <PRD body> --prd-slug <PRD>`.
Record each rollout requirement as `Rollout: <id>:` with code or a ticket/PRD-specific
human ruling. The ticket carries every ruling and amended criterion; no plan
excludes scope without human authority. QA evidence names screen, host, state and
flag arm. Later changes use `scripts/qa-impact.mjs` with importers, FEATURE_MAP,
lane report and that evidence; `None` runs no local lane, screenshot, audit or
critic, otherwise only its scope. `pre-pr-lanes.mjs check --impact` enforces
selected lanes; CI remains per push. Re-audit only criteria on affected screens.
<!-- end: candidate-audits -->

<!-- block: next-owner -->
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
<!-- end: next-owner -->

<!-- block: hand-over -->
When they chose passing it on, dispatch `vibe-ticket-worker` in assign mode with the worktree, the live
ticket slug, and the next owner's user id and email from step 8. It confirms
the ticket is still assigned to the session's operator, the person who ran it
(if engineering or design already took it, it returns `BLOCKED` and you stop:
that branch is theirs now), assigns it and its PLN to the next owner, and
leaves the ticket status In Progress.

Then mark the session handed off. For a requested PR, parse the returned URL
for its repository and number, use the already verified pushed commit as its
head, and record all three through the root-owned transition:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree "<wt>" --status handed-off --pr-repo <owner/repo> --pr-number <n> --pr-head <full pushed sha>`.
The command reads the live PR and refuses a different repository, branch or
head. For an owner-assignment handoff without a PR, use
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree "<wt>" --status handed-off`.
The PR worker never writes session state. Then stop local Storybook and Desktop with
`node ../vibe/scripts/vibe-sessions.mjs stop --worktree "<wt>"`, which signals
only a recorded process it proves is still the session's own (ISS-13321).
Run `node ../vibe/scripts/e2e-lock.mjs cleanup-sweep sweep` from a retained checkout
after the stop; a live PR leaves its retirement record pending for a fleet
supervisor or the next vibe session-entry sweep. The sweep never removes the
executing checkout.

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
<!-- end: hand-over -->

<!-- block: upload -->
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
<!-- end: upload -->
