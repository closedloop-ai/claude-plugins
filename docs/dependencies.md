# Plugin Dependency Map

Cross-plugin dependencies between plugins in this repository. **None of these dependencies are declared in `plugin.json` files** — they are all implicit runtime references discovered by code inspection.

## Dependency Graph

```
platform (standalone)
code-review (standalone)
self-learning (standalone, depended on by code)

bootstrap ──► code
code ────────► self-learning
```

## Per-Plugin Details

### `code` → `self-learning`

| Type | File | Reference |
|---|---|---|
| Skill declaration (YAML) | 8 agent files (`plan-draft-writer.md`, `plan-writer.md`, `plan-validator.md`, `cross-repo-coordinator.md`, `generic-discovery.md`, `code-reviewer.md`, `implementation-subagent.md`, `verification-subagent.md`) | `self-learning:learning-quality` |
| Hardcoded filesystem path | `code/scripts/install-dependencies.sh` (line 10) | `self-learning/tools/python/requirements.txt` |

### `code-review`

No outbound cross-plugin dependencies. The `code-review-worker` agent ships with this plugin (`code-review/agents/code-review-worker.md`) and is referenced as `code-review:code-review-worker` from `code-review/commands/start.md`.

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

1. **`code` is the hub** — depended on by `bootstrap`, while itself depending on `self-learning`.
2. **All dependencies are undeclared**: no `plugin.json` files specify a `dependencies` field.
