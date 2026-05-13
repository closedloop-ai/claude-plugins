#!/bin/bash

# AUTO-GENERATED — DO NOT EDIT.
# Source: plugins/code/scripts/command-telemetry-init.sh
# Run scripts/sync-shared-telemetry.sh to update.

# command-telemetry-init.sh - Initialize per-command telemetry state.
#
# Resolves the working directory, generates a run ID, persists state to
# .cmd-state.env, exports CLOSEDLOOP_COMMAND and CLOSEDLOOP_RUN_ID, and
# calls record_run.sh to emit the `run` event.
#
# Fail-open contract: each failure point logs to stderr and continues rather
# than aborting the caller. Individual failures are surfaced via stderr so
# operators can diagnose issues without the caller being blocked.
#
# Usage (must be sourced so exported vars propagate to the caller):
#   source command-telemetry-init.sh <command-name> [workdir]
#
# Arguments:
#   $1  canonical command name (required)
#   $2  workdir override (optional)
#
# Workdir precedence:
#   $2 argument > $CLOSEDLOOP_WORKDIR env > .closedloop-ai/telemetry/ under PWD
#
# Concurrency note (v1.12.0 known limitation):
#   Concurrent slash commands in the same project share a single .cmd-state.env
#   and .last-cmd-state sidecar. Under concurrent execution, the last init wins
#   and the previous state is overwritten. Telemetry under concurrent commands
#   is therefore best-effort. Fixing this would require per-run-ID state files
#   and a matching strategy in complete.sh (which runs from the Stop hook and
#   does not receive a run ID). Deferred beyond PLN-561 scope.

# --- Argument handling ---

_cl_command_name="${1:-}"
if [[ -z "$_cl_command_name" ]]; then
  echo "[command-telemetry-init] ERROR: command name argument is required" >&2
  # Fail open: do not abort caller
  unset _cl_command_name
  return 0 2>/dev/null || exit 0
fi

# --- Workdir resolution (precedence: arg > env > project-default) ---

_cl_resolved_workdir=""

if [[ -n "${2:-}" ]]; then
  _cl_resolved_workdir="$2"
elif [[ -n "${CLOSEDLOOP_WORKDIR:-}" ]]; then
  _cl_resolved_workdir="$CLOSEDLOOP_WORKDIR"
else
  _cl_resolved_workdir="${PWD}/.closedloop-ai/telemetry"
fi

# Ensure workdir exists
if ! mkdir -p "$_cl_resolved_workdir" 2>/dev/null; then
  echo "[command-telemetry-init] ERROR: could not create workdir: $_cl_resolved_workdir" >&2
  unset _cl_command_name _cl_resolved_workdir
  return 0 2>/dev/null || exit 0
fi

# --- Run ID generation ---

_cl_run_id=""
if command -v uuidgen >/dev/null 2>&1; then
  _cl_run_id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
fi

if [[ -z "$_cl_run_id" ]]; then
  # Fallback matching the pattern used by generate_run_id in run-loop.sh
  _cl_run_id="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo "00000000-000000")-$(head -c 4 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || printf '%08x' "$$")"
fi

if [[ -z "$_cl_run_id" ]]; then
  echo "[command-telemetry-init] ERROR: could not generate run ID" >&2
  unset _cl_command_name _cl_resolved_workdir _cl_run_id
  return 0 2>/dev/null || exit 0
fi

# --- Start timestamp ---

_cl_start_time=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
if [[ -z "$_cl_start_time" ]]; then
  echo "[command-telemetry-init] WARNING: could not capture start timestamp; using empty value" >&2
fi

# --- Persist state to .cmd-state.env ---

_cl_state_file="${_cl_resolved_workdir}/.cmd-state.env"

if ! cat > "$_cl_state_file" <<EOF
CLOSEDLOOP_WORKDIR=${_cl_resolved_workdir}
CLOSEDLOOP_CMD_START=${_cl_start_time}
CLOSEDLOOP_RUN_ID=${_cl_run_id}
CLOSEDLOOP_COMMAND=${_cl_command_name}
EOF
then
  echo "[command-telemetry-init] ERROR: could not write state file: $_cl_state_file" >&2
  # Fail open: continue anyway — env vars will still be exported below
fi

# --- Write sidecar pointer at project-default location ---
# This allows command-telemetry-complete.sh (invoked from the Stop hook with
# no argv and a potentially clean environment) to recover the real workdir
# even if CLOSEDLOOP_WORKDIR is not exported into that subprocess.

_cl_sidecar_dir="${PWD}/.closedloop-ai/telemetry"
# Always overwrite the sidecar so a later run with default workdir does not
# inherit a stale pointer from a previous --workdir-overridden run. The write
# is atomic (tmp + mv on same FS) and owner-only (umask 077) to reduce
# over-readability of the path pointer.
if mkdir -p "$_cl_sidecar_dir" 2>/dev/null; then
  _cl_sidecar_tmp="${_cl_sidecar_dir}/.last-cmd-state.tmp.$$"
  (umask 077 && printf '%s\n' "$_cl_resolved_workdir" > "$_cl_sidecar_tmp") 2>/dev/null \
    && mv -f "$_cl_sidecar_tmp" "${_cl_sidecar_dir}/.last-cmd-state" 2>/dev/null \
    || rm -f "$_cl_sidecar_tmp" 2>/dev/null || true
fi

# --- Export env vars ---

export CLOSEDLOOP_COMMAND="$_cl_command_name"
export CLOSEDLOOP_RUN_ID="$_cl_run_id"
export CLOSEDLOOP_WORKDIR="$_cl_resolved_workdir"

# --- Call record_run.sh to emit the run event ---

_cl_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
_cl_record_run="${_cl_scripts_dir}/record_run.sh"

if [[ -f "$_cl_record_run" ]]; then
  if ! bash "$_cl_record_run" "$_cl_resolved_workdir" 2>/dev/null; then
    echo "[command-telemetry-init] WARNING: record_run.sh exited non-zero (telemetry event may be missing)" >&2
  fi
else
  echo "[command-telemetry-init] WARNING: record_run.sh not found at: $_cl_record_run" >&2
fi

# --- Cleanup local vars ---

unset _cl_command_name _cl_resolved_workdir _cl_run_id _cl_start_time
unset _cl_state_file _cl_scripts_dir _cl_record_run _cl_sidecar_dir _cl_sidecar_tmp
