# closedloop-core Plugin

Shared ClosedLoop planning, intelligence, diagrams, and review skills.

## Installation

Codex installs `closedloop-core@closedloop-ai` explicitly. Claude Code resolves
core automatically through the `code`, `vibe`, and `platform` dependencies.
Skills use `$<name>` in Codex and `/closedloop-core:<name>` in Claude Code.
Always load these skills by name, then read resources from the loaded skill's own folder.

## Skills

### `closedloop-intel`

Read-only ticket and codebase intelligence through the dynamically discovered
`closedloop-graph` MCP server. Fetches the live routing protocol before answering
ticket lookup, lineage, overlap, rollup, architecture, dependency, and blast-radius
questions. Reports cited ticket slugs and source paths, and stops if the server
is unavailable.

### `plan-structure`

Provides reusable guidance for plan creation and updates. When activated, agents must read the `resources/playbook.md` (conventions and quality bar) and `resources/plan_template.md` (required structure and sections). Used by `plan-draft-writer` and `plan-writer`.

### `decision-table`

Generates a repo-local decision-table artifact that makes control-flow and stateful edge cases reviewable. Used when the user wants a code-grounded table for current behavior, wants to compare current behavior against a plan or work item, or needs a control-flow artifact for recovery, retry, finalization, validation, state-machine, or review-heavy edge cases. Writes one artifact per work item under `.closedloop-ai/decision-tables/` (`<plan-id>.md` for plan-scoped work, `<short-work-name>.md` otherwise) using the format defined in `references/artifact-format.md`. Builds the `Current Code` table from code (not expectations), captures the target behavior in `Intended Change`, and freezes both once implementation begins; post-implementation drift is recorded in append-only `Verification Findings`, `Adversarial Review`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications` sections. Includes a behavioral edge-case expansion pass that explicitly models structured-result setup failures, shared host reachability, library-managed lifecycle re-entry, published contract compatibility, CLI flag parsing, filesystem read/write safety, time-bound credentials/signatures, durable finalization and replay eligibility, diagnostic reason taxonomies, and side-effect boundaries for validation failures. The artifact also records `Evidence Artifacts` for high-yield coverage and non-applicability claims, distinguishing named fail-closed test coverage from source-backed `not applicable` evidence, and supports coordinator-run adversarial lanes with a sequential fallback for subagents that cannot delegate.

### mermaid-visualizer

**Trigger conditions**: When a user asks to explain a complex idea, concept, or system architecture, or when a diagram would help visualize control flows, system architectures, data flows, state machines, sequence diagrams, or entity relationships.

**What it provides**:

A comprehensive guide for creating Mermaid diagrams embedded in markdown. Covers six diagram types with syntax reference and best practices:

| Diagram Type | Best For |
|---|---|
| Flowcharts | Decision trees, process flows, control flows |
| Sequence Diagrams | Component/system interactions over time |
| State Diagrams | State transitions and triggers |
| Class Diagrams | Object-oriented relationships and hierarchies |
| Entity Relationship Diagrams | Database schemas and data relationships |
| System Architecture Diagrams | Component relationships and service interactions |

**References**:

| File | Contents |
|------|----------|
| `references/mermaid-syntax.md` | Complete Mermaid syntax reference: node syntax (rectangular, diamond, rounded, stadium), edge syntax (solid, dotted, thick arrows with labels), prohibited symbols and safe alternatives, all six diagram types with examples, and 10 best practices for clarity |

### `workflow-code-review`

Worker-backed review of a requested PR, branch, diff, file list, or uncommitted
changes. Grounds reviewers in requirements, source evidence, repository
guardrails, and graph intelligence, then consolidates actionable findings across
approach, correctness, guardrail, compatibility, database, security, and existing
E2E coverage. Uses the review lenses bundled in `references/prompt-pack/` unless
a valid external prompt pack is configured. Review alone does not authorize
implementation, commits, pushes, PR lifecycle actions, or merges.
