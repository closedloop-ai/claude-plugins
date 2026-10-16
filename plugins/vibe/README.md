# vibe Plugin

Vibe sessions, handoff, seed refresh, and ClosedLoop ticket workflows.

## Installation

Codex installs both `vibe@closedloop-ai` and `closedloop-core@closedloop-ai`.
Claude Code installs `vibe@closedloop-ai`; its dependency installs core automatically.
See the [Mac installation guide](skills/vibe/INSTALL.md).
Skills use `$<name>` in Codex and `/vibe:<name>` in Claude Code.
Codex workers read `agents/<name>.md` in this plugin; Claude workers use `vibe:<name>`.
Shared utilities belong to `closedloop-core` and are invoked by name, not by
reading another plugin's files. Use `$gh-monitor-pr`, `$guided-manual-qa`, or
`$measurement-discipline` in Codex; use `/closedloop-core:gh-monitor-pr`,
`/closedloop-core:guided-manual-qa`, or `/closedloop-core:measurement-discipline`
in Claude Code. The same naming pattern applies to other shared skills such
as `decision-table`.

## Skills

### `vibe`

Starts or resumes an owned symphony-alpha session with a live ClosedLoop
ticket. App changes use a seeded or blank per-branch environment. Mockup
requests automatically invoke the repository's canonical prototype workflow
on `prototype/<slug>`, share on Vercel, and return the immutable preview URL,
full deployed SHA, and slug. One persistent implementation writer owns all
source changes and annotations in the session's single worktree and branch.

App and owned prototype changes use an internal quality loop. The same writer
loads `$plan-structure` in Codex or `/closedloop-core:plan-structure`
in Claude Code and uses that skill's own template. Plans and review drafts
stay in the session worktree's `.closedloop-ai/vibe-plans/` folder, outside
commits, publications, and ticket uploads. The build loop is lean: quick
prep, the build, the quick checks the commit hooks need, the orchestrator's
commit, deploy, and showing the person. Each finished change deploys to the
session's Vercel preview without the person asking ("redeploy" still works),
and changes that arrive during a deploy go out together in the next one.
The plan gets no review, and browser
E2E, visual QA, logical QA, product-contract QA, the guardrails and adversarial
reviews and other heavy validation run only at handoff. Before saying a
change is ready, the writer checks every acceptance criterion it touches
(from the linked ticket, its PRD and the person's own words, kept in the
session decision table) with an existing test, a quick script, one control
read or a source trace; a criterion not met yet is fixed or reported to the
person as not done, and handoff's alignment starts from that list.

A reference image the person attaches is saved with
`scripts/reference-images.mjs` and recorded on the session; the writer opens
it as an image (`Read` in Claude Code, `view_image` in Codex) and records what
it read before building, and every visual and UX property it shows becomes an
acceptance criterion mapped to a design token or catalog component. Only when
there is a reference image, the writer screenshots each touched screen before
saying it's ready and fixes every difference from the reference, the one
exception to the lean loop's no-visual-QA rule (operator ruling, 2026-10-15).

Every request also uses `$decision-table` or `/closedloop-core:decision-table`
before code, including frontend-only, prototype and trivial edits. One living
artifact at `.closedloop-ai/decision-tables/<session-slug>.md` keeps stable row
IDs, request provenance, grouped behavior sections and cross-request interactions.
Later requests append sourced expectations; prior baselines/targets stay frozen
and superseded human decisions remain explicit. The same writer verifies actual
implementation against affected and interacting prior rows after each correction.
Planned tests remain distinct from executed coverage.

