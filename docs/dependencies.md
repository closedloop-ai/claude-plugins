# Plugin Dependency Map

Cross-plugin dependencies between plugins in this repository. **None of these dependencies are declared in `plugin.json` files** — they are all implicit runtime references discovered by code inspection.

## Dependency Graph

```
platform (standalone)
self-learning (standalone, depended on by code)

bootstrap ──► code
code-review ──► code
code-review ──► judges
code ◄──────► judges  (mutual)
code ────────► self-learning
```

## Per-Plugin Details

### `code` → `judges`

| Type | File | Reference |
|---|---|---|
| Skill invocation | `code/prompts/prompt.md` (lines 93, 239) | `judges:eval-cache` |
| Skill invocation (shell) | `code/scripts/run-loop.sh` (lines 302, 337) | `judges:run-judges` |

### `code` → `self-learning`

| Type | File | Reference |
|---|---|---|
| Skill declaration (YAML) | 8 agent files (`plan-draft-writer.md`, `plan-writer.md`, `plan-validator.md`, `cross-repo-coordinator.md`, `generic-discovery.md`, `code-reviewer.md`, `implementation-subagent.md`, `verification-subagent.md`) | `self-learning:learning-quality` |
| Command invocation (shell) | `code/scripts/run-loop.sh` (line 489) | `/self-learning:process-learnings` |
| Command invocation (shell) | `code/scripts/run-loop.sh` (line 522) | `/self-learning:export-closedloop-learnings` |
| Hardcoded filesystem path | `code/scripts/run-loop.sh` (line 356) | `../../self-learning/tools/python` — calls 7 Python scripts: `pattern_relevance.py`, `merge_relevance.py`, `evaluate_goal.py`, `merge_goal_outcome.py`, `verify_citations.py`, `merge_build_result.py`, `compute_success_rates.py` |
| Hardcoded filesystem path | `code/scripts/install-dependencies.sh` (line 10) | `self-learning/tools/python/requirements.txt` |

### `judges` → `code`

| Type | File | Reference |
|---|---|---|
| Agent reference | `judges/skills/eval-cache/SKILL.md` (lines 18, 41, 50) | `@code:plan-evaluator` |

### `code-review` → `code`

| Type | File | Reference |
|---|---|---|
| Agent subagent_type | `code-review/commands/code-review.md` (lines 109, 575, 770, 781, 873) | `code:code-review-worker` |

### `code-review` → `judges`

| Type | File | Reference |
|---|---|---|
| Python sys.path import | `code-review/tools/python/test_validate_judge_report.py` (lines 11–16) | Imports `validate_judge_report` and `JUDGE_REGISTRY` from `judges/skills/run-judges/scripts/` |

### `bootstrap` → `code`

| Type | File | Reference |
|---|---|---|
| Skill in template | `bootstrap/agents/AGENT_FORMAT.md` (lines 15, 34) | `code:find-plugin-file` |
| Validation rule | `bootstrap/agents/agent-prompt-validator.md` (line 106) | Enforces `code:find-plugin-file` usage |

### `platform`

No cross-plugin dependencies. Standalone reference/documentation plugin.

### `self-learning`

No outbound cross-plugin dependencies. Depended on by `code`.

## Key Observations

1. **`code` is the hub** — depended on by `code-review`, `judges`, and `bootstrap`, while itself depending on `judges` and `self-learning`.
2. **`code` ↔ `judges` remains a circular dependency** — `code` invokes judge skills, while judges references `@code:plan-evaluator` and `@code:pre-explorer`.
3. **`code` → `self-learning` is the deepest coupling** — `run-loop.sh` directly calls 7 Python scripts by hardcoded relative path, making `code`'s post-iteration pipeline inoperable without `self-learning`.
4. **All dependencies are undeclared** — no `plugin.json` files specify a `dependencies` field.
