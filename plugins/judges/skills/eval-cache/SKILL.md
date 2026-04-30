---
name: eval-cache
description: |
  Check for a cached plan-evaluation.json result before launching the plan-evaluator agent.
  This skill should be used in Phase 1.3 (Simple Mode Evaluation) of the orchestrator prompt.
  Triggers on: entering Phase 1.3, checking simple mode, evaluating plan complexity.
  Returns EVAL_CACHE_HIT with cached values or EVAL_CACHE_MISS signaling re-evaluation is needed.
context: fork
allowed-tools: Bash
---

# Eval Cache

Check whether a prior simple-mode evaluation can be reused, avoiding a redundant plan-evaluator launch when the plan has not changed.

## When to Use

Activate this skill at the start of Phase 1.3 (Simple Mode Evaluation), **before** launching `@code:plan-evaluator`. If the cache is fresh, skip the evaluator entirely and use the cached result.

## Usage

Run the cache check script:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/check_eval_cache.sh <WORKDIR>
```

## Interpreting Output

The script prints one of two structured results to stdout:

### Cache Hit

```
EVAL_CACHE_HIT
simple_mode: true|false
selected_critics: [critic1, critic2, ...]
summary: <cached evaluation summary>
```

**Action:** Parse `simple_mode` and `selected_critics` from the output. Skip launching `@code:plan-evaluator` and proceed with the cached values as if the evaluator had just returned them.

### Cache Miss

```
EVAL_CACHE_MISS
reason: <why the cache is stale or missing>
```

**Action:** Launch `@code:plan-evaluator` as normal. The evaluator will write a fresh `plan-evaluation.json` that subsequent iterations can cache from.

## How Freshness Works

The script uses file modification timestamps:
- If `plan-evaluation.json` does not exist: **miss**
- If `plan.json` is newer than `plan-evaluation.json`: **miss** (plan was modified since last evaluation)
- If `plan-evaluation.json` is newer than `plan.json`: **hit** (evaluation is still valid)

This correctly handles the case where a user modifies the plan while the workflow is paused: editing `plan.json` updates its mtime, invalidating the cached evaluation.