The orchestrator queues new requests and resumes that same writer's context
for each request, correction and handoff. Independent specialists, and at
handoff the reviewers, may run in parallel, read-only. Operational helpers retain bootstrap, deployment
and ticket duties without authoring implementation code. Shared session records,
ticket sections and change logs stay serialized. Workers never commit; the
orchestrator retains the commit boundary. No test is authored during building;
the writer only repairs an existing test or fixture its own change broke, or
deletes a recorded test that covered only retired code,
without changing what any test asserts, so the tree compiles and the hooks pass.
Before the first remote publication and again at handoff, an owned transaction
captures fresh main and prepares an ordinary noncommitting merge. The same writer
handles conflicts and executes the existing scope-specific checks against the
exact committed inputs; the orchestrator alone commits. Publication helpers push
that explicit validated SHA through normal hooks. Dirty source workarounds are
preserved and block mismatched validation. Flags and Desktop remain request-only
consumers of matching proof, not publishers. Exact already-published handoff
results avoid redundant pushes or deployment requests. Imported main changes
stay distinct from feature scope, while original feature test history remains
available for phase verification even after main absorbs identical bytes.
Reviewed deliverables are locally committed first, still unpushed. Independent
flags/Desktop deployment requests prepare fresh; only publisher-reserved exact
continuations consume earlier proof. Structured lane discovery prevents unsafe
automated Electron launches. Preview readiness keeps unsupported E2E explicitly
incomplete, while final handoff can consume real exact-checkout GitHub evidence
for that same committed snapshot without chasing main during CI. Workflow main
SHA, generic log matches and caller PASS are not coverage proof; the consumer
never dispatches CI or adds a feature PR.
The existing ignored root `.biome-noscan.jsonc` is recognized only when its
bytes match the reviewed canonical pure producer applied to the complete
committed config. Modified, stale or deceptive derivatives and unrelated
executable overlays still block; the gate never invokes the writing hook.
Source-owned input readiness preserves canonical unconsumed private diagnostics
and retained reports without accepting their contents as coverage. Known generated
dependencies need complete pure or pristine owner verification before execution;
unknown extras, edited bodies, producer drift and aliases remain blocked. Selected
package proofs use bounded deduplicated names and full byte/mode/set digests in
the existing private receipt. The same actor repeats readiness after the committed
merge and supplies the opaque recipe witness for actual validation. Fixed local
process budgets and the authenticated Claude envelope remain distinct from
unchanged test, hook and general-worker deadlines.
Report admission follows actual selected entries, tasks, configs and producer
inputs. Selected module coverage follows the finite committed tree; the existing
4,096 ceiling bounds distinct cwd/argv contexts rather than source file count.
Data imports use the same path predicate as the shared code/config parser;
retained-report references and global private planning protection remain enforced.
An unrelated capable reader is not selected consumption. Ordinary bootstrap health cannot mint validation proof. Meaningful retained report data,
default verdicts and replay still block, while proven same-call test fixtures
remain nonretained inputs and never stand in for required coverage.
An existing registered writer retains its definition root, exact binding and
actual ID while the definition matches. A missing definition or proven upgrade
uses the same `writer-state.mjs migrate` command in Codex and Claude Code.
ROOT records the old/new IDs, bindings, digests, reason and time, preserves all
migration history and queued requests, and continues from the same worktree,
plan, decision table, checkpoint and change log. Running turns, matching
definitions, unproven upgrades and writer refusals block migration. A turn
stranded by a plugin upgrade (its own record grant left behind because the
removed root makes `release-record` fail, or `BLOCKED` with the machine-readable
`recorded-definition-removed` reason) migrates through the same command with
`retainedRecord`, which releases that exact grant atomically. Recovery
stays internal and never asks the person running the session; ordinary registration cannot replace writers.

Native Codex helpers acquire a coordinator-owned record lease before their
mutation turn and release it only after observed completion or owned termination.
Claude helpers use the same mutex around their owned process group. Requirements
and setup can run before session creation from the validated checkout; confirmed
discard keeps execution state in a retained checkout and cancels a live ticket
only from the successful discard receipt.

Technical plans, questions, and upfront summaries remain internal. Updates
identify only completed requested features and next work in the person's own
words. Product questions are researched through closedloop-graph and live
decision evidence first, then raised one at a time with full context only
when an unresolved answer is absolutely necessary. Existing product and design
approvals remain intact.

