#!/usr/bin/env bash
# command-telemetry-complete.sh — Telemetry finaliser for slash commands.
#
# Designed to be called (not sourced) by command markdown files at the end of
# a command run to emit a `command_complete` event to perf.jsonl.
#
# Usage:
#   bash "${CLAUDE_PLUGIN_ROOT}/scripts/command-telemetry-complete.sh" [exit_status]
#
# Arguments:
#   $1  EXIT_STATUS (optional, default: 0) — the exit status of the command
#
# Environment variables consumed (set by command-telemetry-init.sh):
#   CLOSEDLOOP_START_TIME  — unix epoch when the command started (required for duration)
#   CLOSEDLOOP_RUN_ID      — unique run identifier
#   CLOSEDLOOP_WORKDIR     — working directory for perf.jsonl output
#   CLOSEDLOOP_COMMAND     — slash command name
#
# Fail-open guarantee: the entire finalisation is wrapped in a trap so any
# error is suppressed and the calling command continues unaffected.

# Fail open: any unexpected error exits 0 so the calling command is unaffected.
trap 'exit 0' ERR

_closedloop_telemetry_complete() {
  local exit_status="${1:-0}"

  # Resolve working directory. The matching command-telemetry-init.sh exports
  # CLOSEDLOOP_WORKDIR, but those exports are scoped to the shell that ran
  # `source` and do not survive across separate Bash tool invocations. When
  # the env var is unset, fall back to the default workdir init.sh uses
  # (.closedloop-ai/telemetry) only if a state file exists there — otherwise
  # the command was never initialised and there is nothing to finalise.
  local workdir="${CLOSEDLOOP_WORKDIR:-}"
  if [[ -z "$workdir" ]]; then
    if [[ -f ".closedloop-ai/telemetry/.cmd-state.env" ]]; then
      workdir=".closedloop-ai/telemetry"
    else
      return 0
    fi
  fi

  # If RUN_ID is missing, recover the run context that init.sh persisted to
  # disk. This bridges the gap between separate Bash tool invocations: init
  # exported env vars but they died with its source shell.
  local state_file="$workdir/.cmd-state.env"
  if [[ -z "${CLOSEDLOOP_RUN_ID:-}" && -f "$state_file" ]]; then
    # shellcheck source=/dev/null
    source "$state_file" 2>/dev/null || true
    workdir="${CLOSEDLOOP_WORKDIR:-$workdir}"
  fi

  local perf_file="$workdir/perf.jsonl"

  # Capture end time
  local end_epoch
  end_epoch=$(date +%s 2>/dev/null) || end_epoch=""
  local ended_at
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ended_at=""

  # Resolve start time and calculate duration
  local start_epoch="${CLOSEDLOOP_START_TIME:-}"
  local started_at=""
  local duration_s=0

  if [[ -n "$start_epoch" && -n "$end_epoch" ]]; then
    duration_s=$(( end_epoch - start_epoch ))
    # Convert start epoch to ISO-8601 timestamp
    started_at=$(date -u -r "$start_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) \
      || started_at=$(date -u -d "@$start_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) \
      || started_at=""
  fi

  local run_id="${CLOSEDLOOP_RUN_ID:-unknown}"
  local command="${CLOSEDLOOP_COMMAND:-interactive}"

  # Ensure perf.jsonl directory exists
  mkdir -p "$(dirname "$perf_file")" 2>/dev/null || true

  # Build and emit the command_complete JSONL event, injecting command: field
  # to match the pattern used by emit_perf_event in telemetry-helpers.sh
  jq -n -c \
    --arg event "command_complete" \
    --arg run_id "$run_id" \
    --arg command "$command" \
    --arg started_at "$started_at" \
    --arg ended_at "$ended_at" \
    --argjson duration_s "$duration_s" \
    --argjson exit_status "$exit_status" \
    '{event:$event,run_id:$run_id,command:$command,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_status:$exit_status}' \
    >> "$perf_file" 2>/dev/null || true

  # Drop the recovered state file so stale state cannot leak into a later
  # command that fails to call init.sh.
  rm -f "$state_file" 2>/dev/null || true
}

_closedloop_telemetry_complete "$@"
exit 0
