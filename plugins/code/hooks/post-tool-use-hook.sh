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
    "OK=\(if (.tool_response | type) != "object" then "true" elif (.tool_response.error != null and .tool_response.error != "") or .tool_response.success == false then "false" else "true" end)"
' <<< "$INPUT")"

# Resolve tool-call correlation id, mirroring pre-tool-use-hook.sh. Prefer
# `tool_use_id`, fall back to `tool_call_id`. If neither is present we cannot
# safely correlate this post-hook with its pre-hook sentinel, and a counter
# fallback would race under parallel tool invocations (this post may pick up
# a counter that's already been advanced by a later pre-hook). Skip silently.
if [[ -z "$TOOL_USE_ID" ]]; then
    TOOL_USE_ID="$TOOL_CALL_ID"
fi
if [[ -z "$TOOL_USE_ID" ]]; then
    exit 0
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

# Read all fields from sentinel in a single jq invocation. The sentinel was
# written at call-time by pre-tool-use-hook.sh and is the authoritative source
# for attribution — the env vars (CLOSEDLOOP_RUN_ID, _COMMAND, _ITERATION) can
# drift between pre and post (e.g., iteration advancing mid-call), so prefer
# sentinel fields and fall back to env only when sentinel fields are missing.
eval "$(jq -r '
    @sh "STARTED_AT=\(.started_at // empty)",
    @sh "SENTINEL_TOOL_NAME=\(.tool_name // empty)",
    @sh "SENTINEL_AGENT_ID=\(.agent_id // empty)",
    @sh "SENTINEL_RUN_ID=\(.run_id // empty)",
    @sh "SENTINEL_COMMAND=\(.command // empty)",
    @sh "SENTINEL_ITERATION=\(.iteration // empty)"
' "$SENTINEL_FILE" 2>/dev/null || echo "")"

# Defense-in-depth: if the sentinel file existed but parsed to nothing useful
# (corrupt JSON, missing required fields), skip emission entirely. Emitting
# `started_at: ""` with `duration_s: 0` would pollute Datadog with a record
# that looks valid but carries no real timing information.
if [[ -z "${STARTED_AT:-}" ]]; then
    rm -f "$SENTINEL_FILE"
    exit 0
fi

# Use sentinel values as authoritative source; fall back to hook input or env.
TOOL_NAME="${SENTINEL_TOOL_NAME:-$TOOL_NAME}"
AGENT_ID="${SENTINEL_AGENT_ID:-$AGENT_ID}"
RUN_ID="${SENTINEL_RUN_ID:-${CLOSEDLOOP_RUN_ID:-unknown}}"
COMMAND="${SENTINEL_COMMAND:-${CLOSEDLOOP_COMMAND:-interactive}}"

# Sanitize iteration (sentinel or env) before --argjson to prevent jq abort
# on non-numeric input.
ITERATION="${SENTINEL_ITERATION:-${CLOSEDLOOP_ITERATION:-0}}"
if ! [[ "$ITERATION" =~ ^[0-9]+$ ]]; then
    ITERATION=0
fi

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

# Append tool event to perf.jsonl. Attribution fields (run_id/command/iteration)
# come from the sentinel — see sentinel-parse block above for the rationale.
PERF_FILE="$CLOSEDLOOP_WORKDIR/perf.jsonl"
jq -n -c \
    --arg event "tool" \
    --arg run_id "$RUN_ID" \
    --arg command "$COMMAND" \
    --argjson iteration "$ITERATION" \
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
    # Extract skill_name: prefer tool_input.skill, fall back to tool_input.command.
    # Per Claude Code's Skill tool docs the field is `skill`, but PRD-466 GAP-004
    # noted ambiguity; keeping `command` as a forward-compat fallback.
    SKILL_NAME="${SKILL_INPUT_SKILL:-$SKILL_INPUT_COMMAND}"
    jq -n -c \
        --arg event "skill" \
        --arg run_id "$RUN_ID" \
        --arg command "$COMMAND" \
        --argjson iteration "$ITERATION" \
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
