---
description: Deep code review — standard fleet plus any reviewers tagged min_depth=deep (reserved for FEA-1401 Impact Analyzer)
argument-hint: "[scope] [--github] [--base <ref>] [--since-last-review] [--full-review]"
---

# Deep Code Review (PLN-807)

This command is shorthand for `/start --depth deep`. Follow every instruction in `${CLAUDE_PLUGIN_ROOT}/commands/start.md` verbatim, with one binding:

**`DEPTH = "deep"` for the entire run.** Pass `--depth deep` to every helper that accepts the flag (notably `prepare-run`, `hygiene`, `review-state-read`, and `review-state-write`).

## What deep does

Today deep produces the same fleet as standard — no stage has `min_depth: deep` yet. The slot exists so future heavy reviewers (FEA-1401 Impact Analyzer being the next planned occupant) can ship behind an explicit opt-in without forcing the cost onto every standard review.

| Component | shallow | standard | deep |
|---|---|---|---|
| All standard reviewers | (subset) | ✓ | ✓ |
| `impact_analyzer` (future, FEA-1401) | ✗ | ✗ | ✓ |

The `min_depth: deep` band on a stages.json entry is the seam future heavy reviewers slot into.

## When to use

- Architectural refactors where cross-file impact matters and the Impact Analyzer's per-callsite analysis is wanted (once shipped).
- Releases where review cost is acceptable relative to risk.
- Cases where shallow or standard already ran and surfaced a `tier_mismatch_nudge` suggesting deep would have caught more.

## Cache semantics

A cached `shallow` or `standard` review does NOT satisfy a deep invocation — `review-state-read --depth deep` returns a cache miss for any entry whose stored tier is weaker, forcing the deep run to actually execute. This is the tier-aware extension to the existing SHA-based cache.

## Execution

Follow `start.md` from "0a. Resolve plugin root" through every gate and stage, with `DEPTH = "deep"` substituted into every helper invocation. The run plan emitted by `prepare-run --depth deep` will include every stage tagged `min_depth` ≤ `deep` (today: same as standard); the walker behavior is otherwise unchanged.
