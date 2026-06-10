#!/bin/bash
# record_iteration.sh - Append one synthetic native-command iteration event.
#
# Usage:
#   bash record_iteration.sh [WORKDIR]
# WORKDIR defaults to $CLOSEDLOOP_WORKDIR.

set -euo pipefail

WORKDIR="${1:-${CLOSEDLOOP_WORKDIR:-}}"
if [[ -z "$WORKDIR" ]]; then
  echo "record_iteration.sh: WORKDIR required (pass as $1 or set CLOSEDLOOP_WORKDIR)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=closedloop_env.sh
source "$SCRIPT_DIR/closedloop_env.sh"

CONFIG_FILE="$WORKDIR/.closedloop-ai/config.env"
load_closedloop_env "$CONFIG_FILE"

PERF_FILE="$WORKDIR/perf.jsonl"
STATE_FILE="$WORKDIR/state.json"

RUN_ID="${CLOSEDLOOP_RUN_ID:-unknown}"
ITERATION="${CLOSEDLOOP_ITERATION:-0}"
COMMAND="${CLOSEDLOOP_COMMAND:-interactive}"
STATUS="ok"
CLAUDE_EXIT_CODE=0

if [[ -f "$STATE_FILE" ]]; then
  STATE_STATUS=$(jq -r '.status // ""' "$STATE_FILE" 2>/dev/null || echo "")
  if [[ "$STATE_STATUS" != "COMPLETED" ]]; then
    STATUS="error"
    CLAUDE_EXIT_CODE=1
  fi
else
  # A missing state.json means the session never recorded completion — treat
  # it as an error rather than silently emitting a success iteration event.
  STATUS="error"
  CLAUDE_EXIT_CODE=1
fi

ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END_EPOCH=$(date +%s)
STARTED_AT="$ENDED_AT"
START_EPOCH="$END_EPOCH"

if [[ -f "$PERF_FILE" ]]; then
  RUN_STARTED_AT=$(jq -r --arg run_id "$RUN_ID" 'select(.event == "run" and .run_id == $run_id) | .started_at // empty' "$PERF_FILE" 2>/dev/null | head -n1 || true)
  if [[ -n "$RUN_STARTED_AT" ]]; then
    STARTED_AT="$RUN_STARTED_AT"
    if date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$RUN_STARTED_AT" +%s >/dev/null 2>&1; then
      START_EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$RUN_STARTED_AT" +%s)
    elif date -d "$RUN_STARTED_AT" +%s >/dev/null 2>&1; then
      START_EPOCH=$(date -d "$RUN_STARTED_AT" +%s)
    fi
  fi
fi

DURATION_S=$((END_EPOCH - START_EPOCH))
if [[ "$DURATION_S" -lt 0 ]]; then
  DURATION_S=0
fi

mkdir -p "$(dirname "$PERF_FILE")"

jq -n -c \
  --arg event "iteration" \
  --arg run_id "$RUN_ID" \
  --argjson iteration "$ITERATION" \
  --arg started_at "$STARTED_AT" \
  --arg ended_at "$ENDED_AT" \
  --argjson duration_s "$DURATION_S" \
  --argjson claude_exit_code "$CLAUDE_EXIT_CODE" \
  --arg status "$STATUS" \
  --arg command "$COMMAND" \
  '{event:$event,run_id:$run_id,iteration:$iteration,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,claude_exit_code:$claude_exit_code,status:$status,command:$command}' \
  >> "$PERF_FILE"
