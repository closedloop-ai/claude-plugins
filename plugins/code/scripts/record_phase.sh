#!/bin/bash
# record_phase.sh - Append a phase event to perf.jsonl from the current state.json.
#
# Called by the orchestrator after every state.json write so workflow.json
# can derive per-phase wall-clock timings.
#
# Usage:
#   bash record_phase.sh [WORKDIR]
# WORKDIR defaults to $CLOSEDLOOP_WORKDIR.

set -euo pipefail

WORKDIR="${1:-${CLOSEDLOOP_WORKDIR:-}}"
if [[ -z "$WORKDIR" ]]; then
  echo "record_phase.sh: WORKDIR required (pass as $1 or set CLOSEDLOOP_WORKDIR)" >&2
  exit 1
fi

STATE_FILE="$WORKDIR/state.json"
PERF_FILE="$WORKDIR/perf.jsonl"

if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

PHASE=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
STATUS=$(jq -r '.status // ""' "$STATE_FILE" 2>/dev/null || echo "")
START_SHA=$(jq -r '.startSha // ""' "$STATE_FILE" 2>/dev/null || echo "")

if [[ -z "$PHASE" ]]; then
  exit 0
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_ID="${CLOSEDLOOP_RUN_ID:-unknown}"
ITERATION="${CLOSEDLOOP_ITERATION:-0}"

mkdir -p "$(dirname "$PERF_FILE")"

jq -n -c \
  --arg event "phase" \
  --arg run_id "$RUN_ID" \
  --argjson iteration "$ITERATION" \
  --arg phase "$PHASE" \
  --arg status "$STATUS" \
  --arg start_sha "$START_SHA" \
  --arg started_at "$TIMESTAMP" \
  '{event:$event,run_id:$run_id,iteration:$iteration,phase:$phase,status:$status,start_sha:$start_sha,started_at:$started_at}' \
  >> "$PERF_FILE"