Two notices reach the person without waiting for a reply. When a request names
an outside product as its reference, or gives a screenshot of one, the
requirements worker researches that product's public documentation, reads the
screenshot itself, and the person sees a bulleted list of the behaviors to
build while the writer builds them. When a request needs new
Storybook components, the writer builds them and their stories first, the
person gets one message with their local Storybook links, and the writer goes
straight on to the feature. The person may interrupt either to change it;
neither is an approval gate, and reuse-only changes send no Storybook notice.

Before the writer creates, retitles or moves a story or adds a shared
component, the read-only `vibe-storybook-decomposer` places it: it finds where
the same capability already exists for sibling entities and returns the owner
and story placement, following symphony-alpha's `apps/storybook/TAXONOMY.md`
and Storybook skill (`.claude/skills/storybook/`, whose placement workflows
and index scripts it uses) where they say how and mirroring that precedent's
structure, never its root or version, where they do not; the story files the
writer matches are the same capability's, not the same folder's. Stories cover the components consumers
render, not internal render pieces. New stories go in the current roots
(`Composites/`, `Surfaces/` and the other plain levels) with one lifecycle
tag: `stable`, `preview` under Labs, or `experimental` for design-only work.
A v1.0 story file (under a `<Level> v1.0/` root or tagged `deprecated`) is
never edited beyond a compile-only repair, so new states of its component go
in a new entry in the current root holding only them. New states
of any other existing component go in its existing story file under the same
title and tag, since a retitle breaks every link to its stories; handoff
blocks any other edit of a v1.0 story file except a compile-only repair, and a
retitle unless it is a sibling replacement's entry. Story files under the
`Start Here/` root are exempt from the v1.0 freeze and the title, tag and
retitle checks (design ruling, 2026-10-06). Handoff judges story files by
the scheme of the session's base, read from that base's
`apps/storybook/story-group-order.ts`, so a session still based before
symphony-alpha #8867 keeps the `v1.0`/`v2.0` rules until it syncs main, and a
sync is never blamed for the renames it imported. The writer records it in its local plan;
a conflict goes on the live ticket by audience, design conflicts under
Design Review and everything else on the Engineering checklist, never to the
person.

The writer may edit all of `apps/storybook/**`, including its `.storybook/`
config, `TAXONOMY.md` and `apps/storybook/scripts/`. When a request needs a
change in a path vibe never edits, such as the repo-root `scripts/**`,
`.github/**` or an `AGENTS.md`, the writer leaves it alone, builds no
substitute elsewhere, logs it as `Engineering needed (forbidden path)` and
builds the rest; handoff puts each one on the live ticket's Engineering
checklist.

### `handoff`

