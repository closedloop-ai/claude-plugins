#!/bin/bash

# Loop Stop Hook
# Generic validation loop for configured agents
# Reads config from $CLAUDE_PLUGIN_ROOT/scripts/loop-agents.json

set -euo pipefail

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

# Debug logging (redirected to WORKDIR once discovered)
DEBUG_LOG="/dev/null"

# Track whether we're blocking the agent (continuing the loop)
BLOCKING=false
STATE_FILE=""

# Cleanup trap: if the hook exits without blocking, delete the state file.
# This is the safety net — individual code paths may also log/exit,
# but this ensures no orphaned state files on unexpected exit paths.
cleanup_on_exit() {
    if [[ "$BLOCKING" != "true" ]] && [[ -n "$STATE_FILE" ]] && [[ -f "$STATE_FILE" ]]; then
        rm -f "$STATE_FILE"
    fi
}
trap cleanup_on_exit EXIT

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
LOOP_CONFIG="$PLUGIN_ROOT/scripts/loop-agents.json"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Get agent info from hook input
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // empty')
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')

# Discover WORKDIR via session_id mapping (created by setup-closedloop.sh)
CLOSEDLOOP_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
  WORKDIR_FILE="$CWD/$CLOSEDLOOP_STATE_DIR/session-$SESSION_ID.workdir"
  if [[ -f "$WORKDIR_FILE" ]]; then
    CLOSEDLOOP_WORKDIR=$(cat "$WORKDIR_FILE")
  fi
fi

# Source closedloop config from WORKDIR if found
if [[ -n "$CLOSEDLOOP_WORKDIR" ]]; then
  CLOSEDLOOP_CONFIG="$CLOSEDLOOP_WORKDIR/$CLOSEDLOOP_STATE_DIR/config.env"
  if [[ -f "$CLOSEDLOOP_CONFIG" ]]; then
    source "$CLOSEDLOOP_CONFIG"
  fi
  # Redirect debug logs into workdir (per-run, not shared /tmp)
  mkdir -p "$CLOSEDLOOP_WORKDIR/.learnings"
  DEBUG_LOG="$CLOSEDLOOP_WORKDIR/.learnings/loop-stop-hook-debug.log"
  echo "$(date): Hook started (WORKDIR=$CLOSEDLOOP_WORKDIR)" >> "$DEBUG_LOG"
fi

# Get agent_type from file (written by subagent-start-hook)
# Only look in CLOSEDLOOP_WORKDIR - don't fall back to CWD
AGENT_TYPES_DIR=""
AGENT_TYPE=""
if [[ -n "$CLOSEDLOOP_WORKDIR" ]]; then
  AGENT_TYPES_DIR="$CLOSEDLOOP_WORKDIR/.agent-types"
  if [[ -n "$AGENT_ID" ]] && [[ -f "$AGENT_TYPES_DIR/$AGENT_ID" ]]; then
    AGENT_TYPE=$(cut -d'|' -f1 "$AGENT_TYPES_DIR/$AGENT_ID")
    # Don't clean up here - subagent-stop-hook.sh (runs after) needs it
    echo "$(date): Agent type: $AGENT_TYPE" >> "$DEBUG_LOG"
  fi
fi

# Check if this agent is in the loop config
if [[ ! -f "$LOOP_CONFIG" ]]; then
  echo "$(date): No loop config found at $LOOP_CONFIG" >> "$DEBUG_LOG"
  exit 0
fi

AGENT_CONFIG=$(jq -r --arg type "$AGENT_TYPE" '.loop_agents[$type] // empty' "$LOOP_CONFIG")
if [[ -z "$AGENT_CONFIG" ]] || [[ "$AGENT_CONFIG" == "null" ]]; then
  echo "$(date): Agent type '$AGENT_TYPE' not in loop config, skipping" >> "$DEBUG_LOG"
  exit 0
fi

# Parse agent config
VALIDATION_SCRIPT=$(echo "$AGENT_CONFIG" | jq -r '.validation_script // empty')
MAX_ITERATIONS_DEFAULT=$(echo "$AGENT_CONFIG" | jq -r '.max_iterations // 10')
PROMISE=$(echo "$AGENT_CONFIG" | jq -r '.promise // "COMPLETE"')
STATE_FILE_SUFFIX=$(echo "$AGENT_CONFIG" | jq -r '.state_file_suffix // "loop.local.md"')

echo "$(date): Agent config - validation=$VALIDATION_SCRIPT, max_iter=$MAX_ITERATIONS_DEFAULT, promise=$PROMISE, state_suffix=$STATE_FILE_SUFFIX" >> "$DEBUG_LOG"

# Build state file path (in CLOSEDLOOP_WORKDIR/$CLOSEDLOOP_STATE_DIR/)
# Exit early if CLOSEDLOOP_WORKDIR is not set - no loop context
if [[ -z "$CLOSEDLOOP_WORKDIR" ]]; then
  echo "$(date): No CLOSEDLOOP_WORKDIR, exiting loop-stop-hook" >> "$DEBUG_LOG"
  exit 0
