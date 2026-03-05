---
description: Plan Amend - Discuss and apply amendments to a plan.json implementation plan
argument-hint: --workdir [path] --message "<text>" [--state-file [path]]
skills: code:plan-editing-conventions, code:extract-plan-md
---

# Experimental Plan Amend Command

Discuss and apply amendments to a plan.json implementation plan through natural conversation.

## Role

When you invoke this command, **you are the orchestrator**. You handle the conversation directly, making edits when appropriate and using the state management script to persist conversation across workflow runs.

## Usage

```bash
# With workdir (GitHub workflow passes this via $CLOSEDLOOP_WORKDIR)
/code:amend-plan --workdir .claude/work --message "for task T-1.1, don't remove the SplashScreen.setLoadingInfo call"

# Auto-detect from $CLOSEDLOOP_WORKDIR or .claude/work
/code:amend-plan --message "change the caching approach in T-2.1"

# With explicit state file
/code:amend-plan --workdir .claude/work --state-file .claude/work/amend-session.json --message "yes go ahead"
```

## Options

- `--workdir <path>` - Path to the work directory. If not provided, uses `$CLOSEDLOOP_WORKDIR` env var or defaults to `.claude/work`
- `--message <text>` - The user's message (required)
- `--state-file <path>` - Path to amend session state file. Defaults to `{workdir}/amend-session.json`

## Workflow

Use TodoWrite to track your progress through the amendment workflow:

```json
TodoWrite([
  {"content": "Setup: Load state, read plan.json, add user message", "status": "pending", "activeForm": "Setting up amendment context"},
  {"content": "Analyze user intent (directive, question, or confirmation)", "status": "pending", "activeForm": "Analyzing user intent"},
  {"content": "Process request and determine response", "status": "pending", "activeForm": "Processing amendment request"},
  {"content": "Save response to state file", "status": "pending", "activeForm": "Saving response to state"},
  {"content": "Apply changes if confirmed (edit plan.json, regenerate plan.md, run apply)", "status": "pending", "activeForm": "Applying changes"}
])
```

**Note:** The last todo (Apply changes) only applies if the user gave a directive that was safe to apply, or confirmed a previously discussed change. Skip it if you're just answering a question or raising a concern.

## Execution Instructions

### Step 1: Setup

1. **Locate amend_state.py** (required for all Python commands):
   Use `code:find-plugin-file` skill to find `tools/python/amend_state.py`:
   ```bash
   # Find the amend_state.py file
   AMEND_STATE_PATH=$(python ~/.claude/plugins/cache/closedloop-ai/code/*/skills/find-plugin-file/scripts/find_plugin_file.py tools/python/amend_state.py --plugin code)
   ```

2. **Determine workdir**:
   - If `--workdir` provided, use it
   - Else if `$CLOSEDLOOP_WORKDIR` env var is set, use it
   - Otherwise, default to `.claude/work`

3. **Set state file path**:
   - If `--state-file` provided, use it
   - Otherwise, use `{workdir}/amend-session.json`

4. **Load session state**:
   ```bash
   python "$AMEND_STATE_PATH" load \
     --state-file {state_file} \
     --run-dir {workdir}
   ```

5. **Determine and read the implementation plan**:
   - Check if `{workdir}/plan.json` exists (required for experimental workflow)
   - If not found, error: "No plan.json found in {workdir}"
   - Read `plan.json` to get the full plan structure including `content` field
   - Also read `{workdir}/plan.md` for human-readable version (if it exists)
   - Store `PLAN_FILE=plan.json`

6. **Add user message to conversation**:
   ```bash
   python "$AMEND_STATE_PATH" add-message \
     --state-file {state_file} \
     --role user \
     --content "{user_message}"
   ```

### Step 2: Determine User Intent

Analyze the user's message to determine intent:

| Intent Type | Examples | Action |
|-------------|----------|--------|
| **Directive** | "don't remove X", "change Y to Z", "keep the call to...", "use ABC instead" | Analyze and act |
| **Question** | "what do you think about...", "should we...", "would it be better to..." | Discuss first |
| **Confirmation** | "yes", "go ahead", "make the change", "looks good" | Apply pending changes |
| **Unstructured Input** | Meeting notes, Slack threads, requirements docs, lengthy context with multiple topics | Extract requirements first |

**How to identify unstructured input:**
- Long text with multiple paragraphs or bullet points
- Contains discussion between people (names, quotes, back-and-forth)
- Mixes context, decisions, and action items
- Doesn't have a single clear directive
- Looks like it was copy-pasted from another source

### Step 3A: Handle Directives

If the user is giving a directive (telling you to make a change):

1. **Read the relevant code** to understand implications:
   - Use Glob/Grep/Read tools to examine the actual source files
   - Understand what the current plan does and what the change affects

2. **Assess the change**:
   - Is it safe? Does it conflict with other tasks?
   - Are there implications the user might not have considered?

