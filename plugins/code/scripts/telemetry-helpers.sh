#!/bin/bash

# Shared telemetry helpers — sourced by run-loop.sh and command-telemetry-complete.sh.
# Also copied into the bootstrap, code-review, and self-learning plugins via
# scripts/sync-shared-telemetry.sh. Do not execute directly.

# ---------------------------------------------------------------------------
# Canonical command-name mapping table
#
# The `command:` field in every perf event (set via CLOSEDLOOP_COMMAND) uses
# an underscored canonical name so Datadog queries, dashboards, and facets
# stay stable regardless of how the slash command is spelled in Claude Code.
#
# Slash command               → CLOSEDLOOP_COMMAND value (canonical name)
# -----------------------------------------------------------------------
# /code:code                  → code
# /code:amend-plan            → amend_plan
# /code:cancel-code           → cancel_code
# /code:plan-with-codex       → plan_with_codex
# /bootstrap:agent-bootstrap  → agent_bootstrap
# /code-review:start          → code_review
# /self-learning:export-closedloop-learnings → export_closedloop_learnings
# /self-learning:goal-stats               → goal_stats
# /self-learning:process-learnings        → process_learnings
# /self-learning:prune-learnings          → prune_learnings
# /self-learning:pull-learnings           → pull_learnings
# /self-learning:push-learnings           → push_learnings
#
# Convention for future commands:
#   Replace hyphens with underscores in the command file basename and prefix
#   with the plugin name only when there would otherwise be a collision.
#   Interactive / unknown invocations use the sentinel value "interactive".
# ---------------------------------------------------------------------------

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

# Internal: emit a pipeline_step perf event with all fields.
_emit_pipeline_step() {
  local step_num="$1" step_name="$2" started_at="$3" ended_at="$4"
  local duration_s="$5" exit_code="$6" skipped="$7"
  emit_perf_event "$(jq -n -c \
    --arg event "pipeline_step" \
    --arg run_id "$RUN_ID" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --argjson step "$step_num" \
    --arg step_name "$step_name" \
    --arg started_at "$started_at" \
    --arg ended_at "$ended_at" \
    --argjson duration_s "$duration_s" \
    --argjson exit_code "$exit_code" \
    --argjson skipped "$skipped" \
    '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}'
  )"
}

# Run a command with timing, emit a pipeline_step perf event, return original exit code
run_timed_step() {
  local step_num="$1"
  local step_name="$2"
  shift 2
  local step_start_epoch step_started_at step_exit=0
  step_start_epoch=$(date +%s)
  step_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  "$@" || step_exit=$?

  local step_end_epoch step_ended_at
  step_end_epoch=$(date +%s)
  step_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  _emit_pipeline_step "$step_num" "$step_name" "$step_started_at" "$step_ended_at" \
    "$((step_end_epoch - step_start_epoch))" "$step_exit" false

  return "$step_exit"
}

# Emit a skipped pipeline_step event
emit_skipped_step() {
  local step_num="$1"
  local step_name="$2"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  _emit_pipeline_step "$step_num" "$step_name" "$now" "$now" 0 0 true
}
