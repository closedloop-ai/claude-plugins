---
description: "Create an implementation plan"
argument-hint: [working-directory] [--prd <requirements-file>] [--plan <plan-file>] [--add-dir <path>]
allowed-tools: Bash, Edit, Write, Task, TodoWrite, SendMessage, AskUserQuestion
---

# Bootstrap ClosedLoop (Planning Only)

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-closedloop.sh" $ARGUMENTS --prompt plan-prompt`

Follow the orchestrator instructions in the prompt file specified by `CLOSEDLOOP_PROMPT_FILE` in the config output above. There is NO external loop here — this is a single-shot planning run. Your previous work (if any) is visible in files and git history.

IMPORTANT: You are an ORCHESTRATOR running PLAN ONLY (phases 0.9–2.8). After reading the prompt file, your FIRST action must be TodoWrite. Do NOT read project files (PRD, plan.json, code, etc.). Delegate all project file reading to subagents.

After Phase 2.8 completes, write `state.json` with `status: COMPLETED`, output `<promise>PLAN_COMPLETE</promise>`, and stop. Do NOT proceed to implementation phases (3–7).

CRITICAL RULE: Only output `<promise>PLAN_COMPLETE</promise>` when the plan is genuinely finalized (plan.json + plan.md ready and validated). Do not output false promises to end early.
