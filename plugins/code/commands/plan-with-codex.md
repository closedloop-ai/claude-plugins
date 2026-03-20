---
description: "Iterative plan refinement debate between Claude and Codex"
argument-hint: [--max-rounds N] [--plan-file PATH] [--codex-model MODEL] <prompt>
allowed-tools: Bash, Read, Write, Glob, Grep, TodoWrite, Task, AskUserQuestion, SendMessage, ToolSearch
skills: code:codex-review
---

# Debate Loop -- Claude + Codex Plan Refinement

You are the orchestrator for an iterative plan refinement workflow. Claude (via `code:plan-agent`) creates a plan, Codex reviews it, and you coordinate revisions until Codex approves or max rounds are reached.

**CRITICAL RULE: You MUST NEVER edit the plan file directly.** All plan creation and modification is done by the `code:plan-agent` subagent. Your role is to coordinate -- parse arguments, manage state, run Codex, display feedback, and delegate plan changes to the plan-agent via SendMessage or Agent calls. If you find yourself about to use Edit or Write on the plan file, stop and delegate to the plan-agent instead.

## Step 0: Parse Arguments

Parse from `$ARGUMENTS`:

Arguments: $ARGUMENTS

| Flag | Default | Description |
|------|---------|-------------|
| `--max-rounds N` | 15 | Maximum debate rounds |
| `--plan-file PATH` | `./debate-plan.md` | Output plan file (resolve to absolute path) |
| `--codex-model MODEL` | `gpt-5.4` | Codex model for reviews |
| Remaining text | (required) | The prompt describing what to plan |

Derive sidecar paths from the plan file stem (e.g., for `debate-plan.md`):
- `{stem}.feedback` -- Codex feedback text
- `{stem}.state` -- phase/round/session state
- `{stem}.prompt` -- original prompt (plain text)

**Prompt resolution**: CLI argument > `{stem}.prompt` sidecar. Only abort when neither exists.

Initialize TodoWrite:
```
TodoWrite([
  {"content": "Parse arguments and check for resume", "status": "in_progress"},
  {"content": "Create plan with plan-agent", "status": "pending"},
  {"content": "User review of plan", "status": "pending"},
  {"content": "Codex debate loop", "status": "pending"},
  {"content": "Final report", "status": "pending"}
])
```

**Preload SendMessage tool** (required for agent resume later):
```
ToolSearch(query="select:SendMessage")
```

Error if no prompt is resolvable (no CLI argument and no `{stem}.prompt` sidecar).

## Step 0.5: Check for Resume

Check if `{stem}.state` exists via Bash (`test -f`). If yes, read `ROUND`, `PHASE`, `CODEX_SESSION_ID` via:
```bash
grep "^ROUND=" {state_file} | cut -d= -f2-
grep "^PHASE=" {state_file} | cut -d= -f2-
grep "^CODEX_SESSION_ID=" {state_file} | cut -d= -f2-
```

**Validate preconditions before resuming:**

| Phase | Required files |
|-------|---------------|
| `user_review` | plan file + prompt sidecar |
| `codex_review` | plan file + prompt sidecar |
| `claude_revision` | plan file + feedback file + prompt sidecar |

If preconditions fail: delete stale state file. A fresh start is still possible if a prompt is available (CLI argument or `{stem}.prompt` sidecar). Only abort when neither exists.

If all preconditions pass, announce "Resuming debate at round {N}, phase: {PHASE}" and jump to:
- `user_review` -> Step 1.5
- `codex_review` -> Step 2a at stored ROUND
- `claude_revision` -> Step 2f at stored ROUND

If no state file: fresh start at Step 1.

## Step 1: Create the Plan

Announce: "Creating plan with plan-agent..."

Launch the plan-agent:
```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="Create implementation plan",
  prompt="<user's prompt>. Write the plan to {plan-file-abs}."
)
```

**Store the returned agent_id** -- you will need it to resume the plan-agent in later rounds. Resume via `SendMessage(to="<agent_id>", message="...", summary="...")`. The ToolSearch preload in Step 0 ensures the schema is available.

Verify the plan file exists and is non-empty (Read it).

Announce: "Plan created ({byte_count} bytes) at {plan-file-abs}"

Write the original prompt to `{stem}.prompt` (plain text, via Write tool).

Write state via Bash:
```bash
printf 'ROUND=%s\nPHASE=%s\nCODEX_SESSION_ID=%s\n' '1' 'user_review' '' > {state_file}
```

Update TodoWrite: mark "Create plan" completed, "User review" in_progress.

## Step 1.5: User Checkpoint

Read the plan file. Check for an "Open Questions" section (lines matching `Q-` or `- [ ] Q-`). If open questions exist, present them to the user before anything else using AskUserQuestion:

> The plan has open questions that need your input before proceeding:
>
> 1. **Q-001**: [question text]
>    - **a) [recommended answer]** (recommended)
>    - b) [alternative]
> 2. **Q-002**: [question text]
>    - **a) [recommended answer]** (recommended)
>    - b) [alternative]
>
> Reply with your choices (e.g., "1a, 2b") or provide your own answers.

After the user answers, you MUST delegate plan updates to the plan-agent. Do NOT edit the plan file yourself. Resume the plan-agent via SendMessage:

