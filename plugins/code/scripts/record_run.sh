#!/bin/bash
# record_run.sh - Append a run event to perf.jsonl once per Loop.
#
# Emits exactly one `run` event containing command, repo, branch, and start
# time so every perf.jsonl record can be attributed to the slash-command that
# launched the Loop.
#
# Gated behind CLOSEDLOOP_PERF_V2=1 — no-ops silently when the gate is off.
# Designed to be non-blocking: exits 0 on any failure.
#
# Usage:
#   bash record_run.sh [WORKDIR]
# WORKDIR defaults to $CLOSEDLOOP_WORKDIR.

# Fail open: any unexpected error exits 0 so the caller loop is unaffected.
trap 'exit 0' ERR

# Gate: only run when CLOSEDLOOP_PERF_V2=1
if [[ "${CLOSEDLOOP_PERF_V2:-}" != "1" ]]; then
  exit 0
fi

WORKDIR="${1:-${CLOSEDLOOP_WORKDIR:-}}"
if [[ -z "$WORKDIR" ]]; then
  exit 0
fi

PERF_FILE="$WORKDIR/perf.jsonl"

RUN_ID="${CLOSEDLOOP_RUN_ID:-unknown}"
COMMAND="${CLOSEDLOOP_COMMAND:-interactive}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

# Capture repo and branch via git -C with a timeout to prevent hangs.
REPO=$(timeout 5 git -C "$WORKDIR" remote get-url origin 2>/dev/null || echo "")
BRANCH=$(timeout 5 git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

mkdir -p "$(dirname "$PERF_FILE")"

jq -n -c \
  --arg event "run" \
  --arg run_id "$RUN_ID" \
  --arg command "$COMMAND" \
  --arg started_at "$TIMESTAMP" \
  --arg repo "$REPO" \
  --arg branch "$BRANCH" \
  '{event:$event,run_id:$run_id,command:$command,started_at:$started_at,repo:$repo,branch:$branch}' \
  >> "$PERF_FILE"

exit 0
