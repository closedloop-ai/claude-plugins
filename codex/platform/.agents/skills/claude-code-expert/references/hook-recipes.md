# Hook Recipes

Common hook configurations for Claude Code workflows.

## Complete Hook Reference

### Hook Configuration Structure

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "bash-command",
            "timeout": 60,
            "once": true
          }
        ]
      }
    ]
  }
}
```

### Hook Types

**Command hooks** (`type: "command"`):
Execute bash commands with JSON input on stdin.

**Prompt hooks** (`type: "prompt"`):
Send hook input to Haiku LLM for context-aware decisions. Supported for: `Stop`, `SubagentStop`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`.

```json
{
  "type": "prompt",
  "prompt": "Evaluate if Claude should stop: $ARGUMENTS. Check if all tasks are complete.",
  "timeout": 30
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `matcher` | string | `""` | Pattern to match tool calls (see Matcher Syntax) |
| `type` | string | `"command"` | `"command"` or `"prompt"` |
| `command` | string | - | Shell command to execute |
| `prompt` | string | - | LLM prompt (for `type: "prompt"`) |
| `timeout` | number | 60 | Seconds before timeout (30 for prompt hooks) |
| `once` | boolean | false | Run only once per session (skills/commands only) |

### Matcher Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| Simple string | Exact match (case-sensitive) | `Write` |
| Regex | Regular expression | `Edit\|Write` or `Notebook.*` |
| Wildcard | `*` at any position | `Bash(npm *)`, `Bash(* install)` |
| MCP tools | Match MCP server tools | `mcp__filesystem_*` |
| Empty/omit | Required for some hooks | UserPromptSubmit, Stop, SessionStart |

### Environment Variables

| Variable | Available In | Description |
|----------|--------------|-------------|
| `CLAUDE_PROJECT_DIR` | All hooks | Absolute path to project root |
| `CLAUDE_CODE_REMOTE` | All hooks | `"true"` if web environment, empty for CLI |
| `CLAUDE_ENV_FILE` | SessionStart only | Path to persist env vars for session |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin hooks | Plugin root directory |

### Exit Codes

| Code | Behavior |
|------|----------|
| `0` | Success - JSON in stdout parsed for control; plain text shown in verbose mode |
| `2` | Blocking error - only stderr used as message; blocks processing |
| Other | Non-blocking - stderr shown in verbose mode; execution continues |

---

## Hook Input/Output Schemas

### PreToolUse

**Input (stdin):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/project/dir",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "npm test"},
  "tool_use_id": "toolu_123"
}
```

**Output (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "Explanation",
    "updatedInput": {"command": "npm test --coverage"}
  },
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Additional context for Claude"
}
```

### PostToolUse

**Input (stdin):**
```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {"file_path": "/path/to/file.py", "content": "..."},
  "tool_response": {"success": true},
  "tool_use_id": "toolu_456"
}
```

**Output (stdout):**
```json
{
  "decision": "block",
  "reason": "Reason to block and re-prompt",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Context added to conversation"
  }
}
```

### PermissionRequest

**Input (stdin):**
```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf node_modules"}
}
```

**Output (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow|deny",
      "updatedInput": {"command": "rm -rf node_modules"},
      "message": "Reason for denial",
      "interrupt": false
    }
  }
}
```

### UserPromptSubmit

**Input (stdin):**
```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "User's message text"
}
```

**Output (stdout):**
```json
{
  "decision": "block",
  "reason": "Reason to block submission",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Context injected into conversation"
  }
}
```

Note: Plain stdout (non-JSON) with exit 0 is added as context.

### Stop / SubagentStop

**Input (stdin):**
```json
{
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "transcript_path": "/path/to/transcript.jsonl"
}
```

**Output (stdout) - Block and continue:**
```json
{
  "decision": "block",
  "reason": "Prompt text for next iteration",
  "systemMessage": "Additional feedback/instructions"
}
```

**Output (stdout) - Allow stop:**
```json
{}
```

### SessionStart

**Input (stdin):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "hook_event_name": "SessionStart",
  "source": "startup|resume|clear|compact"
}
```

**Output (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context for session"
  }
}
```