fi

STATE_FILE="$CLOSEDLOOP_WORKDIR/$CLOSEDLOOP_STATE_DIR/$STATE_FILE_SUFFIX"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "$(date): No active loop - state file not found: $STATE_FILE" >> "$DEBUG_LOG"
  exit 0
fi

# Parse markdown frontmatter from state file
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
PRD_FILE=$(echo "$FRONTMATTER" | grep '^prd_file:' | sed 's/prd_file: *//' | sed 's/^"\(.*\)"$/\1/')
WORKDIR=$(echo "$FRONTMATTER" | grep '^workdir:' | sed 's/workdir: *//' | sed 's/^"\(.*\)"$/\1/')

# Default workdir to current directory if not set
WORKDIR="${WORKDIR:-.}"

# Use default max_iterations if not in state file
MAX_ITERATIONS="${MAX_ITERATIONS:-$MAX_ITERATIONS_DEFAULT}"

# Validate numeric fields
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Loop: State file corrupted (invalid iteration)" >&2
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Loop: State file corrupted (invalid max_iterations)" >&2
  exit 0
fi

# Check if max iterations reached
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "Loop: Max iterations ($MAX_ITERATIONS) reached."
  exit 0
fi

# Get agent transcript path from hook input
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.agent_transcript_path // .transcript_path')

echo "$(date): Using transcript: $TRANSCRIPT_PATH" >> "$DEBUG_LOG"

if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "$(date): Transcript file not found: $TRANSCRIPT_PATH" >> "$DEBUG_LOG"
  echo "Loop: Transcript file not found" >&2
  exit 0
fi

echo "$(date): Transcript exists, checking content..." >> "$DEBUG_LOG"

# Check for completion promise in last assistant message
if grep -q '"role":"assistant"' "$TRANSCRIPT_PATH"; then
  LAST_LINE=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" | tail -1)
  LAST_OUTPUT=$(echo "$LAST_LINE" | jq -r '
    .message.content |
    map(select(.type == "text")) |
    map(.text) |
    join("\n")
  ' 2>/dev/null || echo "")

  # Check for completion promise
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")

  if [[ "$PROMISE_TEXT" == "$PROMISE" ]]; then
    # Run validation to confirm
    VALIDATE_SCRIPT="$SCRIPT_DIR/$VALIDATION_SCRIPT"
    if [[ -f "$VALIDATE_SCRIPT" ]]; then
      VALIDATION_RESULT=$("$VALIDATE_SCRIPT" "$PRD_FILE" "$WORKDIR" 2>&1) || true

      if echo "$VALIDATION_RESULT" | grep -q "VALIDATION: PASS"; then
        echo "Loop: Validation passed!"
        exit 0
      else
        echo "Loop: Promise detected but validation failed. Continuing iteration."
      fi
    else
      # No validation script - trust the promise
      echo "Loop: Promise fulfilled (no validation script)"
      exit 0
    fi
  fi
fi

# Run validation script if exists
VALIDATE_SCRIPT="$SCRIPT_DIR/$VALIDATION_SCRIPT"
if [[ -n "$VALIDATION_SCRIPT" ]] && [[ -f "$VALIDATE_SCRIPT" ]]; then
  echo "$(date): Running validation: $VALIDATE_SCRIPT $PRD_FILE $WORKDIR" >> "$DEBUG_LOG"
  VALIDATION_RESULT=$("$VALIDATE_SCRIPT" "$PRD_FILE" "$WORKDIR" 2>&1) || true
  echo "$(date): Validation result: $VALIDATION_RESULT" >> "$DEBUG_LOG"

  # Check if validation passed
  if echo "$VALIDATION_RESULT" | grep -q "VALIDATION: PASS"; then
    echo "$(date): Validation passed, allowing exit" >> "$DEBUG_LOG"
    echo "Loop: Validation passed!"
    exit 0
  fi
else
  VALIDATION_RESULT="No validation script configured"
fi

echo "$(date): Validation failed, will block and continue loop" >> "$DEBUG_LOG"

# Validation failed - continue loop
NEXT_ITERATION=$((ITERATION + 1))

# Extract original prompt from state file
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")

if [[ -z "$PROMPT_TEXT" ]]; then
  echo "Loop: State file missing prompt" >&2
  exit 0
fi

# Update iteration in state file
TEMP_FILE="${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# Build feedback message
SYSTEM_MSG="Loop iteration $NEXT_ITERATION/$MAX_ITERATIONS

VALIDATION FEEDBACK:
$VALIDATION_RESULT

Address ALL issues above. Output <promise>$PROMISE</promise> ONLY when all checks pass."

# Output JSON to block stop and continue iteration
BLOCK_JSON=$(jq -n \
  --arg prompt "$PROMPT_TEXT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }')

echo "$(date): Outputting block JSON: $BLOCK_JSON" >> "$DEBUG_LOG"
BLOCKING=true
echo "$BLOCK_JSON"

exit 0
