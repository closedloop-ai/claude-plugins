# Slash Command Patterns

Best practices and patterns for writing effective Claude Code slash commands.

## Command Anatomy

### Basic Command

```markdown
---
description: Brief description shown in autocomplete
---

Your command prompt text here.
```

### Command with Full Frontmatter

```yaml
---
description: What this command does
argument-hint: [file] [options]
model: opus
allowed-tools: Bash(git *), Read, Grep
disable-model-invocation: false
hooks:
  PreToolUse:
    - matcher: "Bash(git push *)"
      hooks:
        - type: command
          command: "./validate-push.sh"
  Stop:
    - hooks:
        - type: command
          command: "./cleanup.sh"
---

Command prompt and instructions...
```

### Frontmatter Fields Reference

| Field | Purpose | Default |
|-------|---------|---------|
| `description` | Brief description for autocomplete | First line of prompt |
| `argument-hint` | Expected arguments shown in picker | None |
| `model` | Override model for this command | Inherits |
| `allowed-tools` | Tool restrictions | Inherits |
| `disable-model-invocation` | Prevent Skill tool from calling | false |
| `hooks` | PreToolUse, PostToolUse, Stop handlers | None |

### Special Syntax

| Syntax | Purpose | Example |
|--------|---------|---------|
| `$ARGUMENTS` | All arguments | `Review: $ARGUMENTS` |
| `$1`, `$2`, etc. | Positional args | `File: $1, Mode: $2` |
| `!` + backtick-command | Inline bash execution | `Status: ` + `!` + backtick-git status |
| `@path/file` | Include file contents | `@src/config.ts` |

**CRITICAL for Inline Bash:** You MUST include `allowed-tools` with Bash permissions:

```yaml
---
allowed-tools: Bash(git status:*), Bash(git diff:*)
---

Current status: !&#96;git status&#96;
```

Without `allowed-tools` specifying Bash, inline bash commands will not execute.

## Pattern 1: TodoWrite for Multi-Step Commands

Commands with 3+ steps MUST use TodoWrite for progress tracking.

### Bad Example

```markdown
Review the PR and provide feedback.

## Instructions

1. Fetch the PR details
2. Read all changed files
3. Analyze for issues
4. Write review comments
```

**Problem:** No visibility into progress; user doesn't know what's happening.

### Good Example

```markdown
Review the PR and provide feedback.

## Instructions

Use TodoWrite to create a task list before starting:

1. Fetch PR details from GitHub
2. Read all changed files
3. Analyze code for issues (security, performance, style)
4. Write review summary with findings

Mark each task as in_progress before starting, and completed when done.
Provide the review summary to the user when all tasks are complete.
```

## Pattern 2: Argument Handling

### Check for Required Arguments

```markdown
Deploy to the specified environment.

## Instructions

First, check if $ARGUMENTS is provided:
- If empty, ask user: "Which environment? (staging, production)"
- If provided, validate it's one of: staging, production

Proceed with deployment only after validation.
```

### Parse Multiple Arguments

```markdown
Create a new component with the given name and type.

## Instructions

Parse $ARGUMENTS expecting: <component-name> [component-type]

- First argument: Component name (required)
- Second argument: Component type (optional, default: "functional")

If component name is missing, ask user to provide it.
```

## Pattern 3: Validation Before Action

### Pre-Flight Checks

```markdown
Push changes to the remote repository.

## Instructions

Before pushing, perform these checks:

1. Run `git status` to verify clean working tree
2. Run tests to ensure they pass
3. Check current branch is not main/master

If any check fails:
- Report the issue to user
- Ask if they want to proceed anyway
- Only continue with explicit confirmation

If all checks pass, proceed with push.
```

## Pattern 4: Explicit Output Declaration

### Specify What Gets Created

```markdown
Generate a changelog from recent commits.

## Instructions

This command produces:
- A CHANGELOG.md update (or creates if missing)
- A summary message to the user

Steps:
1. Read git log since last tag
2. Categorize commits (features, fixes, docs)
3. Update CHANGELOG.md with new section
4. Show user the changes made
```

