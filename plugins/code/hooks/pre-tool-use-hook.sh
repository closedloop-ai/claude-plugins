#!/usr/bin/env bash
# ClosedLoop Performance Tracking - PreToolUse Sentinel Hook
# Writes a sentinel file for each tool call so downstream hooks can compute
# tool-call duration and attribution.
#
# Gated behind CLOSEDLOOP_PERF_V2=1 — no-ops silently when the gate is off.
# Designed to be non-blocking: exits 0 on any failure (fail-open pattern).
#
# Sentinel file location:
#   $CLOSEDLOOP_WORKDIR/.tool-calls/{TOOL_USE_ID}
# Sentinel file contents (JSON):
#   {
#     "started_at": "...",   # ISO-8601 UTC timestamp when the tool call began
#     "tool_name": "...",    # e.g. "Read", "Bash", "Write", "Edit"
#     "agent_id": "...",     # agent identifier from hook input
#     "run_id": "...",       # CLOSEDLOOP_RUN_ID — links sentinel to a loop run
#     "command": "...",      # CLOSEDLOOP_COMMAND — the slash-command that triggered the run
#     "iteration": 0         # CLOSEDLOOP_ITERATION — loop iteration counter (integer)
#   }
# The desktop scanner uses these fields to construct a complete `tool` event with
# ended_at: null, duration_s: null, ok: null for sentinels that were never cleaned
# up by the post-hook (i.e. orphaned tool calls).

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
eval "$(echo "$INPUT" | jq -r '
    @sh "TOOL_NAME=\(.tool_name // empty)",
    @sh "SESSION_ID=\(.session_id // empty)",
    @sh "CWD=\(.cwd // empty)",
    @sh "AGENT_ID=\(.agent_id // empty)",
    @sh "TOOL_USE_ID_RAW=\(.tool_use_id // empty)",
    @sh "TOOL_CALL_ID=\(.tool_call_id // empty)",
    @sh "PLANNED_SUBAGENT_TYPE=\(.tool_input.subagent_type // empty)"
')"

# Resolve a tool-call correlation id. Prefer `tool_use_id` (Claude Code's documented
# field), fall back to `tool_call_id` (PRD spelling). If neither is present we
# cannot safely correlate this pre-hook with its post-hook — a counter-file
# fallback would race under parallel tool invocations (two hooks reading the
# same value, the post hook matching the wrong sentinel) and produce silently
# wrong telemetry. Skip the pre-hook silently in that case; the post-hook will
# also skip, so no orphaned sentinels accumulate.
TOOL_USE_ID="$TOOL_USE_ID_RAW"
if [[ -z "$TOOL_USE_ID" ]]; then
    TOOL_USE_ID="$TOOL_CALL_ID"
fi
if [[ -z "$TOOL_USE_ID" ]]; then
    exit 0
fi

# Sanitize CLOSEDLOOP_ITERATION: must be a non-negative integer or jq's
# --argjson will fail and abort this hook (silently, via `trap exit 0 ERR`),
# losing the sentinel. Default invalid values to 0 — telemetry remains
# attributable to the run even when iteration is unset/malformed.
ITERATION="${CLOSEDLOOP_ITERATION:-0}"
if ! [[ "$ITERATION" =~ ^[0-9]+$ ]]; then
    ITERATION=0
fi

# Discover WORKDIR via session_id mapping (same pattern as pretooluse-hook.sh and subagent-start-hook.sh)
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

# Write sentinel file: $CLOSEDLOOP_WORKDIR/.tool-calls/{TOOL_USE_ID}
TOOL_CALLS_DIR="$CLOSEDLOOP_WORKDIR/.tool-calls"
[[ -d "$TOOL_CALLS_DIR" ]] || mkdir -p "$TOOL_CALLS_DIR"

STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")

jq -n -c \
    --arg started_at "$STARTED_AT" \
    --arg tool_name "${TOOL_NAME:-}" \
    --arg agent_id "${AGENT_ID:-}" \
    --arg run_id "${CLOSEDLOOP_RUN_ID:-}" \
    --arg command "${CLOSEDLOOP_COMMAND:-}" \
    --argjson iteration "$ITERATION" \
    '{started_at:$started_at,tool_name:$tool_name,agent_id:$agent_id,run_id:$run_id,command:$command,iteration:$iteration}' \
    > "$TOOL_CALLS_DIR/$TOOL_USE_ID"

# When the tool being invoked is "Agent", emit a spawn event to perf.jsonl
if [[ "$TOOL_NAME" == "Agent" ]]; then
    PERF_FILE="$CLOSEDLOOP_WORKDIR/perf.jsonl"
    jq -n -c \
        --arg event "spawn" \
        --arg run_id "${CLOSEDLOOP_RUN_ID:-unknown}" \
        --arg command "${CLOSEDLOOP_COMMAND:-interactive}" \
        --argjson iteration "$ITERATION" \
        --arg parent_session_id "${SESSION_ID:-}" \
        --arg parent_agent_id "${AGENT_ID:-}" \
        --arg planned_subagent_type "${PLANNED_SUBAGENT_TYPE:-}" \
        --arg started_at "$STARTED_AT" \
        '{event:$event,run_id:$run_id,command:$command,iteration:$iteration,parent_session_id:$parent_session_id,parent_agent_id:$parent_agent_id,planned_subagent_type:$planned_subagent_type,started_at:$started_at}' \
        >> "$PERF_FILE"
fi

exit 0
