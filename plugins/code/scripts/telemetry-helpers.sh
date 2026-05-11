#!/usr/bin/env bash

# telemetry-helpers.sh — Sourceable performance instrumentation helpers
#
# Extracted from run-loop.sh (lines 1248-1325). These functions emit JSONL
# events to perf.jsonl for Datadog / desktop-watcher consumption.
#
# Environment variables consumed (no enclosing-scope globals required):
#   CLOSEDLOOP_RUN_ID      — unique run identifier (falls back to RUN_ID for
#                            backward-compat when sourced inside run-loop.sh)
#   CLOSEDLOOP_ITERATION   — current iteration counter (default: 0)
#   CLOSEDLOOP_WORKDIR     — working directory for perf.jsonl output (default: .)
#   CLOSEDLOOP_COMMAND     — slash command name for event filtering (default: interactive)

# Append a single-line JSON event to perf.jsonl. The `command:` field is added
# to every event row so it can be filtered by slash command in Datadog.
emit_perf_event() {
  local json_line="$1"
  # Empty input → no-op. Two reasons: (1) historically (older jq + set -euo
  # pipefail) an empty stdin to jq propagated a non-zero exit and killed the
  # Loop; (2) even on modern jq (1.8+) which silently exits 0, the resulting
  # blank line would still get appended to perf.jsonl and corrupt downstream
  # JSONL parsers (the desktop watcher emits loop.perf.parse_failure on
  # malformed lines). Any caller that passes empty input has its own bug;
  # this guard prevents either failure mode (FEA-936 fix 2).
  if [[ -z "$json_line" ]]; then
    return 0
  fi
  local perf_file="${CLOSEDLOOP_WORKDIR:-.}/perf.jsonl"
  json_line=$(echo "$json_line" | jq -c --arg command "${CLOSEDLOOP_COMMAND:-interactive}" '. + {command:$command}')
  echo "$json_line" >> "$perf_file"
}

# Run a command with timing, emit a pipeline_step perf event, return original exit code
run_timed_step() {
  local step_num="$1"
  local step_name="$2"
  shift 2
  local step_start_epoch
  step_start_epoch=$(date +%s)
  local step_started_at
  step_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local step_exit=0
  "$@" || step_exit=$?

  local step_end_epoch
  step_end_epoch=$(date +%s)
  local step_ended_at
  step_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local step_duration=$((step_end_epoch - step_start_epoch))

  # Resolve run ID: prefer exported CLOSEDLOOP_RUN_ID, fall back to RUN_ID
  # (set as a shell global when sourced inside run-loop.sh).
  local _run_id="${CLOSEDLOOP_RUN_ID:-${RUN_ID:-}}"

  emit_perf_event "$(jq -n -c \
    --arg event "pipeline_step" \
    --arg run_id "$_run_id" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --argjson step "$step_num" \
    --arg step_name "$step_name" \
    --arg started_at "$step_started_at" \
    --arg ended_at "$step_ended_at" \
    --argjson duration_s "$step_duration" \
    --argjson exit_code "$step_exit" \
    --argjson skipped false \
    '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}'
  )"

  return "$step_exit"
}

# Emit a skipped pipeline_step event
emit_skipped_step() {
  local step_num="$1"
  local step_name="$2"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Resolve run ID: prefer exported CLOSEDLOOP_RUN_ID, fall back to RUN_ID
  # (set as a shell global when sourced inside run-loop.sh).
  local _run_id="${CLOSEDLOOP_RUN_ID:-${RUN_ID:-}}"

  emit_perf_event "$(jq -n -c \
    --arg event "pipeline_step" \
    --arg run_id "$_run_id" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --argjson step "$step_num" \
    --arg step_name "$step_name" \
    --arg started_at "$now" \
    --arg ended_at "$now" \
    --argjson duration_s 0 \
    --argjson exit_code 0 \
    --argjson skipped true \
    '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}'
  )"
}
