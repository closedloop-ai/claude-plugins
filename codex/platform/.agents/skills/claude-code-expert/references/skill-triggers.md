# Skill Trigger Optimization

Guide to writing effective skill descriptions that trigger reliably.

## How Skill Triggering Works

Claude Code skills are **model-invoked**, meaning Claude autonomously decides when to use them based on:

1. The skill's `description` field in frontmatter
2. The current conversation context
3. The user's request

The description is the PRIMARY factor in trigger decisions.

## Description Anatomy

A complete description includes:

```
This skill should be used when [TRIGGERS].
It provides [CAPABILITIES].
Use when [CONTEXT CONDITIONS] or when the user mentions [KEYWORDS].
```

### Components

1. **TRIGGERS**: Specific conditions that should activate the skill
2. **CAPABILITIES**: What the skill provides when activated
3. **CONTEXT CONDITIONS**: Situational triggers
4. **KEYWORDS**: Explicit words/phrases that should trigger

## Examples: Good vs Bad Descriptions

### Example 1: Document Processing

**Bad (vague):**
```yaml
description: Helps with documents
```

**Good (specific):**
```yaml
description: This skill should be used when working with PDF files including text extraction, form filling, table parsing, or document merging. Triggers on mentions of PDFs, forms, document extraction, or when the user asks to read/modify PDF content.
```

### Example 2: Database Queries

**Bad (incomplete):**
```yaml
description: Database helper skill
```

**Good (comprehensive):**
```yaml
description: This skill should be used when constructing SQL queries or working with the application database. It provides schema information, query patterns, and optimization guidance. Use when the user mentions database, SQL, queries, tables, or needs to fetch/update data.
```

### Example 3: Code Review

**Bad (generic):**
```yaml
description: Reviews code for issues
```

**Good (targeted):**
```yaml
description: This skill should be used when reviewing Python code for async patterns, type safety, and best practices. Triggers when reviewing .py files, discussing Python patterns, or when the user asks about async/await or type hints.
```

## Trigger Patterns

### Pattern 1: WHEN + WHEN NOT

Explicitly define boundaries:

```yaml
description: >
  This skill should be used when creating or modifying Claude Code
  agents, skills, or slash commands.

  Use when: working with .claude/ directory files, writing agent
  definitions, creating skills, or configuring hooks.

  Do NOT use when: writing application code, general development,
  or CI/CD configuration unrelated to Claude Code.
```

### Pattern 2: Keyword Enumeration

List explicit trigger keywords:

```yaml
description: >
  This skill should be used for React Native mobile development.
  Triggers on mentions of: React Native, Expo, mobile app, iOS,
  Android, Metro bundler, native modules, or mobile-specific
  patterns like navigation, gestures, or device APIs.
```

### Pattern 3: File Pattern Triggers

Trigger based on file types:

```yaml
description: >
  This skill should be used when working with test files.
  Triggers when: reading/writing *.spec.ts or *.test.ts files,
  discussing testing patterns, or setting up test infrastructure.
```

## Common Trigger Failures

### Failure 1: Too Generic

**Problem:** Description doesn't distinguish from other skills.

**Symptom:** Wrong skill triggers, or skill never triggers.

**Fix:** Add specific keywords and context conditions.

### Failure 2: Too Narrow

**Problem:** Description only covers one use case.

**Symptom:** Skill only triggers for exact phrasing.

**Fix:** Add synonyms and alternative phrasings.

### Failure 3: Missing Negations

**Problem:** No "when NOT to use" guidance.

**Symptom:** Skill triggers inappropriately.

**Fix:** Add explicit exclusion conditions.

### Failure 4: Conflicting Skills

**Problem:** Multiple skills have overlapping triggers.

**Symptom:** Wrong skill chosen, or unpredictable behavior.

**Fix:** Make descriptions mutually exclusive with clear boundaries.

## Testing Triggers

### Manual Testing

Test with various phrasings:

1. Direct mention: "Help me create a skill"
2. Indirect reference: "I need to extend Claude Code"
3. Keyword trigger: "Working with .claude/agents"
4. Context trigger: After discussing related topic

### Trigger Debugging

If skill doesn't trigger:

1. Check description is under 1024 characters
2. Verify frontmatter YAML is valid
3. Test with explicit skill mention
4. Review for conflicting skills
5. Add more trigger keywords

## Description Length Guidelines

- **Minimum:** 50 characters (too short = vague)
- **Optimal:** 200-500 characters (clear and specific)
- **Maximum:** 1024 characters (hard limit)

## Skill Hierarchy

When multiple skills could apply:

1. **Personal skills** (`~/.claude/skills/`) take precedence
2. **Project skills** (`.claude/skills/`) are next
3. **Plugin skills** load based on plugin order

Use this hierarchy intentionally—personal skills can override project defaults.

## Skill Body Structure

Recommended structure for skill markdown files:

```markdown
---
name: skill-name
description: This skill should be used when [triggers]. It provides [capabilities].
---

# Skill Name

## Overview
Brief explanation of what the skill provides and why it exists.

## When to Use
Specific conditions that trigger this skill.
- Working with X type of files
- User mentions Y keywords
- Context involves Z patterns

## When NOT to Use
Conditions where this skill is inappropriate.
- General coding unrelated to X
- Tasks better handled by Y skill

## Workflow
Step-by-step guidance for using the skill's capabilities.

## Resources (optional)
- `references/guide.md` - Detailed documentation
- `scripts/helper.py` - Utility script
```

## Frontmatter Reference

### Required Fields

| Field | Constraints |
|-------|-------------|
| `name` | Lowercase, hyphens only, max 64 characters |
| `description` | Max 1024 characters, must include trigger conditions |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `allowed-tools` | string/array | Comma-separated string or YAML list of allowed tools |
| `context` | string | `fork` runs skill in forked sub-agent context |
| `agent` | string | Use specific agent's system prompt, tools, and model |
| `hooks` | object | PreToolUse, PostToolUse, Stop hooks scoped to this skill |

### Full Frontmatter Example

```yaml
---
name: python-patterns
description: This skill should be used when working with Python code including type hints, async patterns, and best practices. Triggers on .py files, Python discussions, or type safety questions.
allowed-tools:
  - Read
  - Grep
  - Glob
hooks:
  PostToolUse:
    - matcher: "Write(*.py)"
      hooks:
        - type: command
          command: "./format-python.sh"
      once: true
---
```
