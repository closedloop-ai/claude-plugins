---
description: Deep code review — standard fleet plus the always-on Design Critic and the Impact Analyzer (FEA-1401) when changed exported symbols are detected or a file is deleted
argument-hint: "[scope] [--github] [--base <ref>] [--since-last-review] [--full-review]"
---

# Deep Code Review (PLN-807 + FEA-1401)

This command is shorthand for `/start --depth deep`. Follow every instruction in `${CLAUDE_PLUGIN_ROOT}/commands/start.md` verbatim, with two bindings:

**`PLUGIN_ROOT` = `${CLAUDE_PLUGIN_ROOT}`** (Claude Code fills this in for this command). This is the caller binding start.md's stage 0b resolves first. Wherever start.md (or any file it tells you to read) writes `${CLAUDE_PLUGIN_ROOT}` or `<PLUGIN_ROOT>`, use this value. Do not try to read the plugin root from a Bash environment variable; it is not set there.

**`DEPTH = "deep"` for the entire run.** Pass `--depth deep` to every helper that accepts the flag (notably `prepare-run`, `hygiene`, `review-state-read`, and `review-state-write`).

## What deep does

Deep produces the standard fleet plus two deep-only conditional core reviewers: the always-on **Design Critic** and the trigger-gated **Impact Analyzer** (FEA-1401).

The **Design Critic** runs on **every** deep review (no trigger required). It evaluates the change for software-design craftsmanship — module depth and information hiding, SOLID adherence, dependency direction and layer boundaries, and project/package structure — drawing on *A Philosophy of Software Design*, the SOLID principles, and *Clean Architecture*. It flags only design flaws this change introduces or demonstrably worsens (a new shallow module, a wrong-direction dependency, a god-class this PR grew, a type-switch it extended), runs on Sonnet, and is **exempt from the domain-critic cap** (it is a `source: "core"` reviewer, not a project-specific critic). Like the Impact Analyzer it is code-intelligence-aware: when the operator's session provides an MCP server that indexes the repo, it uses that server for module/layer layout and for dependency direction and import cycles, falling back to grep otherwise. The plugin is substrate-agnostic — it names no particular server and works with whichever one is connected. Findings carry `category: "Code Quality"`.

The **Impact Analyzer** (FEA-1401) spawns when signal extraction detects `exported_symbol_change` or `symbol_deletion` in the diff, or when the diff deletes a file outright (the deterministic `file_deletion` change class). It identifies changed exported symbols (function signatures, type definitions, exported constants, class API, schema fields, deletions), greps the codebase for external usages outside the diff, and emits findings whose `external_impact[]` array lists every callsite that breaks under the new signature.

| Component | shallow | standard | deep |
|---|---|---|---|
| All standard reviewers | (subset) | ✓ | ✓ |
| Domain critics (from `critic-gates.json`) | ✗ | ✓ (≤3) | ✓ (≤3) |
| Design Critic | ✗ | ✗ | ✓ (always) |
| Impact Analyzer (FEA-1401) | ✗ | ✗ | ✓ (when triggered) |

The per-source **domain-critic cap is 3** on both standard and deep — deep's extra breadth now comes from the always-on Design Critic and the Impact Analyzer rather than from a wider domain-critic allowance.

The Impact Analyzer is **conditional**: it only spawns when at least one trigger signal fires above the recommended confidence floor (`exported_symbol_change ≥ 0.8`, `symbol_deletion ≥ 0.85`) or the diff deletes a file (`file_deletion`, read from `file_statuses` with no signal needed). A deep run on a docs-only diff or an internal refactor that exposes no new external surface will skip the analyzer entirely. Findings carry `category: "ImpactAnalysis"` and are verifier-audited per callsite (cited callsite read and content-matched, grep query replayed for the first 5 findings per batch). ≥2 verified BLOCKING/HIGH Impact findings escalate the verdict to `NEEDS_ATTENTION` (Rule 6).

Cost containment: 30 symbols × 50 callsites per symbol hard cap, 5-minute wall budget, 100 grep ops (soft), 250 read ops (soft). Deferred symbols beyond cap surface in the Coverage Plan footer so operators see what was sampled vs analyzed.

## When to use

- Architectural refactors where cross-file impact matters and per-callsite blast-radius analysis is worth ~$0.25–$2 of Opus cost.
- Releases where review cost is acceptable relative to risk (public API surface changes, migrations, library upgrades).
- Cases where shallow or standard already ran and surfaced a `tier_mismatch_nudge` suggesting deep would have caught more.

## Cache semantics

A cached `shallow` or `standard` review does NOT satisfy a deep invocation — `review-state-read --depth deep` returns a cache miss for any entry whose stored tier is weaker, forcing the deep run to actually execute. This is the tier-aware extension to the existing SHA-based cache.

## Execution

Follow `start.md` from "Stage 0 — Initialize Run Plan" through every gate and stage, with the `PLUGIN_ROOT` binding above and `DEPTH = "deep"` substituted into every helper invocation. The run plan emitted by `prepare-run --depth deep` will include every stage tagged `min_depth` ≤ `deep` (today: same as standard); the walker behavior is otherwise unchanged.
