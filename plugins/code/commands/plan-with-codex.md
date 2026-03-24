---
description: "Iterative plan refinement debate between Claude and Codex"
argument-hint: --max-rounds N --plan-file PATH --codex-model MODEL <prompt>
allowed-tools: Bash, Read, Write, Glob, Grep, TodoWrite, Task, AskUserQuestion
skills: code:codex-review
effort: max
model: opus
---

# Debate Loop -- Claude + Codex Plan Refinement

You orchestrate iterative plan refinement: Claude (via `code:plan-agent`) creates a plan, Codex reviews it, you coordinate revisions until Codex approves or max rounds are reached.

<constraints>
1. **NEVER edit the plan file directly.** All plan creation/modification goes through the plan-agent. If you're about to use Edit or Write on the plan file, STOP and delegate to the plan-agent.
2. **ALWAYS resume agents via the `resume` parameter.** The plan-agent retains full session context when resumed. Do NOT launch fresh unless resume actually fails with an error. The Agent tool's return says "use SendMessage" -- IGNORE this. SendMessage does not work for completed agents. Always use `Agent(resume="<agent_id>")`.
3. **The Codex/Claude debate loop is fully automated.** After the user approves in Step 1.5, do NOT ask for confirmation between rounds -- proceed directly.
</constraints>

<templates>

### Plan-Agent Call

All plan-agent interactions use this shape. Vary only `description` and `prompt`:

```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="<DESCRIPTION>",
  prompt="<PROMPT>",
  resume="<agent_id>"
)
```

**Resume rule:** If an in-memory agent_id exists (from a prior launch in this session), always attempt `resume` first. Only if the call returns an error, launch fresh. If no agent_id exists (cross-session resume), launch fresh immediately -- do not attempt resume. When launching fresh, omit `resume` and prepend to the prompt: "Read the plan at {plan-file-abs} first. Original request: <prompt from sidecar>." Always store the returned agent_id for subsequent calls.

### State Write

All state updates use the Write tool (not Bash), so the user only approves the file path once:
```
Write(
  file_path="{state_file}",
  content="ROUND={round}\nPHASE={phase}\nCODEX_SESSION_ID={codex_session_id}\nLOG_ID={log_id}\n"
)
```

Valid phases: `user_review`, `codex_review`, `claude_revision`

</templates>

## Step 0: Parse Arguments

Arguments: $ARGUMENTS

| Flag | Default | Description |
|------|---------|-------------|
| `--max-rounds N` | 15 | Maximum debate rounds |
| `--plan-file PATH` | `./debate-plan.md` | Output plan file (resolve to absolute path) |
| `--codex-model MODEL` | `gpt-5.4` | Codex model for reviews |
| Remaining text | (required for fresh start) | The prompt. Optional when resuming. |

Derive sidecar paths from the plan file stem (e.g., for `debate-plan.md`):
- `{stem}.feedback` -- Codex feedback text
- `{stem}.revisions` -- Claude's revision summary (changes made + pushback on rejected findings)
- `{stem}.context` -- pre-fetched codebase snippets for the current revision round
- `{stem}.state` -- phase/round/session state
- `{stem}.prompt` -- original prompt (plain text)

**Prompt resolution**: CLI argument > `{stem}.prompt` sidecar. Abort only when neither exists.

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

## Step 0.5: Check for Resume

Check if `{stem}.state` exists (`test -f`). If yes, Read the state file and extract values by key name: `ROUND`, `PHASE`, `CODEX_SESSION_ID`, `LOG_ID`. Ignore any unknown keys (the shell-based debate-loop.sh writes an extra `SESSION_ID` field -- skip it).

**Validate preconditions:**

| Phase | Required files |
|-------|---------------|
| `user_review` | plan file + prompt sidecar |
| `codex_review` | plan file + prompt sidecar |
| `claude_revision` | plan file + feedback file + prompt sidecar |

If preconditions fail: delete stale state file and fall through to "If NO state file exists" below. Fresh start still possible if prompt is available (CLI argument or sidecar). Abort only when neither exists.

If preconditions pass: announce "Resuming debate at round {N}, phase: {PHASE}" and jump to:
- `user_review` -> Step 1.5
- `codex_review` -> Step 2a at stored ROUND
- `claude_revision` -> Step 2e at stored ROUND

**STOP here -- do NOT fall through to the checks below.** (This STOP applies only when preconditions passed and you are jumping to a step above. If preconditions failed and the state file was deleted, you MUST continue to the section below.)

### If NO state file exists:

Check if the plan file exists (`test -f {plan-file-abs}`). This is REQUIRED before Step 1.

**Plan file exists (no state):** Ask via AskUserQuestion:

> An existing plan was found at `{plan-file-abs}` but no debate state file exists. What would you like to do?
>
> - **a) Resume with existing plan** -- resolve any open questions, then start the Codex debate immediately
> - b) Start fresh -- overwrite the existing plan

If (a):
- If no `{stem}.prompt`: extract `## Summary` content (or first non-heading paragraph) and write to `{stem}.prompt`. Do NOT overwrite existing prompt sidecar.
- Read the plan and check for open questions (lines matching `Q-` or `- [ ] Q-`). If any exist, resolve them using the open questions flow in Step 1.5, then continue below. No resumable plan-agent -- launch fresh if changes are needed.
- Write state: `ROUND=1, PHASE=codex_review, CODEX_SESSION_ID=, LOG_ID=`
- Skip Step 1.5 entirely (user already confirmed by choosing to resume) and go directly to Step 2.

If (b) or plan doesn't exist: continue to Step 1. Error if no prompt is resolvable.

