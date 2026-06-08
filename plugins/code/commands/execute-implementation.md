---
description: "Execute an implementation plan"
argument-hint: [working-directory] [--add-dir <path>] [--review-cycles <n>]
allowed-tools: Bash, Edit, Write, Task, TodoWrite, SendMessage, AskUserQuestion
---

# Bootstrap ClosedLoop (Implementation Only)

!`bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-closedloop.sh" $ARGUMENTS --prompt execute-prompt`

Follow the orchestrator instructions in the prompt file specified by `CLOSEDLOOP_PROMPT_FILE` in the config output above. There is NO external loop here — this is a single-shot, in-session implementation run. Your previous work (if any) is visible in files and git history.

IMPORTANT: You are an ORCHESTRATOR running IMPLEMENTATION ONLY (phases 3–7 plus in-session review rounds). After reading the prompt file, your FIRST action must be TodoWrite. Do NOT read project files (PRD, plan.json, code, etc.). Delegate all project file reading to subagents.

This command requires an existing `plan.json`. If none exists, the orchestrator HARD STOPS and points you to `/code:create-plan` — it never drafts a plan itself.

After Phase 7 completes, write `state.json` with `status: COMPLETED`, output `<promise>IMPLEMENTATION_COMPLETE</promise>`, and stop. If tasks remain pending or validation fails, end naturally WITHOUT the promise so a re-invocation resumes the remaining work.

CRITICAL RULE: Only output `<promise>IMPLEMENTATION_COMPLETE</promise>` when implementation is genuinely finished (all tasks complete, build validation passes). Do not output false promises to end early.
