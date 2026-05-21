# Configuration Reference

Detailed reference for Claude Code configuration: CLAUDE.md, rules, settings, CLI, and background agents.

## CLAUDE.md Format

**Locations:**
- Project: `CLAUDE.md` or `.claude/CLAUDE.md` in project root
- Personal: `~/.claude/CLAUDE.md` (user-only, applies to all projects)
- Child directories: `src/CLAUDE.md` (applies when working in that directory)

**Recommended Structure:**

```markdown
# Project Name

## Commands
- `npm run dev` - Start development server
- `npm test` - Run test suite
- `npm run build` - Production build

## Architecture
Brief overview of project structure and key directories.

## Conventions
Code style, naming patterns, and project-specific rules.

## Warnings
Critical things to avoid or watch out for.
```

**Best Practices:**
- Keep concise (always loaded into context on every message)
- Focus on non-obvious information Claude wouldn't know
- Include bash commands with descriptions
- Document project-specific quirks and gotchas
- Avoid duplicating information available in README or docs

**Loading Behavior:**
- All CLAUDE.md files in the path hierarchy are loaded
- Personal `~/.claude/CLAUDE.md` applies to all projects
- Child directory CLAUDE.md files add context when working in those directories

## Rules Directory

**Location:** `.claude/rules/`

An alternative to CLAUDE.md for organizing project-specific rules into separate files.

```
.claude/rules/
├── coding-standards.md
├── security-requirements.md
├── testing-patterns.md
└── deployment-notes.md
```

**Benefits over single CLAUDE.md:**
- Modular organization of rules by topic
- Easier to maintain large rule sets
- Can selectively enable/disable rules
- Better for team collaboration (separate PRs per rule file)
- Clearer ownership and review

**Note:** Rules in `.claude/rules/` are loaded alongside CLAUDE.md, not instead of it. Both can coexist.

## Settings

**Locations:**
- Project: `.claude/settings.json` (checked into repo, shared with team)
- Personal: `~/.claude/settings.json` (user-only)

**Full Settings Reference:**

```json
{
  "agent": "my-agent",
  "language": "japanese",
  "respectGitignore": true,
  "fileSuggestion": "glob",
  "attribution": true,
  "disallowed-tools": ["Task(code-reviewer)", "mcp__server__dangerous_tool"],
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "UserPromptSubmit": [...],
    "PermissionRequest": [...],
    "Stop": [...]
  }
}
```

**Settings Reference:**

| Setting | Type | Description |
|---------|------|-------------|
| `agent` | string | Use specific agent's system prompt, tools, and model for main thread |
| `language` | string | Configure Claude's response language (e.g., "japanese", "spanish") |
| `respectGitignore` | boolean | Per-project control over @ file picker behavior |
| `fileSuggestion` | string | Custom @ file search behavior ("glob", "fuzzy", etc.) |
| `attribution` | boolean | Include model name in commit/PR bylines |
| `disallowed-tools` | array | Tools to disable (see below) |
| `hooks` | object | Hook configurations (see hook-recipes.md) |

**Disabling Tools:**

The `disallowed-tools` array supports several patterns:

```json
{
  "disallowed-tools": [
    "Task(code-reviewer)",      // Disable specific agent
    "Task(test-runner)",        // Disable another agent
    "mcp__server__tool",        // Disable specific MCP tool
    "mcp__filesystem_*",        // Disable all tools from MCP server (wildcard)
    "Bash",                     // Disable built-in tool
    "Write"                     // Disable another built-in tool
  ]
}
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--agent <name>` | Override agent setting for this session |
| `--tools <list>` | Restrict built-in tools during interactive sessions |
| `--disable-slash-commands` | Disable all slash commands |
| `--session-id <id>` | Use custom session ID |
| `--system-prompt <text>` | Custom system prompt (works with `--continue`/`--resume`) |
| `--continue` | Continue most recent conversation |
| `--resume <session-id>` | Resume specific session |
| `--print` | Output response to stdout (non-interactive) |
| `--output-format <format>` | Output format: `text`, `json`, `stream-json` |
| `--verbose` | Enable verbose output |
| `--max-turns <n>` | Maximum conversation turns in non-interactive mode |

**Examples:**

```bash
# Use specific agent for session
claude --agent security-reviewer

# Restrict tools
claude --tools "Read,Grep,Glob"

# Continue last conversation with custom system prompt
claude --continue --system-prompt "Focus on security issues"

# Non-interactive with JSON output
echo "Analyze this code" | claude --print --output-format json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | Override file read token limit |
| `CLAUDE_CODE_SHELL` | Override shell used for Bash commands |
| `IS_DEMO` | Hide email and organization from UI |
| `ANTHROPIC_API_KEY` | API key for Anthropic (if not using default auth) |
| `CLAUDE_CODE_USE_BEDROCK` | Use AWS Bedrock instead of Anthropic API |
| `CLAUDE_CODE_USE_VERTEX` | Use Google Vertex AI instead of Anthropic API |

**Hook-Specific Environment Variables:**

| Variable | Available In | Description |
|----------|--------------|-------------|
| `CLAUDE_PROJECT_DIR` | All hooks | Absolute path to project root |
| `CLAUDE_CODE_REMOTE` | All hooks | `"true"` if web environment, empty for CLI |
| `CLAUDE_ENV_FILE` | SessionStart only | Path to file for persisting env vars |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin hooks | Plugin root directory |

**Persisting Environment Variables (SessionStart hooks):**

```bash
#!/bin/bash
# In a SessionStart hook script

if [ -n "$CLAUDE_ENV_FILE" ]; then
  # These will be available in all subsequent Bash commands
  echo 'export MY_VAR=value' >> "$CLAUDE_ENV_FILE"
  echo 'export PATH="/custom/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
```

## Background Agents

Agents can run in the background while work continues in the foreground.

### Launching Background Agents

Use `run_in_background: true` in Task tool calls:

```markdown
Use the Task tool with run_in_background: true to launch agents that run asynchronously.
The tool result will include an output_file path for checking progress.
```

### Controlling Background Tasks

| Action | Method |
|--------|--------|
| Background current task | `Ctrl+B` during execution |
| View running tasks | `/tasks` command |
| Get task output | `TaskOutput` tool with task ID |
| Kill background shell | `KillShell` tool with shell ID |

### Key Behaviors

- Background tasks truncate API context to 30K chars max
- Tasks notify when complete (terminal notification)
- Incremental output available for async agents via output file
- Token counts in spinner include background agent usage
- Background agents continue even if foreground conversation continues

### Example: Parallel Agent Execution

```markdown
Launch multiple agents in parallel by including multiple Task tool calls
in a single message, each with run_in_background: true.

To check results later:
1. Use /tasks to see task IDs
2. Use TaskOutput tool with the task ID to retrieve results
3. Or use Read tool on the output_file path returned when launching
```
