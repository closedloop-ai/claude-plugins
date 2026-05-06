#!/usr/bin/env bash
# ClosedLoop Performance Tracking - PostToolUse Sentinel Hook
# Reads the sentinel file written by pre-tool-use-hook.sh, computes tool-call
# duration, and appends a "tool" event to perf.jsonl.
#
# Gated behind CLOSEDLOOP_PERF_V2=1 — no-ops silently when the gate is off.
# Designed to be non-blocking: exits 0 on any failure (fail-open pattern).
#
# Sentinel file location (written by pre-tool-use-hook.sh):
#   $CLOSEDLOOP_WORKDIR/.tool-calls/{TOOL_USE_ID}
# perf.jsonl event fields:
#   event, run_id, command, iteration, agent_id, tool_name,
#   started_at, ended_at, duration_s, ok

# Fail open: any unexpected error exits 0 so the caller is unaffected.
trap 'exit 0' ERR

# Gate: only run when CLOSEDLOOP_PERF_V2=1
if [[ "${CLOSEDLOOP_PERF_V2:-}" != "1" ]]; then
    exit 0
fi

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

# Read hook input from stdin (JSON)
INPUT=$(</dev/stdin)

# Parse all hook input fields in a single jq invocation
eval "$(jq -r '
    @sh "TOOL_NAME=\(.tool_name // empty)",
    @sh "SESSION_ID=\(.session_id // empty)",
    @sh "CWD=\(.cwd // empty)",
    @sh "AGENT_ID=\(.agent_id // empty)",
    @sh "TOOL_USE_ID=\(.tool_use_id // empty)",
    @sh "TOOL_CALL_ID=\(.tool_call_id // empty)",
    @sh "SKILL_INPUT_SKILL=\(.tool_input.skill // empty)",
    @sh "SKILL_INPUT_COMMAND=\(.tool_input.command // empty)",
    "OK=\(if (.tool_response // {}) | ((.error != null and .error != "") or .success == false) then "false" else "true" end)"
' <<< "$INPUT")"

# Extract tool_use_id with fallback chain (mirrors pre-tool-use-hook.sh):
#   1. tool_use_id
#   2. tool_call_id
#   3. monotonic counter file in .closedloop-ai/
if [[ -z "$TOOL_USE_ID" ]]; then
    TOOL_USE_ID="$TOOL_CALL_ID"
fi
if [[ -z "$TOOL_USE_ID" ]]; then
    # Monotonic counter fallback: read the current counter value (do NOT increment —
    # the pre-tool-use hook already incremented it, so we just read the same value).
    COUNTER_FILE="${CWD:-.}/$CLOSEDLOOP_STATE_DIR/.tool-call-counter"
    COUNTER=0
    if [[ -f "$COUNTER_FILE" ]]; then
        COUNTER=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
    fi
    TOOL_USE_ID="counter-$COUNTER"
fi

# Discover WORKDIR via session_id mapping (same pattern as pre-tool-use-hook.sh)
CLOSEDLOOP_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
    WORKDIR_FILE="${CWD:-.}/$CLOSEDLOOP_STATE_DIR/session-$SESSION_ID.workdir"
    if [[ -f "$WORKDIR_FILE" ]]; then
        CLOSEDLOOP_WORKDIR=$(cat "$WORKDIR_FILE")
    fi
fi

# Exit early if not in a closedloop session
if [[ -z "$CLOSEDLOOP_WORKDIR" ]]; then
    exit 0
fi

# Locate the sentinel file written by pre-tool-use-hook.sh
TOOL_CALLS_DIR="$CLOSEDLOOP_WORKDIR/.tool-calls"
SENTINEL_FILE="$TOOL_CALLS_DIR/$TOOL_USE_ID"

# Exit early if no sentinel exists (pre-hook may not have fired for this tool)
if [[ ! -f "$SENTINEL_FILE" ]]; then
    exit 0
fi

# Read all fields from sentinel in a single jq invocation
eval "$(jq -r '
    @sh "STARTED_AT=\(.started_at // empty)",
    @sh "SENTINEL_TOOL_NAME=\(.tool_name // empty)",
    @sh "SENTINEL_AGENT_ID=\(.agent_id // empty)"
' "$SENTINEL_FILE" 2>/dev/null || echo "")"

# Use sentinel values as authoritative source (they were set at call time);
# fall back to hook input fields if sentinel fields are missing.
TOOL_NAME="${SENTINEL_TOOL_NAME:-$TOOL_NAME}"
AGENT_ID="${SENTINEL_AGENT_ID:-$AGENT_ID}"

# Capture end time: get epoch first, then derive ISO timestamp to avoid skew
END_EPOCH=$(date +%s)
if [[ "$OSTYPE" == darwin* ]]; then
    ENDED_AT=$(date -r "$END_EPOCH" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
else
    ENDED_AT=$(date -u -d "@$END_EPOCH" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
fi

# Compute duration_s
DURATION_S=0
if [[ -n "$STARTED_AT" ]] && [[ -n "$ENDED_AT" ]]; then
    if [[ "$OSTYPE" == darwin* ]]; then
        START_EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" "+%s" 2>/dev/null || echo "")
    else
        START_EPOCH=$(date -u -d "$STARTED_AT" "+%s" 2>/dev/null || echo "")
    fi
    if [[ -n "$START_EPOCH" ]]; then
        DURATION_S=$(( END_EPOCH - START_EPOCH ))
    fi
fi

# Append tool event to perf.jsonl
PERF_FILE="$CLOSEDLOOP_WORKDIR/perf.jsonl"
jq -n -c \
    --arg event "tool" \
    --arg run_id "${CLOSEDLOOP_RUN_ID:-unknown}" \
    --arg command "${CLOSEDLOOP_COMMAND:-interactive}" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --arg agent_id "${AGENT_ID:-}" \
    --arg tool_name "${TOOL_NAME:-}" \
    --arg started_at "${STARTED_AT:-}" \
    --arg ended_at "${ENDED_AT:-}" \
    --argjson duration_s "$DURATION_S" \
    --argjson ok "$OK" \
    '{event:$event,run_id:$run_id,command:$command,iteration:$iteration,agent_id:$agent_id,tool_name:$tool_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,ok:$ok}' \
    >> "$PERF_FILE"

# When the tool is "Skill", additionally append a "skill" event to perf.jsonl
if [[ "$TOOL_NAME" == "Skill" ]]; then
    # Extract skill_name: prefer tool_input.skill, fall back to tool_input.command
    SKILL_NAME="${SKILL_INPUT_SKILL:-$SKILL_INPUT_COMMAND}"
    jq -n -c \
        --arg event "skill" \
        --arg run_id "${CLOSEDLOOP_RUN_ID:-unknown}" \
        --arg command "${CLOSEDLOOP_COMMAND:-interactive}" \
        --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
        --arg agent_id "${AGENT_ID:-}" \
        --arg tool_name "${TOOL_NAME:-}" \
        --arg skill_name "${SKILL_NAME:-}" \
        --arg started_at "${STARTED_AT:-}" \
        --arg ended_at "${ENDED_AT:-}" \
        --argjson duration_s "$DURATION_S" \
        --argjson ok "$OK" \
        '{event:$event,run_id:$run_id,command:$command,iteration:$iteration,agent_id:$agent_id,tool_name:$tool_name,skill_name:$skill_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,ok:$ok}' \
        >> "$PERF_FILE"
fi

# Delete sentinel file after successful emission
rm -f "$SENTINEL_FILE"

exit 0