**Persisting environment variables:**
```bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export MY_VAR=value' >> "$CLAUDE_ENV_FILE"
fi
```

### SessionEnd

**Input (stdin):**
```json
{
  "hook_event_name": "SessionEnd",
  "reason": "clear|logout|prompt_input_exit|other"
}
```

### Notification

**Input (stdin):**
```json
{
  "hook_event_name": "Notification",
  "message": "Notification text",
  "notification_type": "permission_prompt|idle_prompt|auth_success|elicitation_dialog"
}
```

### PreCompact

**Input (stdin):**
```json
{
  "hook_event_name": "PreCompact",
  "trigger": "manual|auto",
  "custom_instructions": "User's compact instructions"
}
```

---

## Prompt Hook Response Schema

For `type: "prompt"` hooks, the LLM response should be:

```json
{
  "ok": true,
  "reason": "Explanation (required when ok is false)"
}
```

Use `$ARGUMENTS` in the prompt to inject the hook input JSON.

---

## Hook Basics

Hooks can be configured in two places:

**1. settings.json** (global or project-level):
```json
{
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "UserPromptSubmit": [...],
    "PermissionRequest": [...],
    "Stop": [...]
  }
}
```

**2. Frontmatter** (per-agent, per-skill, or per-command):
```yaml
---
name: my-skill
hooks:
  PreToolUse:
    - matcher: "Bash(*)"
      hooks:
        - type: command
          command: "./validate.sh"
  Stop:
    - hooks:
        - type: command
          command: "./cleanup.sh"
---
```

### Hook Types

| Hook | Timing | Use Case |
|------|--------|----------|
| `PreToolUse` | Before tool runs | Validation, blocking, input modification |
| `PostToolUse` | After tool completes | Logging, formatting, notifications |
| `UserPromptSubmit` | When user sends message | Input validation, context injection |
| `PermissionRequest` | When permission requested | Auto-approve/deny tools |
| `Stop` | When agent/session stops | Cleanup, finalization |

### Hook Configuration Options

```json
{
  "matcher": "Bash(*)",
  "command": "./script.sh",
  "once": true
}
```

| Option | Type | Description |
|--------|------|-------------|
| `matcher` | string | Pattern to match tool calls (optional for some hooks) |
| `command` | string | Shell command to execute |
| `once` | boolean | Execute only once per session (default: false) |

### Matcher Syntax

```
ToolName(pattern)
```

**Basic patterns:**
- `Bash(git commit:*)` - Git commit commands
- `Write(*.py)` - Python file writes
- `Edit(src/**/*.ts)` - TypeScript edits in src/
- `*` - All operations

**Wildcard patterns (new):**
- `Bash(npm *)` - All npm commands
- `Bash(* install)` - Commands ending with "install"
- `Bash(git * main)` - Git commands involving "main"
- `mcp__server_*` - All tools from an MCP server

## Recipe 1: Pre-Commit Test Gate

Block commits unless tests pass.

### Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git commit:*)",
        "command": ".claude/hooks/pre-commit-check.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/pre-commit-check.sh

# Check if tests have passed recently
if [ ! -f /tmp/agent-pre-commit-pass ]; then
    echo "ERROR: Tests must pass before committing."
    echo "Run 'just test' first, then try again."
    exit 1
fi

# Check if pass file is recent (within 5 minutes)
if [ $(find /tmp/agent-pre-commit-pass -mmin +5 2>/dev/null) ]; then
    echo "ERROR: Test results expired. Run tests again."
    rm -f /tmp/agent-pre-commit-pass
    exit 1
fi

echo "✓ Pre-commit checks passed"
exit 0
```

### Test Script Integration

```bash
#!/bin/bash
# Run after successful tests
touch /tmp/agent-pre-commit-pass
echo "Tests passed - commit unlocked"
```

## Recipe 2: File Write Logging

Log all file modifications for audit.

### Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write(*)",
        "command": ".claude/hooks/log-write.sh"
      },
      {
        "matcher": "Edit(*)",
        "command": ".claude/hooks/log-edit.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/log-write.sh

LOG_FILE=".claude/audit/file-changes.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "[$(date -Iseconds)] WRITE: $TOOL_INPUT" >> "$LOG_FILE"
exit 0
```