Checks and reviews the session's work, verifies its current app environment or
canonical prototype publication, and completes the same live ticket. A session
ends one of two ways, settled from the person's words or one plain question:
a pull request they take through review and merge, which handoff opens as its
last step with the ticket left with them, or passing it on, where handoff
resolves the next owner they name and assigns the ticket. The status stays In
Progress either way. Plain words such as "I'll get the PR merged" or "I'll
ship it myself" count as asking for a pull request, and the person is never
offered a branch to merge. Canonical prototype review and metadata
transitions are preserved.
Nobody authors tests in vibe or handoff. The same implementation writer only
repairs existing tests and fixtures the session's change broke (imports,
renamed or retired symbols, setup, type errors) without changing any
assertion. It may delete a test file or case that covers only code the
request retires, recorded with `retired-tests.mjs` and the retiring ticket or
PRD, and the live ticket lists those deletions next to Missing tests. The
handoff inventory lists repairs and recorded deletions and rejects an added or
unrecorded deleted test file, and the guardrails reviewer checks each one. Handoff
runs the existing affected tests, the writer fixes the session's own code
when one fails, never what a test asserts, and the ticket lists the missing tests as
engineering's scope of work: the behavior and row each covers and the files
to cover. Only the person's explicit request for a pull request authorizes
tests, and then full tests for every change are written and pass before it
opens. Valid expectations and checks are never weakened to obtain a pass.
Coverage is planned and independently verified from the whole session
decision table, including earlier requests and real-boundary negative cases.
Required source, existing-test or review gaps block final alignment and
handoff; a listed missing test does not.
Handoff also drives the running web app and Desktop for each touched screen
with symphony-alpha's control skill (`pnpm control`, hidden and read-only),
and records the artifact paths and what each proves in Design Review and the
ticket's Running app checks, apart from source-only claims. The build loop has
no control step.
The existing table attachment remains separate from private technical plans.
The live ticket also receives Design Review metadata from verified final work:
exact previews/deployed commit and access protection, scope/host states,
added/changed/removed Storybook components/stories with IDs and links,
controls/Docs/plays and intentional identity/sidebar changes, actual
footprint/catalog and visual reports/screenshots, and known gaps/design decisions.
Actual inspected viewports/hosts/states remain separate from source-only or
unverified coverage. A structural section check is not visual-quality proof;
the packet gives the next designer evidence to grade, not a technical plan to approve.
Handoff also records production-only added/changed/removed component paths and
effects if merged, shared-parent consumers and relevant web/Desktop consequences.
Flag metadata identifies exact new/existing modified/removed keys and their
entry/read/mutation/host gates, keeping source defaults, timestamped verified
production values and local QA settings separate from each other and from the
unchanged machine-generated snapshot. Researched Product/Design/Scope Open
Questions carry sources and decision context, exclude settled answers and
engineering limitations, and state None when none remain.
The same writer edits existing product docs pages for the changed features
(`apps/web/content/docs/` only) on the branch, marked as agent drafts that
design or engineering approves before merge, and never creates a page; the
ticket lists them under Feature docs. Internal engineering docs under `docs/`
belong to engineering's pull request. This is a scoped exception to the
rule that agents do not author user-visible words. The writer also marks the
rows the person accepted as Frozen Behavior in the session decision table that
the ticket attaches; `cl-execute` reads that attachment, keeps every frozen row
passing with tests in its pull request, and changes one only with that
person's explicit OK.

### `vibe-seed-refresh`

Checks symphony-alpha's vibe seed against fresh main and the latest Vibe Seed
Walk. When drift exists, coordinates workers to create a live ticket, fix the
seed in a fresh worktree, validate it, open and monitor a pull request, merge
through the queue, and mark the ticket Done. The fix worker runs the full web
and Desktop screen walk itself, on a Mac through `pnpm vibe walk-linux`, and
its counts and result file go into the PR's Test plan and the ticket's loop.

### ClosedLoop Ticket Skills

The plugin bundles the ClosedLoop ticket automation skill pack: `cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`, `cl-work-report`, `cl-sweep`, and `cl-execute`. Together they cover policy-aware ticket analysis, related-ticket discovery, safe one-level split workflows, private project work reports, sweep coordination, and end-to-end ticket execution. The imported sweep scripts use the native managed Codex App Server through bundled helpers rather than depending on a separate `app-server-orchestrator` skill. Runtime access still depends on the operator's normal ClosedLoop, GitHub, `workflow-memory`, and `closedloop-graph` MCP/API configuration.

## Agents

| Agent | Model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ticket, requirements, overlap, and owning-route discovery |
| `vibe-ticket-worker` | sonnet | Live ticket creation, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, deployment records, and opening a pull request the person asked for at handoff |
| `vibe-change-worker` | sonnet | Sole persistent implementation writer for local planning, full-stack changes, stories, fixes, the handoff missing tests list and serialized recording |
| `vibe-backend-worker` | opus | Read-only decision-table and backend guidance for that writer |
| `vibe-primitive-worker` | sonnet | Read-only reusable-component and steward-specification guidance for that writer |
| `vibe-prototype-worker` | sonnet | Read-only canonical prototype guidance or operational immutable Vercel sharing of the writer's reviewed committed result |
| `vibe-storybook-decomposer` | sonnet | Read-only Storybook placement owner (precedent search on sibling entities before any story or shared component is placed) and component extraction, story and control guidance for that writer |
| `vibe-verify-worker` | sonnet | Read-only existing checks, handoff coverage review, full backend suite, Storybook footprint and handoff running app checks with `pnpm control` |
| `vibe-guardrails-reviewer` | sonnet | Read-only judgment-based review of reuse, placement (including Storybook precedent placement), copy provenance, accessibility, and tests |
| `vibe-adversarial-reviewer` | opus | Separate read-only handoff review of ownership, dependencies, contracts, regressions, and web/Desktop behavior |
| `vibe-handoff-summarizer` | sonnet | Read-only plain-language summary of the session inventory, changes, and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | sonnet | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