```
SendMessage(
  to="<agent_id>",
  message="The user answered the open questions as follows:\n\n<user's answers>\n\nUpdate the plan at {plan-file-abs} to incorporate these answers: remove the answered questions from the Open Questions section, and revise any tasks or decisions that depended on those questions. Write the updated plan back to {plan-file-abs}.",
  summary="Update plan with answered questions"
)
```

If no resumable agent (cross-session), launch a fresh one:
```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="Update plan with answered questions",
  prompt="Read the plan at {plan-file-abs}. The user answered the open questions as follows:\n\n<user's answers>\n\nUpdate the plan to incorporate these answers: remove the answered questions from the Open Questions section, and revise any tasks or decisions that depended on those questions. Write the updated plan back to {plan-file-abs}."
)
```
Store the new agent_id.

Wait for the plan-agent to complete, then re-read the plan and check for remaining open questions. Repeat until no open questions remain.

Once open questions are resolved (or if there were none), present the plan to the user:

> Plan created at `{plan-file-abs}`. Review it and let me know when you're ready to start the Codex debate, or share any changes you'd like made first.

**If the user requests changes:**

Resume the plan-agent with their feedback:
```
SendMessage(
  to="<agent_id>",
  message="User feedback: <their message>. Read the current plan at {plan-file-abs}, revise it, and write the updated plan back to {plan-file-abs}.",
  summary="Revise plan per user feedback"
)
```

If no resumable agent exists (cross-session resume), launch a fresh one:
```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="Revise plan per user feedback",
  prompt="Read the current plan at {plan-file-abs} and revise it based on user feedback. Original request: <prompt from sidecar>. User feedback: <their message>. Write the updated plan back to {plan-file-abs}."
)
```
Store the new agent_id for subsequent rounds.

Loop back to this checkpoint until the user says to proceed.

**When the user confirms** (e.g., "start", "go", "looks good", "proceed"):

Update state:
```bash
printf 'ROUND=%s\nPHASE=%s\nCODEX_SESSION_ID=%s\n' '1' 'codex_review' '' > {state_file}
```

Proceed to Step 2.

## Step 2: Debate Loop

Repeat for round 1 to max-rounds:

### 2a. Codex Review

Update TodoWrite: "Round {N}/{max}: Codex reviewing..."

Activate the `code:codex-review` skill and run via Bash:
```bash
bash <base_directory>/scripts/run_codex_review.sh \
  --plan-file {plan-file-abs} \
  --feedback-file {feedback-file-abs} \
  --round {N} \
  --codex-model {codex-model} \
  [--session-id {codex_session_id}]
```

Parse stdout tokens:
- `VERDICT:APPROVED` or `VERDICT:NEEDS_CHANGES`
- `CODEX_SESSION:<thread_id>` -- save for next round

Update state with new CODEX_SESSION_ID.

### 2b. Handle Failures (do NOT increment round)

- `CODEX_FAILED:<reason>`: Announce the warning. Ask the user: "Codex failed: {reason}. Retry or abort?" On retry: re-run 2a. On abort: go to Step 3.
- `CODEX_EMPTY`: Announce "Codex returned empty response." Same retry/abort handling.

### 2c. Display Feedback

Read the feedback file and display the full Codex feedback to the user.

### 2d. Check Verdict

- **VERDICT:APPROVED**: Announce "Plan approved by Codex after {N} round(s)." Go to Step 3.
- **Last round, not approved**: Announce "Max rounds ({max}) reached without approval." Go to Step 3.
- **VERDICT:NEEDS_CHANGES**: Continue to 2e.

### 2e. Proceed to Revision (automated)

The Codex/Claude loop is fully automated after the user approved the plan in Step 1.5. Do NOT ask the user for confirmation between rounds -- proceed directly to revision.

Update state:
```bash
printf 'ROUND=%s\nPHASE=%s\nCODEX_SESSION_ID=%s\n' '{N}' 'claude_revision' '{codex_session_id}' > {state_file}
```

Proceed to 2f.

### 2f. Claude Revision

Update TodoWrite: "Round {N}/{max}: Revising plan..."

Resume the plan-agent:
```
SendMessage(
  to="<agent_id>",
  message="Revise the plan at {plan-file-abs} based on feedback at {feedback-file-abs}. Address ALL concerns raised.",
  summary="Revise plan per Codex feedback"
)
```

If resume fails (cross-session -- agent gone), launch fresh:
```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="Revise plan based on Codex feedback",
  prompt="Revise the plan at {plan-file-abs} based on feedback at {feedback-file-abs}. The original request was: <prompt>. Read the current plan and feedback files to understand context. Write the updated plan back to {plan-file-abs}."
)
```
Store the new agent_id for subsequent rounds.

Verify the plan file was updated.

Update state:
```bash
printf 'ROUND=%s\nPHASE=%s\nCODEX_SESSION_ID=%s\n' '{N+1}' 'codex_review' '{codex_session_id}' > {state_file}
```

Continue to next round.

## Step 3: Final Report

Report the outcome:
- If approved: "Plan approved by Codex. File: {plan-file-abs}"
- If max rounds: "Plan not approved after {max} rounds. File: {plan-file-abs}"
- If aborted: "Debate aborted. Partial plan at: {plan-file-abs}"

Clean up ALL sidecar files:
```bash
rm -f {state_file} {feedback_file} {prompt_file}
```

The prompt sidecar is intentionally deleted on completion to prevent stale intent from silently reusing on future runs against the default `./debate-plan.md` path.

Update TodoWrite: mark all remaining items completed.
