#!/usr/bin/env bash
# command-telemetry-init.sh — Telemetry initialiser for slash commands.
#
# Designed to be SOURCED (not executed) by command markdown files at startup
# so that the exported env vars remain visible to subsequent steps in the same
# Claude Code session:
#
#   source "${CLAUDE_PLUGIN_ROOT}/scripts/command-telemetry-init.sh" <command-name> [workdir]
#
# Arguments:
#   $1  COMMAND_NAME (required) — the slash-command name, e.g. "code", "amend-plan"
#   $2  WORKDIR       (optional) — overrides env var and default
#
# Precedence for CLOSEDLOOP_WORKDIR:
#   1. $2 argument
#   2. CLOSEDLOOP_WORKDIR env var (already set by the caller / parent loop)
#   3. Default: .closedloop-ai/telemetry/ (relative to cwd)
#
# Fail-open guarantee: the entire initialisation is wrapped in a function.
# Any error inside that function is caught and suppressed so the calling
# command continues normally.

_closedloop_telemetry_init() {
  local command_name="${1:-}"
  local workdir_arg="${2:-}"

  # Argument validation — COMMAND_NAME is required
  if [[ -z "$command_name" ]]; then
    return 0
  fi

  # Resolve CLOSEDLOOP_WORKDIR
  local workdir
  if [[ -n "$workdir_arg" ]]; then
    workdir="$workdir_arg"
  elif [[ -n "${CLOSEDLOOP_WORKDIR:-}" ]]; then
    workdir="$CLOSEDLOOP_WORKDIR"
  else
    workdir=".closedloop-ai/telemetry"
  fi

  # Generate CLOSEDLOOP_RUN_ID (same format as run-loop.sh: timestamp + 4-byte hex)
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S 2>/dev/null) || timestamp="00000000-000000"
  local random_suffix
  random_suffix=$(head -c 4 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null) || random_suffix="00000000"
  local run_id="${timestamp}-${random_suffix}"

  # Capture start time as unix epoch (for duration calculation in complete script)
  local start_epoch
  start_epoch=$(date +%s 2>/dev/null) || start_epoch=""

  # Export env vars for the session
  export CLOSEDLOOP_WORKDIR="$workdir"
  export CLOSEDLOOP_RUN_ID="$run_id"
  export CLOSEDLOOP_COMMAND="$command_name"
  export CLOSEDLOOP_START_TIME="$start_epoch"

  # Persist state to disk so command-telemetry-complete.sh can recover the run
  # context when it runs in a separate Bash tool invocation (the export above
  # only affects the shell that ran `source`).
  mkdir -p "$workdir" 2>/dev/null || true
  {
    printf 'CLOSEDLOOP_WORKDIR=%s\n' "$workdir"
    printf 'CLOSEDLOOP_RUN_ID=%s\n' "$run_id"
    printf 'CLOSEDLOOP_COMMAND=%s\n' "$command_name"
    printf 'CLOSEDLOOP_START_TIME=%s\n' "$start_epoch"
  } > "$workdir/.cmd-state.env" 2>/dev/null || true

  # Call record_run.sh — locate it relative to this script
  local scripts_dir
  scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || scripts_dir=""
  if [[ -n "$scripts_dir" && -f "$scripts_dir/record_run.sh" ]]; then
    bash "$scripts_dir/record_run.sh" "$workdir" || true
  fi
}

# Invoke with fail-open: any error is suppressed so the calling command
# continues unaffected.
_closedloop_telemetry_init "$@" || true
