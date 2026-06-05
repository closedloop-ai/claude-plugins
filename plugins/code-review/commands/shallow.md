---
description: Shallow code review — built-in reviewers only (BHA + BHB + auditor + verifier); no premise, no critic-gates, no signal extraction
argument-hint: "[scope] [--github] [--base <ref>] [--since-last-review] [--full-review]"
---

# Shallow Code Review (PLN-807)

This command is shorthand for `/start --depth shallow`. Follow every instruction in `${CLAUDE_PLUGIN_ROOT}/commands/start.md` verbatim, with one binding:

**`DEPTH = "shallow"` for the entire run.** Pass `--depth shallow` to every helper that accepts the flag (notably `prepare-run`, `hygiene`, `review-state-read`, and `review-state-write`).

## What shallow does

| Component | shallow | standard | deep |
|---|---|---|---|
| Hygiene (deterministic) | ✓ | ✓ | ✓ |
| signal_extraction | ✗ | ✓ | ✓ |
| coverage_critic | ✗ | ✓ | ✓ |
| bug_hunter_a (partitioned at >5000 LOC) | ✓ | ✓ | ✓ |
| bug_hunter_b | ✓ | ✓ | ✓ |
| unified_auditor | ✓ | ✓ | ✓ |
| premise_reviewer | ✗ | ✓ | ✓ |
| critic-gates.json domain critics | ✗ | ✓ (≤5) | ✓ (≤5) |
| Verifier | ✓ | ✓ | ✓ |
| fast_path_reviewer (auto on tiny PRs) | ✓ (auto) | ✓ (auto) | ✓ (auto) |

## When to use

- Quick sanity check on a focused bugfix.
- Cross-repo CI where you want predictable behavior regardless of `critic-gates.json` shape.
- "Just find the obvious bugs" — bug-finding fleet intact; opinion-layer agents skipped.

## When NOT to use

If the PR is > 3000 LOC, touches schema/migrations, or modifies public API surfaces (plugin.json, index.ts, __init__.py), shallow will emit a `tier_mismatch_nudge` LOW finding suggesting `--depth standard`. Pay attention to that nudge — those are the cases shallow's missing reviewers commonly catch.

## Execution

Follow `start.md` from "0a. Resolve plugin root" through every gate and stage, with `DEPTH = "shallow"` substituted into every helper invocation. The run plan emitted by `prepare-run --depth shallow` includes the core pipeline minus 10 standard-only stages (signal extraction, coverage planning/critic, budget arbitrate, derive/verify spawn-spec). The walker behavior is otherwise unchanged. `stage_19c_derive_static_spec` runs in place of `stage_19b_derive_spawn_spec` and produces an `arbitrate_status: "static"` spec with BHA × N + BHB + unified_auditor.
