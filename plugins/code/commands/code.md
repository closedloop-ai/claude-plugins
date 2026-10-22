---
description: "Begin coding session"
argument-hint: [working-directory] [--prompt <name>] [--prd <requirements-file>] [--plan <plan-file>]
allowed-tools: Bash, Edit, Write, Task, TodoWrite, SendMessage
---

# Bootstrap ClosedLoop

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-closedloop.sh" $ARGUMENTS`

Follow the orchestrator instructions in the prompt file specified by `CLOSEDLOOP_PROMPT_FILE` in the config output above. Your previous work is visible in files and git history.

IMPORTANT: You are an ORCHESTRATOR. After reading the prompt file, your FIRST action must be TodoWrite. Do NOT read project files (PRD, plan.json, code, etc.). Delegate all project file reading to subagents.

CRITICAL RULE: You may ONLY output a completion promise when the statement is completely and unequivocally TRUE. Do not output false promises.
