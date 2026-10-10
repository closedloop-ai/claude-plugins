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
commits, publications, and ticket uploads. A separate adversarial reviewer
checks the plan before implementation; independent implementation reviews,
corrections, and existing checks precede feature completion.

Every request also uses `$decision-table` or `/closedloop-core:decision-table`
before code, including frontend-only, prototype and trivial edits. One living
artifact at `.closedloop-ai/decision-tables/<session-slug>.md` keeps stable row
IDs, request provenance, grouped behavior sections and cross-request interactions.
Later requests append sourced expectations; prior baselines/targets stay frozen
and superseded human decisions remain explicit. The same writer verifies actual
implementation against affected and interacting prior rows after each correction.
Planned handoff tests remain distinct from executed coverage.

The orchestrator queues new requests and resumes that same writer's context
for each request, correction and handoff. Independent specialists and reviewers
may run in parallel, read-only. Operational helpers retain bootstrap, deployment
and ticket duties without authoring implementation code. Shared session records,
ticket sections and change logs stay serialized. Workers never commit; the
orchestrator retains the commit boundary. New or changed tests wait for handoff,
while existing tests and Storybook checks run during building.
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
An existing registered writer retains its original definition root, exact
binding and actual ID. The root supplies the new table policy through its
existing continuation; it does not reset or re-register under an updated
release digest. An unavailable original binding blocks new code.

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

### `handoff`

Checks and reviews the session's work, verifies its current app environment or
canonical prototype publication, and completes the same live ticket. Resolves
the next owner named by the person and assigns the ticket with status In
Progress. Canonical prototype review and metadata transitions are preserved;
handoff ends at the branch without opening a pull request.
The same implementation writer authors focused tests only at handoff,
covering acceptance criteria, production wiring, and failure paths. New tests
receive independent review and final integrated verification; valid
expectations and checks are never weakened to obtain a pass.
Coverage is planned, authored and independently verified from the whole session
decision table, including earlier requests and real-boundary negative cases.
Required source, coverage or review gaps block final alignment and handoff.
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

### `vibe-seed-refresh`

Checks symphony-alpha's vibe seed against fresh main and the latest Vibe Seed
Walk. When drift exists, coordinates workers to create a live ticket, fix the
seed in a fresh worktree, validate it, open and monitor a pull request, merge
through the queue, and mark the ticket Done.

### ClosedLoop Ticket Skills

The plugin bundles the ClosedLoop ticket automation skill pack: `cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`, `cl-work-report`, `cl-sweep`, and `cl-execute`. Together they cover policy-aware ticket analysis, related-ticket discovery, safe one-level split workflows, private project work reports, sweep coordination, and end-to-end ticket execution. The imported sweep scripts use the native managed Codex App Server through bundled helpers rather than depending on a separate `app-server-orchestrator` skill. Runtime access still depends on the operator's normal ClosedLoop, GitHub, `workflow-memory`, and `closedloop-graph` MCP/API configuration.

## Agents

| Agent | Model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ticket, requirements, overlap, and owning-route discovery |
| `vibe-ticket-worker` | sonnet | Live ticket creation, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, and deployment records |
| `vibe-change-worker` | sonnet | Sole persistent implementation writer for local planning, full-stack changes, stories, fixes, handoff tests and serialized recording |
| `vibe-backend-worker` | opus | Read-only decision-table and backend guidance for that writer |
| `vibe-primitive-worker` | sonnet | Read-only reusable-component and steward-specification guidance for that writer |
| `vibe-prototype-worker` | sonnet | Read-only canonical prototype guidance or operational immutable Vercel sharing of the writer's reviewed committed result |
| `vibe-storybook-decomposer` | sonnet | Read-only component extraction, placement, story and control guidance for that writer |
| `vibe-verify-worker` | sonnet | Read-only existing checks, handoff coverage review, full backend suite and Storybook footprint |
| `vibe-guardrails-reviewer` | sonnet | Read-only judgment-based review of reuse, placement, copy provenance, accessibility, and tests |
| `vibe-adversarial-reviewer` | opus | Separate read-only plan and implementation reviews of ownership, dependencies, contracts, regressions, and web/Desktop behavior |
| `vibe-handoff-summarizer` | sonnet | Read-only plain-language summary of the session inventory, changes, and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | sonnet | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

## Runtime Files

Version `1.0.8` contains 10 skills and 16 agents. It has no standalone
commands, hooks, root-level shell scripts, or production Python tools under
`tools/python/`; that directory contains two skill-contract test modules.
Runtime helpers and tests live alongside their owning skills, including vibe
session and prototype records, local-plan publication guards, bundled persistent
writer state, Claude launch/resume and shared main-sync publication helpers,
handoff checks, sweep ownership
and worker recovery, and the work-report renderer. Shared PR-monitor notification delivery
and manual-QA browser helpers live in `closedloop-core`.
