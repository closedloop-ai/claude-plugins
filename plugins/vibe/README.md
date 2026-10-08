# vibe Plugin

Vibe sessions, ClosedLoop ticket workflows, and PR monitoring.

## Installation

Codex installs both `vibe@closedloop-ai` and `closedloop-core@closedloop-ai`.
Claude Code installs `vibe@closedloop-ai`; its dependency installs core automatically.
See the [Mac installation guide](skills/vibe/INSTALL.md).
Skills use `$<name>` in Codex and `/vibe:<name>` in Claude Code.
Codex workers read `agents/<name>.md` in this plugin; Claude workers use `vibe:<name>`.
Shared skills belong to `closedloop-core`: for example, use `$decision-table`
in Codex or `/closedloop-core:decision-table` in Claude Code.

## Skills

### `vibe`

Starts or resumes an owned symphony-alpha session with a live ClosedLoop
ticket. App changes use a seeded or blank per-branch environment. Mockup
requests automatically invoke the repository's canonical prototype workflow
on `prototype/<slug>`, share on Vercel, and return the immutable preview URL,
full deployed SHA, and slug. Workers own changes, annotations, and redeploys.

### `handoff`

Checks and reviews the session's work, verifies its current app environment or
canonical prototype publication, and completes the same live ticket. Resolves
the next owner named by the person and assigns the ticket with status In
Progress. Canonical prototype review and metadata transitions are preserved;
handoff ends at the branch without opening a pull request.

### `vibe-seed-refresh`

Checks symphony-alpha's vibe seed against fresh main and the latest Vibe Seed
Walk. When drift exists, coordinates workers to create a live ticket, fix the
seed in a fresh worktree, validate it, open and monitor a pull request, merge
through the queue, and mark the ticket Done.

### `measurement-discipline`

Applies baseline measurements, repeated-run noise floors, one-variable
experiments, controls, and a mechanism for claimed improvements. Records
successes and refutations in an append-only measurement log with reproducible
commands and re-check conditions.

### `guided-manual-qa`

Derives and runs an interactive, evidence-recorded manual QA session for a code change, ticket, branch, or pull request. Resolves the exact worktree and head under test, maps candidate checkpoints against passing exact-head E2E coverage, and presents a checkpoint to the human only when neither that E2E coverage nor the agent's own observation can reliably verify it: visual or perceptual judgments, flows the agent cannot drive or observe reliably, and product-judgment calls. Prepares a trustworthy local environment (worktree-owned services, verified origin, proven persistence chain), writes a durable Markdown QA record outside the tracked tree before the first checkpoint, and proves each checkpoint's oracle before presenting it. The human confirms each checkpoint routed to them with `PASS`, `FAIL`, or `BLOCKED`. An agent observation can close a checkpoint as `AGENT_VERIFIED` and a passing E2E assertion as `E2E_COVERED`, never as a human `PASS`; an inconclusive agent observation goes to the human, and the final summary counts each kind separately. Ships a bundled Playwright launcher (`scripts/dist/launch-interactive-browser.mjs`, Node 18+) that opens the interactive browser with preloaded localStorage fixtures and an optional route-ready selector gate. Scripts are TypeScript under `tools/guided-manual-qa/src/` with the built bundle committed to `skills/guided-manual-qa/scripts/dist/`. Performs no source changes or external writes without separate authorization. The same skill directory also carries `agents/openai.yaml` display metadata so Codex can load it as a skill.

### `gh-monitor-pr`

Detached GitHub pull-request monitor for waking the exact launching Codex Desktop or CLI root when review comments, CI failures, conflicts, merge-queue changes, closure, merge readiness, or successful merges need attention. It uses the native managed Codex App Server daemon and portable proxy/direct Unix-socket transports to steer an active parent turn or start a turn on an idle parent, while persisting monitor-local delivery receipts so ambiguous accepted wakeups are not replayed automatically. Includes CLI setup/probe, start, transfer, recovery, status, stop, and one-shot snapshot commands, plus tests for notification delivery, recovery, and PR event evaluation. The skill has no `app-server-orchestrator` dependency.

### ClosedLoop Ticket Skills

The plugin bundles the ClosedLoop ticket automation skill pack: `cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`, `cl-work-report`, `cl-sweep`, and `cl-execute`. Together they cover policy-aware ticket analysis, related-ticket discovery, safe one-level split workflows, private project work reports, sweep coordination, and end-to-end ticket execution. The imported sweep scripts use the native managed Codex App Server through bundled helpers rather than depending on a separate `app-server-orchestrator` skill. Runtime access still depends on the operator's normal ClosedLoop, GitHub, `workflow-memory`, and `closedloop-graph` MCP/API configuration.

## Agents

| Agent | Model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ticket, requirements, overlap, and owning-route discovery |
| `vibe-ticket-worker` | sonnet | Live ticket creation, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, and deployment records |
| `vibe-change-worker` | sonnet | Requested frontend changes and annotations, shared-owner placement, stories, and live ticket updates |
| `vibe-backend-worker` | opus | Decision-table-driven API, shared types, schema, migration, and seed changes |
| `vibe-primitive-worker` | sonnet | Reusable design-system or feature building blocks from a steward's specification |
| `vibe-prototype-worker` | sonnet | Canonical prototype iteration, immutable Vercel sharing, live ticket updates, and design handoff without a pull request |
| `vibe-storybook-decomposer` | sonnet | Component extraction, placement, and Storybook stories and controls |
| `vibe-verify-worker` | sonnet | Code checks, fixes within session changes, full backend suite, and Storybook footprint |
| `vibe-guardrails-reviewer` | sonnet | Read-only judgment-based review of reuse, placement, copy provenance, accessibility, and tests |
| `vibe-adversarial-reviewer` | opus | Read-only frontend correctness, shared-consumer regressions, and web/Desktop divergence review |
| `vibe-handoff-summarizer` | sonnet | Read-only plain-language summary of the session inventory, changes, and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | sonnet | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

## Runtime Files

Version `1.0.0` contains 13 skills and 16 agents. It has no standalone
commands, hooks, root-level shell scripts, or production Python tools under
`tools/python/`; that directory contains two skill-contract test modules.
Runtime helpers and tests live alongside their owning skills, including vibe
session and prototype records, handoff checks, sweep ownership and worker
recovery, PR-monitor notification delivery, and the work-report renderer.
