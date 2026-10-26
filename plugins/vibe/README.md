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
commits and publications. The ticket worker links the document the session
started from to the live ticket (source PRODUCES ticket) and publishes the
plans as the session's one implementation plan document (PLN), linked ticket
PRODUCES PLN, versioned when the plan changes materially and moved from Draft
to Approved to Executed as the work does; `session-plan.mjs` applies the
ticket's safety rules first. Handoff verifies and repairs both links and the
PLN. The build loop is lean: quick
prep, the build, the quick checks the commit hooks need, the orchestrator's
commit, deploy, and showing the person. Each finished change deploys to the
session's Vercel preview without the person asking ("redeploy" still works),
and changes that arrive during a deploy go out together in the next one.
The plan gets no review, and browser
E2E, logical QA, product-contract QA, the guardrails and adversarial
reviews and other heavy validation run only at handoff. Visual QA runs at
handoff too, and during the session only when the person wants it (operator
ruling, 2026-10-16): at each visible milestone (a user-visible change first
ready to look at, or a later major visible change, never a small edit) the
ready message offers it, and "looks good, make it polished" runs it before
handoff unless the change shows nothing visible or the person already
declined it for that version. It runs between requests after a deploy,
through the repository's design pack (`/visual-qa`, `$visual-qa`):
against the acceptance criteria when the ticket or its PRD has them, and as
the design pack's best-practice review against `.claude/design/soul.md`
otherwise. Its findings go to the same writer as a fix. Before saying a
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
exception inside the lean loop to its no-visual-QA rule (operator ruling,
2026-10-15).

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
the existing private receipt. The same actor runs readiness once, after the
committed merge, and supplies the opaque recipe witness for actual validation;
capture checks parity and unknown outputs, rechecking only a proof recorded for that commit. Fixed local
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
At handoff a failing check runs again on the main the session captured
(operator ruling, 2026-10-16). One that also fails there is `main-preexisting`:
it blocks neither publication nor assignment and goes once on the live ticket's
Engineering checklist as a Known main failure. One that passes there gets one
rerun on the session commit and blocks as `session-caused` if it fails again
(`flaky` if it passes); one that cannot run on main counts as session-caused.
The comparison uses one disposable bootstrapped checkout of the captured main,
`run-bounded.mjs` time limits and a recipe-bound Claude envelope reserve, and
never reruns a check that passed. The build loop's checks are unchanged.
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

Technical plans, questions, and upfront summaries never go to the person running the session. Updates
identify only completed requested features and next work in the person's own
words. Product questions follow one order: code and data model; ticket, PRD
and rulings; graph plus live decisions; product-owner direction; approved
prototype; then live Asana in the operator's signed-in Chrome. Public help
centers are never precedent. `scripts/precedent-check.mjs`
holds the research brief and its safety rules: a separate headless
`claude -p --chrome` run in both harnesses (Codex never uses computer use;
without a signed-in browser the worker returns to the orchestrator); nothing that exists is touched, test data lives
only in a `zz vibe precedent check (temp)` private project that is deleted
afterwards, and every state is verified before it is recorded. The answer
and its source (`Asana, observed <date>`, a code path, or the ticket
slug) go into the session decision table. A question is raised, one at a
time with full context, only when none of these settles it and the answer
is absolutely necessary. Existing product and design approvals remain intact.

Every `$vibe` start checks the installed vibe against the version on
claude-plugins `main` (`scripts/plugin-version.mjs`). When it is older, the
person chooses to keep going or update now; on update the orchestrator runs
the harness's update commands (`claude plugin marketplace update` and
`claude plugin update` in Claude Code, `codex plugin marketplace upgrade`
and `codex plugin add` for vibe and closedloop-core in Codex) and asks them
to reopen the app. When the check cannot reach GitHub the session carries
on and says so.