3. **If the change is safe and straightforward**:
   - Edit `{workdir}/plan.json` directly using the Edit tool:
     - Update the `content` field (the markdown string with `\n` escapes)
     - If task status changes, update structured arrays (pendingTasks ↔ completedTasks)
   - **Regenerate plan.md** after editing plan.json by activating the `extract-plan-md` skill
   - Track the change:
     ```bash
     python "$AMEND_STATE_PATH" add-change \
       --state-file {state_file} \
       --description "Description of what was changed" \
       --task-id "T-1.1"  # if applicable
     ```
   - **IMPORTANT: Save your response BEFORE calling apply** (apply deletes the state file):
     ```bash
     python "$AMEND_STATE_PATH" add-message \
       --state-file {state_file} \
       --role assistant \
       --content "Updated T-1.1 to keep the SplashScreen.setLoadingInfo call."
     ```
   - Apply to finalize the amendment:
     ```bash
     python "$AMEND_STATE_PATH" apply \
       --state-file {state_file} \
       --run-dir {workdir} \
       --plan-format json
     ```

4. **If there's a concern**:
   - Explain the issue clearly
   - Track the proposed change but don't apply yet:
     ```bash
     python "$AMEND_STATE_PATH" add-change \
       --state-file {state_file} \
       --description "Proposed: change X to Y" \
       --task-id "T-2.1"
     ```
   - **Save your response** (this is how the GitHub workflow posts your reply):
     ```bash
     python "$AMEND_STATE_PATH" add-message \
       --state-file {state_file} \
       --role assistant \
       --content "Your response explaining the concern..."
     ```

### Step 3B: Handle Questions

If the user is asking a question:

1. **Analyze the context**:
   - Read the relevant parts of the plan from plan.json
   - Look at the actual code if needed

2. **Respond with analysis**:
   - Explain the current approach
   - Discuss pros/cons of alternatives
   - If you recommend a change, offer to make it

3. **Save your response** (required - this is how the GitHub workflow posts your reply):
   ```bash
   python "$AMEND_STATE_PATH" add-message \
     --state-file {state_file} \
     --role assistant \
     --content "Your response here"
   ```

### Step 3C: Handle Confirmations

If the user is confirming a previously discussed change (e.g., "yes", "go ahead"):

1. **Check for pending changes** in the state
2. **Make the edits** to `{workdir}/plan.json`:
   - Update the `content` field
   - Update structured arrays if needed (pendingTasks, completedTasks, etc.)
3. **Regenerate plan.md** by activating the `extract-plan-md` skill
4. **Save your response BEFORE calling apply** (apply deletes the state file):
   ```bash
   python "$AMEND_STATE_PATH" add-message \
     --state-file {state_file} \
     --role assistant \
     --content "Done - I've updated the plan."
   ```
5. **Apply** to finalize the amendment (see Step 3A)

### Step 3D: Handle Unstructured Input

If the user provides unstructured content (meeting notes, Slack threads, etc.):

1. **Delegate extraction to the amend-extractor agent** using the Task tool:
   ```
   Task(
     subagent_type="code:amend-extractor",
     description="Extract plan amendments from notes",
     prompt="""
     ## Plan Summary
     {paste task IDs and descriptions from the plan}

     ## User Input
     {the unstructured content}
     """
   )
   ```

2. **Parse the JSON response** - The agent returns structured output:
   ```json
   {
     "extracted_changes": [...],
     "unclear_items": [...],
     "no_action_items": [...],
     "summary": "..."
   }
   ```

3. **Save extracted changes to state** for later reference:
   ```bash
   # For each extracted change, add it as a pending change
   python "$AMEND_STATE_PATH" add-change \
     --state-file {state_file} \
     --description "[1] {change.description}" \
     --task-id "{change.task_id}"

   # Repeat for each extracted change, numbering them [1], [2], etc.
   ```

4. **Present to user for confirmation**:
   - List each `extracted_changes` item clearly with its confidence level
   - Mention any `unclear_items` that need clarification
   - Include the numbered IDs so user can reference them (e.g., "apply 1 and 3")

5. **Save your response** with the extracted changes:
   ```bash
   python "$AMEND_STATE_PATH" add-message \
     --state-file {state_file} \
     --role assistant \
     --content "I extracted X potential changes from your notes:\n\n1. **T-1.1** (high confidence): [description]\n2. ...\n\nNeeds clarification:\n- [unclear item]\n\nWhich would you like me to apply? You can say 'all', list numbers (e.g., '1 and 3'), or we can discuss any of them."
   ```

6. **Wait for user confirmation** - Don't apply changes automatically from unstructured input

## Editing plan.json

When editing plan.json, remember:

1. **Content field**: The `content` field contains the full markdown plan as a JSON string with escaped newlines (`\n`). Edit this field to change the human-readable plan text.

2. **Structured arrays**: The plan also has structured arrays that should stay in sync:
   - `pendingTasks` - Tasks not yet completed
   - `completedTasks` - Tasks marked as complete
   - `manualTasks` - Tasks requiring manual action
   - `openQuestions` / `answeredQuestions`
   - `gaps`

3. **After editing plan.json**, always regenerate `plan.md` by activating the `extract-plan-md` skill. This keeps the human-readable markdown in sync.

## State Management Commands Reference

