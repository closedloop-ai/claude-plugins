#!/bin/bash
# command-telemetry-complete.sh - Finalize per-command telemetry state.
#
# Re-resolves the working directory using the same precedence chain as
# command-telemetry-init.sh, reads .cmd-state.env to recover the start time
# and run ID, computes the elapsed duration, emits a `command_complete` event
# via emit_perf_event from telemetry-helpers.sh, and cleans up the state file.
#
# Fail-open contract: each failure point logs to stderr and continues rather
# than aborting the caller.
#
# Usage:
#   bash command-telemetry-complete.sh [exit_status] [workdir]
#
# Arguments:
#   $1  exit status of the command (optional, default 0)
#   $2  workdir override (optional)
#
# Workdir precedence:
#   $2 argument > $CLOSEDLOOP_WORKDIR env > .closedloop-ai/telemetry/ under PWD

# --- Argument handling ---

_clc_exit_status="${1:-0}"
# Validate that exit_status is a non-negative integer; fall back to 0
if ! [[ "$_clc_exit_status" =~ ^[0-9]+$ ]]; then
  echo "[command-telemetry-complete] WARNING: invalid exit_status '$_clc_exit_status'; defaulting to 0" >&2
  _clc_exit_status=0
fi

# --- Workdir resolution (precedence: arg > env > project-default) ---

_clc_resolved_workdir=""

if [[ -n "${2:-}" ]]; then
  _clc_resolved_workdir="$2"
elif [[ -n "${CLOSEDLOOP_WORKDIR:-}" ]]; then
  _clc_resolved_workdir="$CLOSEDLOOP_WORKDIR"
else
  _clc_resolved_workdir="${PWD}/.closedloop-ai/telemetry"
fi

# --- Read .cmd-state.env ---

_clc_state_file="${_clc_resolved_workdir}/.cmd-state.env"

if [[ ! -f "$_clc_state_file" ]]; then
  echo "[command-telemetry-complete] WARNING: state file not found: $_clc_state_file; skipping telemetry" >&2
  unset _clc_exit_status _clc_resolved_workdir _clc_state_file
  exit 0
fi

# Read values directly to avoid polluting the environment with sourced vars
_clc_cmd_start=""
_clc_run_id=""
_clc_command=""
while IFS='=' read -r _clc_key _clc_val; do
  case "$_clc_key" in
    CLOSEDLOOP_CMD_START) _clc_cmd_start="$_clc_val" ;;
    CLOSEDLOOP_RUN_ID)    _clc_run_id="$_clc_val" ;;
    CLOSEDLOOP_COMMAND)   _clc_command="$_clc_val" ;;
  esac
done < "$_clc_state_file"
unset _clc_key _clc_val

# --- Compute duration ---

_clc_end_epoch=$(date +%s 2>/dev/null || echo "")
_clc_duration_s=0

if [[ -z "$_clc_end_epoch" ]]; then
  echo "[command-telemetry-complete] WARNING: could not get current epoch time; duration will be 0" >&2
elif [[ -z "$_clc_cmd_start" ]]; then
  echo "[command-telemetry-complete] WARNING: CLOSEDLOOP_CMD_START not found in state file; duration will be 0" >&2
else
  # Convert ISO 8601 start timestamp to epoch seconds
  # Try GNU date first, then BSD date (macOS)
  _clc_start_epoch=""
  _clc_start_epoch=$(date -u -d "$_clc_cmd_start" +%s 2>/dev/null || true)
  if [[ -z "$_clc_start_epoch" ]]; then
    # BSD date (macOS): requires -j -f format
    _clc_start_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$_clc_cmd_start" +%s 2>/dev/null || true)
  fi

  if [[ -z "$_clc_start_epoch" ]]; then
    echo "[command-telemetry-complete] WARNING: could not parse start timestamp '$_clc_cmd_start'; duration will be 0" >&2
  else
    _clc_duration_s=$(( _clc_end_epoch - _clc_start_epoch ))
    # Guard against negative duration (e.g. clock skew)
    if [[ "$_clc_duration_s" -lt 0 ]]; then
      echo "[command-telemetry-complete] WARNING: computed negative duration ($_clc_duration_s s); clamping to 0" >&2
      _clc_duration_s=0
    fi
  fi
  unset _clc_start_epoch
fi

# --- Clean up state file ---

if ! rm -f "$_clc_state_file" 2>/dev/null; then
  echo "[command-telemetry-complete] WARNING: could not remove state file: $_clc_state_file" >&2
fi

# --- Source telemetry helpers ---

_clc_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
_clc_helpers="${_clc_scripts_dir}/telemetry-helpers.sh"

if [[ ! -f "$_clc_helpers" ]]; then
  echo "[command-telemetry-complete] WARNING: telemetry-helpers.sh not found at: $_clc_helpers; skipping event emit" >&2
  unset _clc_exit_status _clc_resolved_workdir _clc_state_file _clc_cmd_start _clc_run_id
  unset _clc_command _clc_end_epoch _clc_duration_s _clc_scripts_dir _clc_helpers
  exit 0
fi

# shellcheck source=telemetry-helpers.sh
if ! source "$_clc_helpers" 2>/dev/null; then
  echo "[command-telemetry-complete] WARNING: failed to source telemetry-helpers.sh; skipping event emit" >&2
  unset _clc_exit_status _clc_resolved_workdir _clc_state_file _clc_cmd_start _clc_run_id
  unset _clc_command _clc_end_epoch _clc_duration_s _clc_scripts_dir _clc_helpers
  exit 0
fi

# --- Set env vars required by emit_perf_event ---

# emit_perf_event reads CLOSEDLOOP_WORKDIR and CLOSEDLOOP_COMMAND from the environment
export CLOSEDLOOP_WORKDIR="${_clc_resolved_workdir}"
export CLOSEDLOOP_COMMAND="${_clc_command:-${CLOSEDLOOP_COMMAND:-unknown}}"

# --- Emit command_complete event ---

_clc_run_id_value="${_clc_run_id:-${CLOSEDLOOP_RUN_ID:-}}"
_clc_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

_clc_event_json=$(jq -n -c \
  --arg event "command_complete" \
  --arg run_id "$_clc_run_id_value" \
  --arg command "${CLOSEDLOOP_COMMAND}" \
  --argjson duration_s "$_clc_duration_s" \
  --argjson exit_status "$_clc_exit_status" \
  --arg ended_at "$_clc_ended_at" \
  '{event:$event,run_id:$run_id,command:$command,duration_s:$duration_s,exit_status:$exit_status,ended_at:$ended_at}' \
  2>/dev/null || true)

if [[ -z "$_clc_event_json" ]]; then
  echo "[command-telemetry-complete] WARNING: could not build event JSON; skipping event emit" >&2
else
  if ! emit_perf_event "$_clc_event_json" 2>/dev/null; then
    echo "[command-telemetry-complete] WARNING: emit_perf_event failed; event may not have been recorded" >&2
  fi
fi

# --- Cleanup local vars ---

unset _clc_exit_status _clc_resolved_workdir _clc_state_file _clc_cmd_start _clc_run_id
unset _clc_command _clc_end_epoch _clc_duration_s _clc_scripts_dir _clc_helpers
unset _clc_run_id_value _clc_ended_at _clc_event_json
