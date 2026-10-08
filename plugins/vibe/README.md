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

The orchestrator queues new requests and resumes that same writer's context
for each request, correction and handoff. Independent specialists and reviewers
may run in parallel, read-only. Operational helpers retain bootstrap, deployment
and ticket duties without authoring implementation code. Shared session records,
ticket sections and change logs stay serialized. Workers never commit; the
orchestrator retains the commit boundary. New or changed tests wait for handoff,
while existing tests and Storybook checks run during building.

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

Version `1.0.2` contains 10 skills and 16 agents. It has no standalone
commands, hooks, root-level shell scripts, or production Python tools under
`tools/python/`; that directory contains two skill-contract test modules.
Runtime helpers and tests live alongside their owning skills, including vibe
session and prototype records, local-plan publication guards, bundled persistent
writer state and Claude launch/resume helpers, handoff checks, sweep ownership
and worker recovery, and the work-report renderer. Shared PR-monitor notification delivery
and manual-QA browser helpers live in `closedloop-core`.