Sessions keep Codex and Claude usage down. Each worker's model follows its
role from one policy per harness: in Codex, `scripts/worker-model.mjs` (backed
by `cl-sweep/scripts/model-policy.mjs`, which cl-sweep and cl-execute use too)
puts read-only explorers (requirements, backend, primitive and Storybook
advice, the handoff summary) on `gpt-5.6-terra` and every writer, reviewer
and verifier on `gpt-6-sol`, all at reasoning effort `high` unless raised
explicitly; in Claude Code the agent files' `model:` frontmatter does the
same with sonnet. Before spawning workers or forwarding a request, and when a
turn stalls, Codex runs `scripts/codex-usage.mjs check`, which reads the
account's rate limits from the App Server through codex-fleet-monitor's
shared reader; the Claude launcher reads each turn's `rate_limit_event`. A
reached limit that no longer allows ordinary usage, or paid extra usage in
Claude Code, stops the session with a plain message unless the person explicitly
allowed credits. Containerized e2e runs only the specs the change needs, one
stack per machine through `scripts/e2e-lock.mjs`.

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
runs only the targeted existing tests (the ones closedloop-graph's
`code_tests_for` returns for each changed file) with Biome, source gates and
the affected typecheck, never a broad or full local suite; CI runs those. The
writer fixes the session's own code
when one fails, never what a test asserts, and the ticket lists the missing tests as
engineering's scope of work: the behavior and row each covers and the files
to cover. Only the person's explicit request for a pull request authorizes
tests, and then full tests for every change are written and pass before it
opens. Valid expectations and checks are never weakened to obtain a pass.
Coverage is planned and independently verified from the whole session
decision table, including earlier requests and real-boundary negative cases.
Required source, existing-test or review gaps block final alignment and
handoff; a listed missing test does not.
The handoff inventory also runs `diff-rules.mjs` and reports `diffRules`: a
migration on an existing table without its recorded lock-strategy precedent
or with a full-table backfill, a raw write of a captured artifact field, an
error returned inside a transaction after a write, a Desktop sync lane without
the shared give-up, backoff and a synchronizing-susan pass, an unscoped
artifact link delete, a dropped ticketed comment, an unrecorded change to a
shared service, a story assertion changed without a release, a new story
entry beside a component's current one, a change in a frozen v1.0
story's import closure, a new user-visible string with no cited source, a
component or file a base commit removed brought back without `Restore
authorization:` (or a shallow clone that hides the removal), a shipped mount
or user-visible string removed without a `Removal:` source, and a diagnostic that dumps the whole environment each block
(`blocking.diffRulesClear`) until the writer fixes the code or records the
change log line the finding names. It also lists tests the graph does not map,
which the verify worker runs. A repository that declares its Storybook rules in
`.vibe/storybook-rules.json` (example: `skills/handoff/references/storybook-rules.example.json`)
also blocks a story change that needs a Storybook release and has none or the
wrong semver level, a reused release version, new stories under a frozen root,
an edit handler wired to a no-op, a hand-rolled table row or cell, a new or
story the diff adds or edits that names a component with no controls decision (a gate allowlist does not count), a
lifecycle tag outside its roots, a control's computed options list, and a
story-local copy of a component the diff deletes; its `checks` (the repo's
own Storybook commands) become required runs whenever a story changes.
Handoff also drives the running web app and Desktop for each touched screen
with symphony-alpha's control skill (`pnpm control`, hidden and read-only),
and records the artifact paths and what each proves in Design Review and the
ticket's Running app checks, apart from source-only claims. The build loop has
no control step.
The existing table attachment remains separate from the session's PLN.
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
Nothing agent-written goes into public docs (operator ruling, 2026-10-16):
the writer edits nothing under `apps/web/content/docs/` nor the internal `docs/` folder and only
lists, under the ticket's Feature docs, the existing product docs pages that
describe a changed feature, for design or engineering to update; the handoff
inventory reports any docs change as outside the allowed paths in every
phase. The writer also marks the
rows the person accepted as Frozen Behavior in the session decision table that
the ticket attaches; `cl-execute` reads that attachment, keeps every frozen row
passing with tests in its pull request, and changes one only with that
person's explicit OK.
The handoff inventory also reports what a pull request body must state, and
blocks creating one that misses a fact or lacks passing runs.

### `vibe-seed-refresh`