## Evals

`evals/` holds a `claude plugin eval` suite for how a session ends: plain
words asking for a pull request, passing the work on, an unclear "I'm done",
the endings line in a new session's first reply, and the closing pull request
link. It also covers setup and questions (tags `setup`, `sample-data`,
`questions`): an expired Claude sign-in becomes one plain step, the sample-data
question is plain and asked only when it matters, and an answered or waiting
question is never asked again. Each case is a one-turn rehearsal with the session state in the prompt,
so it needs no symphony-alpha checkout, and it is named by persona (`exec-`
for someone who describes the work and passes it on, `pm-` for someone who
iterates from reference screenshots and may take it to a pull request
themselves). The cases load `closedloop-core` too, which sits outside this
plugin, so run the suite from the repository's `plugins/` folder:

```bash
cd plugins
claude plugin eval . --eval-dir vibe/evals --model sonnet -j 2 --max-cost-usd 5 --no-publish
```

Add `--ablation none` to skip the no-plugin baseline arm. CI does not run it.

Run the matching Codex suite from the repository root with
`uv run --with Pillow==12.3.0 python plugins/vibe/evals/codex/run.py`;
see [Codex evals](evals/codex/README.md) for caps, selection and results.

`pm-review-comments-fix-the-pr` (tag `post-pr`) rehearses a person asking for
review fixes on the pull request vibe opened for her: the session resumes and
the fixes go through the same writer, the guardrails review and checks, a push
to the same branch, a refreshed pull request body and thread replies.

The cases tagged `visual-cues` check reference images (operator ruling,
2026-10-15): three `pm-` cases attach a reference screenshot (a card, another
product's cards with hover and selected states, and a two-screenshot page whose
first draft broke a tap target) and the `exec-` case describes a change in
words with no reference. Two more come from a product manager's pull request
review (operator ruling, 2026-10-16): `pm-static-page-light-and-dark` builds a
static page from a reference and must render it in light and dark before
ready, and `pm-hardcoded-shadow-blocked-at-review` runs the handoff guardrails
review on a page-local hardcoded shadow where the surface bundles a token,
which must be blocking. They build in a small stand-in repository their
scaffold writes, with design tokens (light in `:root`, dark in `.dark`) and a
Pillow screenshot tool standing in for Storybook, because the eval sandbox has
no browser. Run them with the scaffold and write tools:

```bash
cd plugins
claude plugin eval . --eval-dir vibe/evals --tag visual-cues --scaffold --allow-tools Bash Write Edit --model opus --runs 3 -j 4 --no-publish --ablation none
```

The two cases tagged `storybook` rehearse placement on symphony-alpha's
lifecycle scheme (#8867): new states for a component whose story file is
deprecated go in a new entry in a current root, and after a main sync a
session's own `<Level> v2.0/` entry moves to the plain root with a lifecycle
tag without counting as a retitle.

## Runtime Files

Version `1.0.14` contains 10 skills and 16 agents. It has no standalone
commands, hooks, root-level shell scripts, or production Python tools under
`tools/python/`; that directory contains the skill-contract test modules and
`vibe_contract_text.py`, the text helpers they share.
Runtime helpers and tests live alongside their owning skills, including vibe
session and prototype records, local-plan publication guards, bundled persistent
writer state, Claude launch/resume and shared main-sync publication helpers,
handoff checks, sweep ownership
and worker recovery, and the work-report renderer. Shared PR-monitor notification delivery
and manual-QA browser helpers live in `closedloop-core`.
