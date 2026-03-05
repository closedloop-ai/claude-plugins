---
name: plan-editing-conventions
description: Conventions for editing plan.json implementation plans including task format, structured arrays, and plan structure rules. Use when creating or modifying plan.json files.
---

# Plan Editing Conventions

Conventions for creating and modifying implementation plans stored as `plan.json`.

## Plan Structure Rules

- Keep prose concise and actionable; include concrete file paths (`relative/path.ts`)
- Never include time estimates. Use qualitative **Complexity** per task: S (≤ ~120 LOC), M (~120–300 LOC), L (> ~300 LOC)
- Do not hardcode colors or tokens; reference semantic tokens when citing UI work

## plan.json Format

The plan is stored as `plan.json` with these key fields:

```json
{
  "content": "# Implementation Plan\n\n## Stage 1: ...\n\n### T-1.1: Task Title\n...",
  "acceptanceCriteria": [...],
  "pendingTasks": [...],
  "completedTasks": [...],
  "manualTasks": [...],
  "openQuestions": [...],
  "answeredQuestions": [...],
  "gaps": [...],
  "amendments": [...]
}
```

- **`content`**: The full markdown plan as a JSON string with escaped newlines (`\n`). This is the human-readable plan text.
- **Structured arrays**: Mirror the plan content for programmatic access (pendingTasks, completedTasks, etc.)

## Editing plan.json Content Field

**CRITICAL**: The `content` field is a JSON string. When editing:
- Use `\n` escape sequences for newlines, NOT literal line breaks
- Ensure proper JSON escaping of quotes and special characters
- After editing, always sync `plan.md` via the `code:extract-plan-md` skill

## Task Format

Tasks use the `T-X.Y` ID convention where X is the stage number and Y is the task number within that stage.

Each task in the plan content should follow this structure:

```markdown
### T-X.Y: [Task Title]

**Files:** `path/to/file.ext`
**Complexity:** S | M | L
**AC Refs:** AC-001, AC-002

**Description:** Brief description of what this task accomplishes.

**Implementation Details:**

[Include one or more of the following as appropriate:]

**Mapping Table:** (for distribution/transformation tasks)
| Source | Target | Notes |
|--------|--------|-------|
| category_a | target_file_a.md | Section: XYZ |
| category_b | target_file_b.md | Section: ABC |

**Algorithm:** (for logic-heavy tasks)
1. Load input from `source_path`
2. Parse using `specific_method()`
3. For each item:
   a. Transform using pattern X
   b. Validate against schema Y
4. Write output to `target_path`

**Code Template:** (for new file creation)
```python
# Actual code structure to be created
from typing import TypedDict

class ConfigType(TypedDict):
    field_a: str
    field_b: int

def main_function(config: ConfigType) -> Result:
    """Docstring explaining purpose."""
    pass
```

**Before/After Example:** (for modification tasks)
```python
# BEFORE (current code)
def old_approach():
    pass

# AFTER (with changes)
def new_approach():
    # Added: explanation of change
    pass
```
```

## Structured Array Format

### pendingTasks / completedTasks

```json
{
  "id": "T-1.1",
  "description": "Task description",
  "acceptanceCriteria": ["AC-001", "AC-002"]
}
```

### amendments

```json
{
  "timestamp": "2024-01-01T00:00:00",
  "changes": ["Description of change 1", "Description of change 2"],
  "conversation": [...]
}
```

## Implementation Details Guidance

Extract implementation details for tasks that involve:
- Pattern extraction from existing code (algorithms, templates, mappings)
- Creating new files based on existing patterns
- Distributing/transforming content across multiple targets
- Complex logic that benefits from step-by-step documentation

**Detail extraction checklist:**
- [ ] Every task with Complexity M or L has implementation details
- [ ] Tasks referencing source files include extracted content
- [ ] Mapping/distribution tasks have explicit tables
- [ ] Algorithm tasks have step-by-step logic
- [ ] New file tasks have templates showing structure
- [ ] Code snippets use correct syntax highlighting

**Skip detail extraction for:**
- Simple file moves or renames (Complexity S, obvious path)
- Documentation-only tasks with no code
- Tasks that are pure analysis with no deliverable

## Editing Existing Plans

When amending an existing plan:

1. **Edit plan.json** - Update the `content` field and structured arrays as needed
2. **Keep arrays in sync** - If a task moves from pending to completed, update both `pendingTasks` and `completedTasks` arrays
3. **Preserve existing structure** - Don't reorganize unless necessary
4. **Update affected sections only** - Minimize changes to unaffected tasks
5. **Keep complexity accurate** - Reassess if scope changes significantly
6. **Sync plan.md** - Always regenerate `plan.md` via `code:extract-plan-md` after edits
