---
name: orchestrator-sequences
description: |
  Canonical reusable orchestration procedures for the ClosedLoop planning/implementation orchestrators — PLAN_VALIDATION_SEQUENCE and AWAITING_USER_SEQUENCE. Single source of truth shared by prompts/prompt.md (full loop), prompts/plan-prompt.md (/code:create-plan) and prompts/execute-prompt.md (/code:execute-implementation), which each load standalone and cannot reference one another at runtime.

  Triggers:
  - An orchestrator phase needs full plan validation (structural + semantic) — run PLAN_VALIDATION_SEQUENCE.
  - An orchestrator reaches a hard stop that requires user action before continuing — run AWAITING_USER_SEQUENCE.
---

# Orchestrator Reusable Procedures

These two procedures are referenced by name throughout the orchestrator prompts (`prompt.md`, `plan-prompt.md`, `execute-prompt.md`). They live here as the single source of truth so a change propagates to all three orchestrators at once. Substitute `$CLOSEDLOOP_WORKDIR` with the literal resolved workdir path in any subagent prompt (never the literal string `$CLOSEDLOOP_WORKDIR`).

## PLAN_VALIDATION_SEQUENCE

Use this sequence whenever a phase needs full plan validation (structural + semantic):
1. Activate `code:plan-validate` skill (runs Python script against $CLOSEDLOOP_WORKDIR)
2. If `FORMAT_ISSUES`: launch @code:plan-writer to fix format issues, then re-activate `code:plan-validate`
3. If `VALID`: launch @code:plan-validator with prompt: "WORKDIR=$CLOSEDLOOP_WORKDIR. SEMANTIC ONLY: Check semantic consistency of $CLOSEDLOOP_WORKDIR/plan.json — verify storage/query alignment and task/architecture decision consistency. Skip structural validation (already passed)."
4. If semantic check finds issues: launch @code:plan-writer to fix, then re-activate `code:plan-validate`

## AWAITING_USER_SEQUENCE

Use this sequence at any hard-stop that requires user action before continuing. The caller supplies the per-site `phase`, `reason`, `file` (path or null), and `command` (the resume command — built from the resolved `CLOSEDLOOP_ORIGINAL_ARGS` value, never the literal string `$ARGUMENTS`):
1. **FIRST** — Write state.json with AWAITING_USER status:
   `echo '{"phase": "<current phase>", "status": "AWAITING_USER", "reason": "<why>", "userAction": {"description": "<what user should do>", "file": "<path or null>", "command": "<resume command>"}, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > $CLOSEDLOOP_WORKDIR/state.json`
2. **ONLY AFTER state.json is written** — Output your command's completion promise: `<promise>PLAN_COMPLETE</promise>` for `/code:create-plan`, `<promise>IMPLEMENTATION_COMPLETE</promise>` for `/code:execute-implementation`, or `<promise>COMPLETE</promise>` for the full `/code:code` loop. Use the single promise token defined by your own prompt.
3. Tell the user what to do (review file, fix issues, run command)
4. **HARD STOP** — Do not continue even if the user asks
