# Agent Patterns

Best practices and patterns for writing effective Claude Code agents.

## Agent Body Structure

Recommended structure for agent markdown files:

```markdown
---
name: agent-name
description: Clear description of what agent does and when to use it.
model: opus
tools: [Read, Grep, Glob, Bash]
---

# Agent Name

## Inputs
What the agent receives/expects from the caller.
- Required: task description
- Optional: file paths, constraints

## Outputs
What the agent produces when complete.
- Summary of findings
- File paths modified
- Structured data (if applicable)

## Method/Workflow
How the agent operates, step by step.
1. First, analyze the input
2. Then, perform the core task
3. Finally, format and return results

## Constraints
Limitations, restrictions, or things the agent should avoid.
- Do not modify files outside the specified directory
- Limit search to specific file types
- Report findings but don't auto-fix
```

## Frontmatter Reference

### Required Fields

| Field | Constraints |
|-------|-------------|
| `name` | Kebab-case, should match filename (e.g., `code-reviewer` for `code-reviewer.md`) |
| `description` | Clear statement of purpose and when to use |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | `sonnet`, `opus`, or `haiku` (subagents inherit parent if unset) |
| `color` | string | Visual identifier in UI (e.g., `blue`, `green`, `red`) |
| `tools` | array | YAML list of allowed tools for this agent |
| `hooks` | object | PreToolUse, PostToolUse, Stop hooks scoped to this agent |

### Full Frontmatter Example

```yaml
---
name: security-reviewer
description: Reviews code changes for security vulnerabilities, injection risks, and unsafe patterns.
model: opus
color: red
tools:
  - Read
  - Grep
  - Glob
  - Bash
hooks:
  PreToolUse:
    - matcher: "Write(*)"
      hooks:
        - type: command
          command: "./validate-no-write.sh"
  PostToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: "./log-agent-action.sh"
  Stop:
    - hooks:
        - type: command
          command: "./generate-security-report.sh"
---
```

## Agent Types

### Read-Only Agents

For analysis, review, or discovery tasks:

```yaml
---
name: code-analyzer
description: Analyzes codebase structure and patterns without making changes.
tools:
  - Read
  - Grep
  - Glob
---
```

**Best practices:**
- Explicitly limit tools to read-only operations
- Document that agent does not modify files
- Return structured findings for caller to act on

### Write-Enabled Agents

For implementation or modification tasks:

```yaml
---
name: refactoring-agent
description: Refactors code following specified patterns.
tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
---
```

**Best practices:**
- Use hooks to validate writes
- Document what files/directories agent may modify
- Include rollback guidance in constraints

### Specialized Agents

For domain-specific expertise:

```yaml
---
name: api-architect
description: Designs API endpoints following REST conventions and project patterns.
model: opus
tools:
  - Read
  - Grep
  - Glob
---
```

**Best practices:**
- Use `model: opus` for complex reasoning tasks
- Reference domain-specific knowledge in body
- Include examples of expected output format

## Disabling Agents

In `settings.json`, use `Task(AgentName)` syntax:

```json
{
  "disallowed-tools": [
    "Task(code-reviewer)",
    "Task(test-runner)"
  ]
}
```

Via CLI:

```bash
claude --tools "Read,Grep,Glob"  # Implicitly disables Task tool
```

## Agent Invocation

### Via Task Tool

Agents are invoked via the Task tool with `subagent_type`:

```markdown
Use the Task tool with subagent_type="agent-name" to delegate work.
```

### Background Execution

Run agents asynchronously:

```markdown
Use the Task tool with:
- subagent_type: "agent-name"
- run_in_background: true

Check results later with TaskOutput tool or by reading the output_file.
```

### Parallel Execution

Launch multiple agents simultaneously by including multiple Task tool calls in a single message.

## Writing Style

**CRITICAL:** Use imperative/infinitive form in agent definitions:

| ✅ Correct | ❌ Incorrect |
|-----------|-------------|
| "Analyze the codebase for..." | "You should analyze..." |
| "Return findings as..." | "You will return..." |
| "Search for patterns in..." | "You can search..." |

## Common Patterns

### Discovery Agent Pattern

```markdown
# File Discovery Agent

## Inputs
- Search criteria (file patterns, keywords)
- Scope (directories to search)

## Outputs
- List of matching files with relevance scores
- Summary of findings

## Method
1. Use Glob to find candidate files
2. Use Grep to filter by content
3. Read top candidates for context
4. Rank and summarize findings
```

### Review Agent Pattern

```markdown
# Code Review Agent

## Inputs
- Files to review (paths or diff)
- Review criteria (security, performance, style)

## Outputs
- Findings categorized by severity
- Specific line references
- Suggested fixes

## Method
1. Read all files in scope
2. Analyze against criteria
3. Categorize findings (Critical, High, Medium, Low)
4. Format report with actionable items
```

### Implementation Agent Pattern

```markdown
# Feature Implementation Agent

## Inputs
- Feature specification
- Target files/directories
- Constraints (style, patterns to follow)

## Outputs
- Modified/created files
- Summary of changes
- Test suggestions

## Method
1. Analyze existing code patterns
2. Plan implementation approach
3. Implement changes incrementally
4. Verify changes compile/lint
```