Checks symphony-alpha's vibe seed against fresh main and the latest Vibe Seed
Walk. When drift exists, coordinates workers to create a live ticket, fix the
seed in a fresh worktree, validate it, open and monitor a pull request, merge
through the queue, and mark the ticket Done. The fix worker runs the full web
and Desktop screen walk itself, on a Mac through `pnpm vibe walk-linux`, and
its counts and result file go into the PR's Test plan and the ticket's loop.

### `codex-fleet-monitor`

Background event watcher for a fleet of long-running Codex App Server threads
(local and one ssh host) plus the pull requests they produce. One command polls
every watched thread and PR and exits with a diff on the first change: a session
going idle, stalling, or failing, a merge conflict, new review or comment
counts, changed checks, or a new PR. Liveness is read from the thread's last
turn and its newest item, so a turn left open by a silent Codex usage limit
shows as `STALLED` instead of running forever. It never loads a thread's history,
so a pass stays small on long-lived threads. It also prints a Codex usage line for each
machine (used-percent band, and whether a reached limit has started spending
paid credits), check counts only once they settle, and optionally the
delegated-work request files sessions drop for Claude workers. A turn that
failed with a transient provider error (model at capacity, rate limit, 5xx) is
resumed after a backoff with a continue prompt; a thread left in `systemError`
gets an alert, or a daemon restart when `AUTO_RESTART_DAEMON=1`, after which
the sessions on that host whose turn was active or failed are resumed and idle
ones stay idle. `supervise.sh` runs that recovery on the host that owns
the sessions with no orchestrator awake, one per host, with launchd and systemd
templates. Each supervisor pass is bounded by `PASS_TIMEOUT_SECONDS`; the
supervisor writes a heartbeat after every pass and an hourly summary, and the
watcher reports a stale, missing or high-RSS heartbeat. `events.log` and
`supervisor.log` rotate at `LOG_MAX_BYTES`, and a PR's state files are removed
once it leaves `prs.txt`. A failed `gh` read repeats the last value. A change made
between a watcher exit and its re-arm is still reported. It needs only this
plugin and the `codex` CLI; sessions are listed by thread id.

### `fleet-orchestrator`

Playbook for a Claude Code session orchestrating several Codex and Claude
workers on parallel PRs, on one or more machines, for an operator who does QA
and merges: roles, orchestration state that survives a reboot or compaction,
Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e
stack slot locks, agent-first QA, pushback on flags and extra code paths, and a
lessons ledger. `fleet.sh` starts or resumes a Codex thread bound to a
worktree, starts and steers turns from prompt files and reads the last messages,
on this machine or over ssh on another, and runs commands in a machine's named
slots. `request-visual.mjs` files a Codex session's visual-work request only when it names the PR's pushed head. Machine specifics live in the orchestration dir's `config.env`, shared
with `codex-fleet-monitor`, which watches the fleet. One machine needs no remote
config; more need ssh key auth plus `codex`, `node` and `gh` on each.

### ClosedLoop Ticket Skills

The plugin bundles the ClosedLoop ticket automation skill pack: `cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`, `cl-work-report`, `cl-sweep`, and `cl-execute`. Together they cover policy-aware ticket analysis, related-ticket discovery, safe one-level split workflows, private project work reports, sweep coordination, and end-to-end ticket execution. The imported sweep scripts use the native managed Codex App Server through bundled helpers rather than depending on a separate `app-server-orchestrator` skill. Runtime access still depends on the operator's normal ClosedLoop, GitHub, `workflow-memory`, and `closedloop-graph` MCP/API configuration.

## Agents

