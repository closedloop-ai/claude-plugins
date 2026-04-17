---
description: "Iterative plan refinement debate between Claude and Codex"
argument-hint: --max-rounds N --plan-file PATH --codex-model MODEL <prompt>
allowed-tools: Bash, Read, Write, Glob, Grep, TodoWrite, Task, AskUserQuestion, SendMessage
skills: code:codex-review
effort: max
model: opus
---

# Debate Loop -- Claude + Codex Plan Refinement

You orchestrate iterative plan refinement: Claude (via `code:plan-agent`) creates a plan, Codex reviews it, you coordinate revisions until Codex approves or max rounds are reached.

<constraints>
1. **NEVER edit the plan file directly.** All plan creation/modification goes through the plan-agent. If you're about to use Edit or Write on the plan file, STOP and delegate to the plan-agent.
2. **Continue the plan-agent via SendMessage across rounds.** Capture the `agent_id` returned by the first `Agent(...)` call and reuse it for every subsequent plan-agent interaction via `SendMessage(to="<agent_id>", ...)`. Completed subagents auto-resume from transcript in the background, preserving full prior context. Only launch a fresh `Agent(...)` when no in-memory `agent_id` is available (cross-session resume after a previous Claude Code session ended) or when a SendMessage call actually errors -- fresh launches must use a self-contained prompt.
3. **The Codex/Claude debate loop is fully automated.** After the user approves in Step 1.5, do NOT ask for confirmation between rounds -- proceed directly.
</constraints>

<templates>

### Plan-Agent -- Initial Launch

First plan-agent call in a session, or fallback when no `agent_id` is in memory. Vary only `description` and `prompt`:

```
Agent(
  subagent_type="code:plan-agent",
  name="plan-agent",
  mode="acceptEdits",
  run_in_background=false,
  description="<DESCRIPTION>",
  prompt="<PROMPT>"
)
```

**Capture the returned `agent_id`** from the Agent tool's result line (format: `agentId: <id>`) and reuse it for every subsequent plan-agent interaction in this session.

### Plan-Agent -- Continuation (preferred after initial launch)

For every plan-agent interaction after the initial launch, continue the same agent via SendMessage against the stored `agent_id`. Completed agents auto-resume from transcript in the background with full prior context intact -- this preserves the plan-agent's own memory of what it changed in earlier rounds:

```
SendMessage(
  to="<stored_agent_id>",
  summary="<5-10 word summary>",
  message="<PROMPT>"
)
```

SendMessage returns immediately with a queued acknowledgment ("had no active task; resumed from transcript in the background"). The agent then runs in the background and you will receive a `<task-notification>` with status and result when it finishes. **Do NOT proceed to the next step until that notification arrives.** If you need the agent's full output, read the `<output-file>` path from the notification.

**Resume rule:** The first plan-agent interaction in a session uses Initial Launch; every later interaction uses Continuation with the stored `agent_id`. If no `agent_id` is in memory (cross-session resume after a previous Claude Code session ended), use Initial Launch and prepend to the prompt: "Read the plan at {plan-file-abs} first. Original request: <prompt from sidecar>." If `{stem}.exclusions` exists, also append: "The user has confirmed these items are out of scope -- do not re-add them: <contents of exclusions file>." After any Initial Launch (first round or fallback), store the new `agent_id`. If a SendMessage call returns an actual error (not just the normal queued acknowledgment), fall back to Initial Launch with the self-contained prompt.

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
| `--codex-model MODEL` | `gpt-5.3-codex` | Codex model for reviews |
| Remaining text | (required for fresh start) | The prompt. Optional when resuming. |

Derive sidecar paths from the plan file stem (e.g., for `debate-plan.md`):
- `{stem}.feedback` -- Codex feedback text
- `{stem}.revisions` -- Claude's revision summary (changes made + pushback on rejected findings)
- `{stem}.state` -- phase/round/session state
- `{stem}.prompt` -- original prompt (plain text, never mutated after initial write)
- `{stem}.exclusions` -- user-confirmed deferral exclusions (written by Step 1.5)

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

If preconditions pass: check whether `{stem}.exclusions` exists. If ROUND > 1 and the exclusions file is missing, warn the user via AskUserQuestion: "Resuming at round {N}, but the exclusions file (`{stem}.exclusions`) is missing. Any previously confirmed deferral decisions may be lost if the plan-agent is re-launched fresh. Continue anyway, or abort?" On abort, go to Step 3. On continue, proceed normally.

