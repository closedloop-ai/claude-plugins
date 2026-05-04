#!/usr/bin/env bash
# record_run.sh - Append a "run" event to perf.jsonl when a loop run starts.
#
# Emits a single JSON line so perf_summary.py and downstream analytics can
# correlate per-run metadata (command, resume flag, workdir) with iteration
# and pipeline_step events that share the same run_id.
#
# Usage:
#   bash record_run.sh <run_id> <command> <resume> <workdir>
#
# Arguments (all positional):
#   run_id   - Unique run identifier (e.g. "20240101-120000-abcd1234")
#   command  - Slash-command string passed to Claude (e.g. "/code:code")
#   resume   - "true" or "false" — whether this is a resumed run
#   workdir  - Absolute path to the CLOSEDLOOP_WORKDIR directory
#
# The JSON line is appended to $workdir/perf.jsonl.
# This script is fail-open: any missing argument or write failure silently
# exits 0 so telemetry never blocks the main loop.

# Intentionally NOT using set -euo pipefail — this script is fail-open.

RUN_ID="${1:-}"
COMMAND="${2:-}"
RESUME_RAW="${3:-}"
WORKDIR="${4:-}"

# Fail-open: exit 0 silently if required arguments are missing
if [[ -z "$RUN_ID" || -z "$WORKDIR" ]]; then
  exit 0
fi

PERF_FILE="$WORKDIR/perf.jsonl"

# Normalise resume to a JSON boolean
if [[ "$RESUME_RAW" == "true" ]]; then
  RESUME_BOOL=true
else
  RESUME_BOOL=false
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

mkdir -p "$(dirname "$PERF_FILE")" 2>/dev/null || true

jq -n -c \
  --arg event "run" \
  --arg run_id "$RUN_ID" \
  --arg command "$COMMAND" \
  --argjson resume "$RESUME_BOOL" \
  --arg timestamp "$TIMESTAMP" \
  --arg workdir "$WORKDIR" \
  '{event:$event,run_id:$run_id,command:$command,resume:$resume,timestamp:$timestamp,workdir:$workdir}' \
  >> "$PERF_FILE" 2>/dev/null || true