| Agent | Model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ticket, requirements, overlap, and owning-route discovery, reference-product research and help-center precedent research |
| `vibe-ticket-worker` | sonnet | Live ticket creation and source link, the session plan as a linked PLN, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, deployment records, and opening a pull request the person asked for at handoff |
| `vibe-change-worker` | sonnet | Sole persistent implementation writer for local planning, full-stack changes, stories, fixes, the handoff missing tests list and serialized recording |
| `vibe-backend-worker` | sonnet | Read-only decision-table and backend guidance for that writer |
| `vibe-primitive-worker` | sonnet | Read-only reusable-component and steward-specification guidance for that writer |
| `vibe-prototype-worker` | sonnet | Read-only canonical prototype guidance or operational immutable Vercel sharing of the writer's reviewed committed result |
| `vibe-storybook-decomposer` | sonnet | Read-only Storybook placement owner (precedent search on sibling entities before any story or shared component is placed) and component extraction, story and control guidance for that writer |
| `vibe-verify-worker` | sonnet | Read-only targeted existing checks (`code_tests_for` per changed file), locked containerized e2e for the specs the change needs, handoff coverage review, Storybook footprint and handoff running app checks with `pnpm control` |
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

The two cases tagged `main-failures` rehearse handoff's validation step: a
check that also fails on the captured main is recorded on the ticket's
Engineering checklist and the handoff goes on, and a session-caused failure
goes back to the writer.

The cases tagged `precedent`, `visual-qa` and `version-check` rehearse the
2026-10-16 operator rulings: a product question the graph or a precedent
already answers is not asked, live Asana is checked after the other ordered
sources and a question is asked only when none settles it; visual QA is offered at a
visible milestone and not on a small edit, a polish request runs it before
handoff (against the criteria, or the design pack's review without them)
and skips it after the person declined; and the startup version check asks
"keep going or update" when outdated (alone, with the new session's endings
line waiting for the first reply after that answer), says nothing when current, carries on
when GitHub cannot be reached, and asks for a reopen after updating.

The eight cases tagged `review-lessons` come from the reviews of vibe
feature pull requests (operator rulings, 2026-10-16 and 2026-10-20). Each rehearses one
handoff review decision from supplied session state: a main sync that turned
a shipped editable control read-only, an invented Version History entry and a
reworded compile-only repair, a stale story ID left in an e2e spec, two
children each wiring their own selection behind a shared slot, a criterion
checked on one view but not the board it names, an agent-drafted product docs
paragraph, a flag retired while a linked ticket held it, and one redesign
gated behind three new keys beside a gate on a wording fix to a shipped
surface.

The six cases tagged `qa-lessons` rehearse real-browser Storybook play
execution, WebKit iPhone and Chromium Pixel touch coverage, overlap research
that includes shipped work and open pull requests, web and Desktop host-adapter
coverage before reporting no missing tests, and weekly-project fallback. The
same prompt and graders run in the Claude Code and Codex harnesses.

The cases tagged `ticket-lessons` rehearse source PRD child ownership: an
untouched included child is claimed, an active child owned elsewhere is
reported and excluded, an untouched out-of-scope child remains uncovered, and
no child is superseded without a human ruling. Version-check cases also cover
explicit proceed instructions and resumed sessions continuing after reporting
an available update.

The case tagged `review-gates` rehearses a blocking `diffRules` finding:
handoff stops and the same writer adds the canonical activity capture
instead of a placeholder change log line, while the unmapped parity test
still runs.

The `pr-facts` case checks that a body missing computed facts is not created.

The case tagged `ledger-lessons` rehearses a claimed PRD child moving to In
Review only when its evidence map passes `live-ticket-check.mjs --child-evidence`.

The case tagged `orchestration-lessons` rehearses a Codex writer stopped by
its account's usage limit, which moves to Claude through the writer ledger's
harness switch instead of another worker doing its work.

## Runtime Files

Version `1.0.85` contains 12 skills, 16 agents, and one hook manifest
(`hooks/hooks.json`). It has no standalone commands, root-level shell scripts,
or production Python tools under
`tools/python/`; that directory contains the skill-contract test modules and
`vibe_contract_text.py`, the text helpers they share.
Runtime helpers and tests live alongside their owning skills, including vibe
session and prototype records, local-plan publication guards, bundled persistent
writer state, Claude launch/resume and shared main-sync publication helpers,
handoff checks, sweep ownership
and worker recovery, and the work-report renderer. Shared PR-monitor notification delivery
and manual-QA browser helpers live in `closedloop-core`.
