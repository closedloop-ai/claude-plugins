---
name: learning-quality
description: Structured format for capturing high-quality learnings during ClosedLoop runs
---

# Learning Quality Skill

This skill defines when and how to capture learnings during ClosedLoop runs.

## Decision Tree: Should I Capture This?

Before writing a learning, run through this decision tree in order:

```
1. Did I make a mistake and correct it, or discover something non-obvious?
   NO  → Don't capture (no learnings event)
   YES → Continue

2. Is it a config value? (specific URL, file path, project command, type name)
   YES → Write to CLAUDE.md (project scope), not org-patterns
   NO  → Continue

3. Is it tied to a single feature/bug with no generalizable principle?
   YES → SKIP
   NO  → Continue

4. Will it still be true in 6 months?
   NO  → SKIP (or generalize the principle)
   YES → Continue

5. Does it already exist in org-patterns.toon or CLAUDE.md?
   YES → SKIP (or note "Supersedes: [old pattern]" if correcting)
   NO  → CAPTURE IT
```

**Note:** Even "basic" knowledge is worth capturing if you actually made that mistake. These learnings exist because LLM agents struggle with certain patterns that humans might consider obvious. The goal is to help future agent runs avoid the same mistakes.

## Hard Rejection Criteria

**SKIP if ANY of these apply:**

| Criterion | Example | Why |
|-----------|---------|-----|
| Specific URL/path/config | "Use https://github.com/org/repo" | Config, not principle → CLAUDE.md |
| Project-specific names | "Use MyProjectType not OtherType" | Belongs in CLAUDE.md |
| One-off bug fix | "Field X was null in row 123" | Not reusable |
| Already captured | (check pending/, CLAUDE.md, org-patterns.toon) | Avoid duplicates |

**Note:** Even patterns that seem like "basic knowledge" are worth capturing if you actually made that mistake. These learnings exist because LLM agents struggle with certain patterns. The goal is to help future agent runs avoid the same mistakes.

## Capture Workflow

When you have a learning worth capturing:

### Step 1: Classify Scope

| Scope | Destination | Heuristic |
|-------|-------------|-----------|
| **Project** | CLAUDE.md | Mentions specific file paths, package names, or project-unique features |
| **Global** | org-patterns.toon | Applies to any project using the same language/framework/tool |

### Step 2: Generalize if Needed

Extract the underlying principle, not the specific instance.

<examples>
<example type="generalize">
<specific>GitHubActionStatus uses SUCCESS not COMPLETED</specific>
<generalized>When using Prisma enums, verify valid values in schema.prisma - don't assume names</generalized>
</example>

<example type="generalize">
<specific>adm-zip is already installed for webhooks</specific>
<generalized>Check existing dependencies before adding new packages for common functionality</generalized>
</example>

<example type="skip">
<specific>The workstream query checks parentId before title</specific>
<reason>Implementation detail with no generalizable principle</reason>
</example>

<example type="skip">
<specific>ARTIFACT_SECTIONS has ISSUE in two places</specific>
<reason>Specific bug, not a pattern</reason>
</example>
</examples>

**Test:** Would this help someone working on a *different* feature?

### Step 3: Write the Pattern

**Formula:** `[When/Where] + [specific action] + [context]`

<examples>
<example type="good" domain="planning">
PRD 'secure authentication' in this org means Auth0 + JWT + httpOnly refresh cookies
</example>

<example type="good" domain="implementation">
Always check for None before accessing .items() on optional dicts in FastAPI handlers
</example>

<example type="good" domain="testing">
E2E tests require API mocks via msw in tests/mocks/, never hit real endpoints
</example>

<example type="good" domain="verification">
Task 'add endpoint' is only VERIFIED if both route AND handler exist, not just route file
</example>

<example type="bad" reason="too vague">
Check for None
<fix>Missing: where? when? why?</fix>
</example>

<example type="bad" reason="not actionable">
Be careful with imports
</example>

<example type="bad" reason="common knowledge">
TypeScript catch blocks have type unknown in strict mode
<fix>Documented in TS handbook - skip</fix>
</example>

<example type="bad" reason="config not pattern">
Run `pnpm test` for validation
<fix>Project config → write to CLAUDE.md instead</fix>
</example>

<example type="bad" reason="too specific">
Templates should have type matching templateForType, not type: TEMPLATE
<fix>Feature-specific decision that may change - skip or generalize</fix>
</example>
</examples>

### Step 4: Check for Conflicts

Before writing:
1. Check `$CLOSEDLOOP_WORKDIR/.learnings/pending/` for learnings in this run
2. Check project CLAUDE.md "Learned Patterns" section
3. Check `~/.closedloop-ai/learnings/org-patterns.toon`

**If contradiction exists** (existing says "do X", new says "don't do X"):
- Verify which is correct based on evidence
- Capture only the correct one
- Add "Supersedes: [old pattern]" if correcting

### Step 5: Write the File

**Output location:**
```
$CLOSEDLOOP_WORKDIR/.learnings/pending/{agent-name}-$CLOSEDLOOP_AGENT_ID.json
```

**Format:**
```json
{
  "what_happened": "Brief description of what occurred",
  "why": "Root cause or reason this matters",
  "fix_applied": "What you did to resolve it (if applicable)",
  "pattern_to_remember": "The actionable takeaway (minimum 20 chars)",
  "applies_to": ["agent-name"],
  "context": {
    "file": "relative/path/to/file.ext",
    "line": 42,
    "function": "function_name"
  }
}
```

Use `["*"]` for `applies_to` if the pattern applies to all agents.

## No Learnings Event

If you completed work without learnings to capture:

```json
{
  "no_learnings": true,
  "reason": "Task was straightforward with no new patterns discovered"
}
```

This is valid—not every task produces learnings.

## Quick Reference

### Worth Capturing (Durable + Non-Obvious)

- Non-obvious tool behaviors not in docs
- Project conventions not inferable from code
- Architectural decisions with non-obvious rationale
- Gotchas that cost time and aren't documented

### Not Worth Capturing

| Category | Examples |
|----------|----------|
| Common knowledge | TS strict mode, git basics, debugging 101 |
| Config values | URLs, file paths, project commands |
| Implementation details | Query order, field names, styling choices |
| Temporary | Bug workarounds, feature-specific decisions |

### Scope Decision

```
Mentions specific paths/packages/features? → Project (CLAUDE.md)
Applies to any project with same tech?     → Global (org-patterns.toon)
```

## Domain-Specific Guidance

Your agent definition may reference a domain-specific learning prompt (e.g., `prompts/plan-writer-learning.md`). If so, read it before capturing learnings.