## Recipe 3: Prompt Validation

Validate user prompts before processing.

### Configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": ".claude/hooks/validate-prompt.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/validate-prompt.sh

# Block potentially dangerous patterns
PROMPT="$USER_PROMPT"

# Check for credential exposure
if echo "$PROMPT" | grep -qiE "(password|secret|api.?key|token).*=.*['\"]"; then
    echo "WARNING: Prompt may contain credentials. Please remove sensitive data."
    exit 1
fi

# Check for production database references
if echo "$PROMPT" | grep -qiE "prod(uction)?.*database|db.*prod"; then
    echo "WARNING: Production database reference detected. Please confirm this is intentional."
    # Could prompt for confirmation here
fi

exit 0
```

## Recipe 4: Auto-Format on Write

Format files automatically after writing.

### Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write(*.py)",
        "command": ".claude/hooks/format-python.sh"
      },
      {
        "matcher": "Write(*.ts)",
        "command": ".claude/hooks/format-typescript.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/format-python.sh

FILE_PATH="$TOOL_INPUT"

if [ -f "$FILE_PATH" ]; then
    # Run formatter (ruff, black, etc.)
    ruff format "$FILE_PATH" 2>/dev/null || true
    echo "✓ Formatted: $FILE_PATH"
fi

exit 0
```

## Recipe 5: Branch Protection

Prevent direct commits to protected branches.

### Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git push:*)",
        "command": ".claude/hooks/branch-protection.sh"
      },
      {
        "matcher": "Bash(git commit:*)",
        "command": ".claude/hooks/branch-protection.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/branch-protection.sh

PROTECTED_BRANCHES="main master production"
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

for branch in $PROTECTED_BRANCHES; do
    if [ "$CURRENT_BRANCH" = "$branch" ]; then
        echo "ERROR: Direct commits to '$branch' are blocked."
        echo "Create a feature branch first: git checkout -b feature/your-feature"
        exit 1
    fi
done

exit 0
```

## Recipe 6: Context Injection

Add context to every prompt automatically.

### Configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": ".claude/hooks/inject-context.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/inject-context.sh

# Output additional context that will be appended to the prompt
cat << 'EOF'

<injected-context>
Current branch: $(git branch --show-current 2>/dev/null || echo "unknown")
Last commit: $(git log -1 --oneline 2>/dev/null || echo "none")
</injected-context>
EOF

exit 0
```

## Recipe 7: Rate Limiting

Prevent too many operations in short time.

### Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(curl:*)",
        "command": ".claude/hooks/rate-limit.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/rate-limit.sh

LIMIT_FILE="/tmp/claude-rate-limit"
MAX_CALLS=10
WINDOW_SECONDS=60

# Create/read counter file
if [ ! -f "$LIMIT_FILE" ]; then
    echo "0 $(date +%s)" > "$LIMIT_FILE"
fi

read COUNT TIMESTAMP < "$LIMIT_FILE"
NOW=$(date +%s)
ELAPSED=$((NOW - TIMESTAMP))

# Reset counter if window expired
if [ $ELAPSED -gt $WINDOW_SECONDS ]; then
    COUNT=0
    TIMESTAMP=$NOW
fi

# Check limit
if [ $COUNT -ge $MAX_CALLS ]; then
    echo "ERROR: Rate limit exceeded ($MAX_CALLS calls per $WINDOW_SECONDS seconds)"
    exit 1
fi

# Update counter
echo "$((COUNT + 1)) $TIMESTAMP" > "$LIMIT_FILE"
exit 0
```

## Recipe 8: Notification on Completion

Send notification when long task completes.

### Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash(just test:*)",
        "command": ".claude/hooks/notify-completion.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/notify-completion.sh

# macOS notification
if command -v osascript &> /dev/null; then
    osascript -e 'display notification "Task completed" with title "Claude Code"'
fi

# Linux notification
if command -v notify-send &> /dev/null; then
    notify-send "Claude Code" "Task completed"
fi

exit 0
```

## Debugging Hooks

### Enable Debug Logging

```bash
#!/bin/bash
# Add to any hook script

LOG_FILE=".claude/hook-debug.log"
echo "[$(date -Iseconds)] Hook: $0" >> "$LOG_FILE"
echo "  TOOL_INPUT: $TOOL_INPUT" >> "$LOG_FILE"
echo "  USER_PROMPT: ${USER_PROMPT:0:100}..." >> "$LOG_FILE"
```

### Common Issues

1. **Hook not executing**: Check file is executable (`chmod +x`)
2. **Hook blocking silently**: Add echo statements for feedback
3. **Hook timeout**: Hooks have default 30s timeout
4. **Environment variables**: Not all env vars available in hooks

### Testing Hooks

Test hooks manually before deployment:

```bash
# Simulate tool input
export TOOL_INPUT="path/to/file.py"
.claude/hooks/your-hook.sh
echo "Exit code: $?"
```

## Recipe 9: Auto-Approve Safe Commands

Automatically approve known-safe commands.

### Configuration

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash(npm test)",
        "command": ".claude/hooks/auto-approve-tests.sh"
      },
      {
        "matcher": "Bash(npm run lint)",
        "command": ".claude/hooks/auto-approve-tests.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/auto-approve-tests.sh

# Return JSON to auto-approve
echo '{"decision": "allow"}'
exit 0
```

### Advanced: Conditional Approval

```bash
#!/bin/bash
# .claude/hooks/conditional-approve.sh

# Auto-approve in development, require confirmation in CI
if [ -n "$CI" ]; then
    echo '{"decision": "ask"}'
else
    echo '{"decision": "allow"}'
fi
exit 0
```

## Recipe 10: Auto-Deny Dangerous Commands

Block dangerous commands automatically.

### Configuration

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash(rm -rf *)",
        "command": ".claude/hooks/block-dangerous.sh"
      },
      {
        "matcher": "Bash(* --force)",
        "command": ".claude/hooks/block-dangerous.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/block-dangerous.sh

echo '{"decision": "deny", "reason": "This command is blocked by policy"}'
exit 0
```

## Recipe 11: Cleanup on Stop

Run cleanup when session or agent stops.

### Configuration

```json
{
  "hooks": {
    "Stop": [
      {
        "command": ".claude/hooks/session-cleanup.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/session-cleanup.sh

# Clean up temporary files
rm -rf /tmp/claude-session-* 2>/dev/null

# Log session end
echo "[$(date -Iseconds)] Session ended" >> .claude/audit/sessions.log

exit 0
```

## Recipe 12: One-Time Setup Hook

Run initialization only once per session.

### Configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": ".claude/hooks/session-init.sh",
        "once": true
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/session-init.sh

# This runs only once per session
echo "Initializing session environment..."

# Set up temp directory
mkdir -p /tmp/claude-session-$$

# Log session start
echo "[$(date -Iseconds)] Session started" >> .claude/audit/sessions.log

exit 0
```

## Recipe 13: MCP Server Tool Approval

Auto-approve all tools from a trusted MCP server.

### Configuration

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "mcp__filesystem_*",
        "command": ".claude/hooks/approve-filesystem.sh"
      }
    ]
  }
}
```

### Hook Script

```bash
#!/bin/bash
# .claude/hooks/approve-filesystem.sh

# Auto-approve filesystem MCP tools
echo '{"decision": "allow"}'
exit 0
```

## Recipe 14: Frontmatter Hooks in Skills

Define hooks directly in skill frontmatter for self-contained skills.

### Skill with Embedded Hooks

```yaml
---
name: safe-deployment
description: This skill should be used when deploying to production.
hooks:
  PreToolUse:
    - matcher: "Bash(kubectl *)"
      hooks:
        - type: command
          command: "./validate-k8s.sh"
  PostToolUse:
    - matcher: "Bash(kubectl apply *)"
      hooks:
        - type: command
          command: "./notify-deploy.sh"
  Stop:
    - hooks:
        - type: command
          command: "./deploy-cleanup.sh"
---

# Safe Deployment Skill

...skill content...
```

**Benefits:**
- Self-contained skill configuration
- Hooks travel with the skill
- No separate settings.json required