## Pattern 5: Focused Single-Purpose Commands

### Bad: Kitchen Sink Command

```markdown
Handle all git operations.

## Instructions

Based on $ARGUMENTS:
- If "commit": stage and commit
- If "push": push to remote
- If "pr": create pull request
- If "sync": pull and rebase
...
```

**Problem:** Too broad; better as separate commands.

### Good: Focused Commands

Create separate commands:
- `/commit` - Stage and commit changes
- `/push` - Push to remote with checks
- `/pr` - Create pull request
- `/sync` - Pull and rebase

Each command does one thing well.

## Pattern 6: Error Recovery

### Graceful Failure Handling

```markdown
Run the test suite and report results.

## Instructions

Run tests with: npm test

If tests fail:
1. Parse the error output
2. Identify which tests failed
3. Read the failing test files
4. Provide actionable suggestions

If tests pass:
1. Report success with summary
2. Show coverage if available

Never leave the user without feedback.
```

## Pattern 7: Hooks for Guardrails

### Using Frontmatter Hooks

```yaml
---
hooks:
  PreToolUse:
    - matcher: "Bash(rm -rf *)"
      hooks:
        - type: command
          command: "echo 'Blocked: destructive command' && exit 1"
    - matcher: "Bash(git push --force *)"
      hooks:
        - type: command
          command: "./confirm-force-push.sh"
---

Manage repository cleanup tasks.

## Instructions

...
```

## Pattern 8: Composable Commands

### Design for Composition

```markdown
Run pre-commit checks.

## Instructions

Execute the standard pre-commit workflow:

1. Run linter: `npm run lint`
2. Run type check: `npm run typecheck`
3. Run tests: `npm test`

Report results for each step.

This command is designed to be run before `/commit`.
```

Users can then chain: "Run /pre-commit then /commit"

## Anti-Patterns to Avoid

### 1. Silent Commands

**Bad:** Command runs without any user feedback.

**Fix:** Always provide status updates and final summary.

### 2. Unbounded Loops

**Bad:** "Keep trying until it works"

**Fix:** Set explicit retry limits and report after max attempts.

### 3. Assuming Context

**Bad:** "Continue from where we left off"

**Fix:** Commands should be self-contained; read necessary state explicitly.

### 4. Hardcoded Paths

**Bad:** `Read /Users/john/project/config.json`

**Fix:** Use `$PWD` or relative paths: `Read $PWD/config.json`

### 5. Missing TodoWrite

**Bad:** Multi-step command without progress tracking.

**Fix:** Always use TodoWrite for commands with 3+ distinct steps.

## Command vs Skill vs Agent Decision Tree

```
What kind of capability do you need?
│
├── Quick, frequently used prompt?
│   └── COMMAND (single .md file, explicit /invocation)
│
├── Complex capability with scripts/multiple files?
│   └── SKILL (directory with skill.md + resources, auto-triggers)
│
└── Specialized AI subprocess for delegation?
    └── AGENT (Task tool invocation, parallel execution)
```

### Official Guidance

**Use Commands for:**
- Quick, frequently used prompts
- Simple prompt snippets
- Frequently used instructions fitting in one file

**Use Skills for:**
- Complex workflows with multiple steps
- Capabilities requiring scripts or utilities
- Knowledge organized across multiple files
- Team workflows you want to standardize

**Use Agents for:**
- Specialized AI subagents for complex tasks
- Automatic delegation patterns
- Parallel execution of independent work

### Examples

| Task | Type | Reason |
|------|------|--------|
| "Review this PR" | Command | Quick prompt, explicit invocation |
| "Python best practices" | Skill | Auto-loads based on .py file context |
| "Run security scan" | Agent | Subprocess via Task tool |
| "Commit changes" | Command | Simple workflow, user-triggered |
| "Database schema knowledge" | Skill | Reference docs loaded as needed |
| "Parallel file analysis" | Agent | Multiple subprocesses |