Announce "Resuming debate at round {N}, phase: {PHASE}" and jump to:
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
- If no `{stem}.prompt`: extract `## Summary` content (or first non-heading paragraph) and write to `{stem}.prompt` with a `[synthesized]` marker on the first line. Do NOT overwrite existing prompt sidecar. (The marker tells Step 1.5 this is plan-derived text, not the user's actual words.)
- Read the plan and check for open questions (lines matching `Q-` or `- [ ] Q-`) and deferred work (sections/items containing "Deferred", "Out of Scope", "Future Work", "Post-MVP", or "Nice to Have" -- same keywords as Step 1.5). If any exist, resolve them using the open questions flow in Step 1.5, then continue below. No resumable plan-agent -- launch fresh if changes are needed.
- Write state: `ROUND=1, PHASE=codex_review, CODEX_SESSION_ID=, LOG_ID=`
- Skip Step 1.5 entirely (user already confirmed by choosing to resume) and go directly to Step 2.

If (b) or plan doesn't exist: continue to Step 1. Error if no prompt is resolvable.

## Step 1: Create the Plan

Announce: "Creating plan with plan-agent..."

Use the Initial Launch template:
- description: "Create implementation plan"
- prompt: "<user's prompt>. Write the plan to {plan-file-abs}."

**Store the returned `agent_id`** for all subsequent rounds.

Verify plan file exists and is non-empty (Read it). Announce: "Plan created ({byte_count} bytes) at {plan-file-abs}"

Write prompt to `{stem}.prompt`. Write state: `ROUND=1, PHASE=user_review`.

Update TodoWrite: "Create plan" completed, "User review" in_progress.

## Step 1.5: User Checkpoint

Read the plan. Check for open questions (lines matching `Q-` or `- [ ] Q-`).

**Also scan for deferred work.** First, read `{stem}.prompt`. If the file starts with `[synthesized]`, it was derived from the plan itself -- do NOT use it to judge user intent (always run the deferral scan in this case). If the prompt is not synthesized and the user explicitly requested a phased rollout, future-work breakdown, or similar structure, skip the deferral scan -- those sections are intentional. Otherwise, search the plan for sections or items containing any of these keywords (case-insensitive): "Deferred", "Out of Scope", "Future Work", "Post-MVP", "Nice to Have". If any are found, extract each deferred item and present it to the user alongside open questions (see format below). The user must explicitly approve any deferral -- the plan-agent is not allowed to unilaterally exclude work.

**If open questions or deferred items exist**, present via AskUserQuestion:

> The plan has items that need your input before proceeding:
>
> **Open Questions:**
> 1. **Q-001**: [question text]
>    - **a) [recommended answer]** (recommended)
>    - b) [alternative]
>
> **Deferred Items** (the plan excludes these from scope -- do you agree?):
> 2. **D-001**: [deferred item description]
>    - **a) Include in plan** -- add tasks for this work
>    - b) Confirm deferral -- leave it out
>
> Reply with your choices (e.g., "1a, 2b") or provide your own answers.

(Omit the "Open Questions" heading if there are none. Omit the "Deferred Items" heading if there are none.)

**Build the plan-agent prompt** by including the full text of each deferred item and the user's decision (not just "2a"). Example format:

```
The user answered the open questions and deferral decisions as follows:

Open Questions:
- Q-001: [question text] -- Answer: [user's answer]

Deferred Items:
- D-001: "[full deferred item description]" -- Decision: INCLUDE (add tasks for this work)
- D-002: "[full deferred item description]" -- Decision: EXCLUDE (user confirmed deferral)

Update the plan at {plan-file-abs}:
1. Remove answered questions from the Open Questions section, revise dependent tasks.
2. For INCLUDE items, add concrete tasks to the appropriate phase.
3. Remove any "Deferred", "Out of Scope", "Future Work", "Post-MVP", and "Nice to Have" sections that were flagged as deferred items above. Do not remove sections that the user explicitly requested in their original prompt (e.g., phased rollouts, future-work breakdowns).
Write back to {plan-file-abs}.
```

Continue the plan-agent via SendMessage (using the stored `agent_id`):
- summary: "Apply answers and deferrals"
- message: (the text built above)

Wait for the `<task-notification>` before re-reading the plan to verify the update.

**After the plan-agent returns**, update the exclusions sidecar (do NOT modify `{stem}.prompt`). This is a full rewrite each pass -- not an append -- so reversed decisions are reflected:

- If any deferrals were confirmed as EXCLUDE, write them:
  ```
  Write {stem}.exclusions with content:

  User-confirmed exclusions (do not re-add):
  - [excluded item 1]
  - [excluded item 2]
  ```
- If no EXCLUDE items remain (all were reversed or none existed), delete the file: `rm -f {stem}.exclusions`

Re-read and repeat until no open questions or deferred items remain.

**Once questions are resolved** (or none existed), present the plan:

> Plan created at `{plan-file-abs}`. Review it and let me know when you're ready to start the Codex debate, or share any changes you'd like made first.

**If user requests changes:** Continue plan-agent via SendMessage with their feedback as the `message`. Wait for the `<task-notification>`, then re-read the plan. Loop back until the user confirms.

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
  --request-file {stem}.prompt \
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

Update TodoWrite: "Round {N}/{max}: Revising plan..."

**Continue the plan-agent via SendMessage** (using the stored `agent_id`):
- summary: "Revise plan per Codex feedback"
- message: "Revise the plan at {plan-file-abs} based on feedback at {feedback-file-abs}. Verify each finding against the codebase before acting on it. Do not dismiss a finding solely because it looks broader than the request or involves refactoring -- distinguish between required work, justified enabling refactor, and true optional scope creep. Reject only findings that do not hold up or are genuinely optional beyond the minimum needed to deliver the request safely. After updating the plan, write a revision summary to {revisions-file-abs}."

Wait for the `<task-notification>`, then verify the plan was updated. Write state: `ROUND={N+1}, PHASE=codex_review`, preserve current `CODEX_SESSION_ID` and `LOG_ID`. Continue to next round.

## Step 3: Final Report

Report outcome:
- Approved: "Plan approved by Codex. File: {plan-file-abs}"
- Max rounds: "Plan not approved after {max} rounds. File: {plan-file-abs}"
- Aborted: "Debate aborted. Partial plan at: {plan-file-abs}"

Clean up ALL sidecar files (prompt sidecar deleted intentionally to prevent stale intent on future runs):
```bash
rm -f {state_file} {feedback_file} {revisions_file} {prompt_file} {exclusions_file}
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