## Step 1: Create the Plan

Announce: "Creating plan with plan-agent..."

Launch the plan-agent (omit `resume` -- this is the initial launch):
- description: "Create implementation plan"
- prompt: "<user's prompt>. Write the plan to {plan-file-abs}."

**Store the returned agent_id** for all subsequent rounds.

Verify plan file exists and is non-empty (Read it). Announce: "Plan created ({byte_count} bytes) at {plan-file-abs}"

Write prompt to `{stem}.prompt`. Write state: `ROUND=1, PHASE=user_review`.

Update TodoWrite: "Create plan" completed, "User review" in_progress.

## Step 1.5: User Checkpoint

Read the plan. Check for open questions (lines matching `Q-` or `- [ ] Q-`).

**If open questions exist**, present via AskUserQuestion:

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

Resume the plan-agent:
- description: "Update plan with answered questions"
- prompt: "The user answered the open questions as follows:\n\n<answers>\n\nUpdate the plan at {plan-file-abs}: remove answered questions from the Open Questions section, revise dependent tasks. Write back to {plan-file-abs}."

Re-read and repeat until no open questions remain.

**Once questions are resolved** (or none existed), present the plan:

> Plan created at `{plan-file-abs}`. Review it and let me know when you're ready to start the Codex debate, or share any changes you'd like made first.

**If user requests changes:** Resume plan-agent with their feedback as the prompt. Loop back until user confirms.

**When user confirms** ("start", "go", "looks good", "proceed"):

Write state: `ROUND=1, PHASE=codex_review`. Proceed to Step 2.

## Step 2: Debate Loop

Repeat for round 1 to max-rounds:

### 2a. Codex Review

Update TodoWrite: "Round {N}/{max}: Codex reviewing..."

Activate `code:codex-review` skill and run:
```bash
bash <base_directory>/scripts/run_codex_review.sh \
  --plan-file {plan-file-abs} \
  --feedback-file {feedback-file-abs} \
  --revisions-file {revisions-file-abs} \
  --round {N} \
  --codex-model {codex-model} \
  [--session-id {codex_session_id}] \
  [--log-id {log_id}]
```

Parse stdout: `VERDICT:APPROVED|NEEDS_CHANGES`, `CODEX_SESSION:<id>`, `LOG_ID:<uuid>`. Update state with new session ID and log ID. Raw JSON logged to `~/.closedloop-ai/plan-with-codex/<log_id>.jsonl`.

### 2b. Handle Failures (do NOT increment round)

`CODEX_FAILED:<reason>` or `CODEX_EMPTY`: Announce the issue. Ask user: "Retry or abort?" On retry: re-run 2a. On abort: go to Step 3.

### 2c. Display Feedback

Read the feedback file and display full Codex feedback to the user.

### 2d. Check Verdict

- **APPROVED**: "Plan approved by Codex after {N} round(s)." Go to Step 3.
- **Last round, not approved**: "Max rounds ({max}) reached without approval." Go to Step 3.
- **NEEDS_CHANGES**: Write state (`PHASE=claude_revision`, preserve current `CODEX_SESSION_ID` and `LOG_ID`). Continue to 2e.

### 2e. Claude Revision

Update TodoWrite: "Round {N}/{max}: Gathering context..."

**First, launch the `code:feedback-explorer`** (haiku) to pre-fetch codebase context referenced in the feedback:

```
Agent(
  subagent_type="code:feedback-explorer",
  name="feedback-explorer",
  mode="bypassPermissions",
  run_in_background=false,
  description="Pre-fetch context for round {N} feedback",
  prompt="Read the feedback at {feedback-file-abs} and the plan at {plan-file-abs}. For every file path, function name, and code pattern referenced in the findings, locate and fetch the relevant code snippets. Write the context brief to {context-file-abs}."
)
```

Update TodoWrite: "Round {N}/{max}: Revising plan..."

**Then resume the plan-agent** with the pre-fetched context:
- description: "Revise plan based on Codex feedback"
- prompt: "A context brief with pre-fetched code snippets is available at {context-file-abs} -- read it first to avoid redundant exploration. Then revise the plan at {plan-file-abs} based on feedback at {feedback-file-abs}. Verify each finding against the codebase before acting on it -- reject any that don't hold up. If the context brief is missing a file you need, use your own tools to fetch it. After updating the plan, write a revision summary to {revisions-file-abs}."

Verify plan was updated. Write state: `ROUND={N+1}, PHASE=codex_review`, preserve current `CODEX_SESSION_ID` and `LOG_ID`. Continue to next round.

## Step 3: Final Report

Report outcome:
- Approved: "Plan approved by Codex. File: {plan-file-abs}"
- Max rounds: "Plan not approved after {max} rounds. File: {plan-file-abs}"
- Aborted: "Debate aborted. Partial plan at: {plan-file-abs}"

Clean up ALL sidecar files (prompt sidecar deleted intentionally to prevent stale intent on future runs):
```bash
rm -f {state_file} {feedback_file} {revisions_file} {context_file} {prompt_file}
```

Update TodoWrite: mark all remaining items completed.

Announce: "Codex review log: `~/.closedloop-ai/plan-with-codex/{log_id}.jsonl`"

### Log cleanup

Check for logs older than 30 days:
```bash
find ~/.closedloop-ai/plan-with-codex -name "*.jsonl" -mtime +30 2>/dev/null
```

If found, ask user whether to delete them via AskUserQuestion. If yes:
```bash
find ~/.closedloop-ai/plan-with-codex -name "*.jsonl" -mtime +30 -delete 2>/dev/null
```