```bash
# Load state (creates new if missing)
python "$AMEND_STATE_PATH" load --state-file {path} --run-dir {workdir}

# Add message to conversation
python "$AMEND_STATE_PATH" add-message --state-file {path} --role user|assistant --content "text"

# Track a pending change
python "$AMEND_STATE_PATH" add-change --state-file {path} --description "text" [--task-id "id"]

# Clear pending changes (if user abandons a discussed change)
python "$AMEND_STATE_PATH" clear-changes --state-file {path}

# Apply changes and reset for re-validation (IMPORTANT: use --plan-format json)
python "$AMEND_STATE_PATH" apply --state-file {path} --run-dir {workdir} --plan-format json

# Get conversation context (for debugging)
python "$AMEND_STATE_PATH" context --state-file {path}
```

## What Apply Does

When `apply` is called with `--plan-format json`, the state management script:

1. **Records amendment in plan.json**: Adds entry to `amendments` array (timestamp, changes, conversation)
2. **Clears reviews**: Deletes old `reviews/*.review.json` so critics can re-run if needed later
3. **Deletes session file**: Removes `amend-session.json` so the next amend starts fresh

## Guidelines

1. **Respect user intent** - If they tell you to make a change, do it (unless there's a real technical concern)
2. **Always verify against actual code** - Read source files before making claims about what code does
3. **Keep responses concise** - Don't over-explain straightforward changes
4. **Only push back when necessary** - Flag genuine technical concerns, not stylistic preferences
5. **ALWAYS save your response** - Use `add-message --role assistant` to save your response to the state file. The GitHub workflow extracts this to post as a comment. Save BEFORE calling apply.
6. **Track conversation state** - Save messages so context persists across workflow runs
7. **Keep plan.json and plan.md in sync** - Always use the `extract-plan-md` skill after editing plan.json

## Examples

### Example 1: Straightforward Directive

**User**: "for T-1.1, don't remove the SplashScreen.setLoadingInfo call"

**You**:
```
TodoWrite: Mark "Setup" as in_progress
```
1. Load state, read plan.json, add user message to state
```
TodoWrite: Mark "Setup" completed, "Analyze user intent" in_progress
```
2. This is a directive - user wants a change made
```
TodoWrite: Mark "Analyze" completed, "Process request" in_progress
```
3. Read the actual code to verify this is safe - no issues found
4. Edit `plan.json` content field to keep the SplashScreen call
5. Activate `extract-plan-md` skill to regenerate `plan.md`
```
TodoWrite: Mark "Process" completed, "Save response" in_progress
```
6. **Save response to state file** (CRITICAL - do this BEFORE apply):
   ```bash
   python "$AMEND_STATE_PATH" add-message --state-file {state_file} --role assistant --content "Updated T-1.1 to keep the SplashScreen.setLoadingInfo call."
   ```
```
TodoWrite: Mark "Save response" completed, "Apply changes" in_progress
```
7. Run apply to finalize:
   ```bash
   python "$AMEND_STATE_PATH" apply --state-file {state_file} --run-dir {workdir} --plan-format json
   ```
```
TodoWrite: Mark "Apply changes" completed
```

### Example 2: Question

**User**: "what do you think about keeping the SplashScreen.setLoadingInfo call?"

**You**:
1. Setup: Load state, read plan.json, add user message
2. Analyze: This is a question, not a directive
3. Process: Read the plan and code, analyze the context
4. **Save response to state file**:
   ```bash
   python "$AMEND_STATE_PATH" add-message --state-file {state_file} --role assistant --content "The plan removes it because it's only used during development. If you're using it for debugging or want it for UX reasons, it's safe to keep - it's isolated. Want me to update the plan to keep it?"
   ```
5. Skip "Apply changes" todo - this was just a question

### Example 3: Confirmation

**User**: "yes go ahead"

**You**:
1. Setup: Load state (has previous conversation), add user message
2. Analyze: This is a confirmation of a previously discussed change
3. Process: Check pending_changes in state, make the edit to `plan.json`
4. Activate `extract-plan-md` skill to regenerate `plan.md`
5. **Save response to state file BEFORE calling apply**:
   ```bash
   python "$AMEND_STATE_PATH" add-message --state-file {state_file} --role assistant --content "Done - I've updated the plan."
   ```
6. Apply with `--plan-format json` (this deletes the state file, but amendment is recorded in plan.json)

## Error Handling

- **No workdir found**: "Error: No workdir specified and $CLOSEDLOOP_WORKDIR not set. Please specify --workdir."
- **No plan.json**: "Error: No plan.json found in {workdir}. This command requires an experimental workflow plan."
- **Apply fails**: Report the error from the apply command

## Session State File Structure

The `amend-session.json` file tracks:

```json
{
  "version": "1.0",
  "run_dir": ".claude/work",
  "status": "discussing",
  "conversation": [
    {"role": "user", "content": "...", "timestamp": "..."},
    {"role": "assistant", "content": "...", "timestamp": "..."}
  ],
  "pending_changes": [
    {"task_id": "T-1.1", "description": "...", "discussed_at": "..."}
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

Status values:
- `discussing` - Active conversation
- `applied` - Changes have been applied, validation running
