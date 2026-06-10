#!/bin/bash
# closedloop_env.sh - Shared helper to hydrate CLOSEDLOOP_* env vars from
# config.env without letting the file clobber values already present in the
# environment.
#
# Source this file, then call:
#   load_closedloop_env "$CONFIG_FILE"
#
# Existing non-empty CLOSEDLOOP_RUN_ID / CLOSEDLOOP_ITERATION / CLOSEDLOOP_COMMAND
# values take precedence over whatever config.env defines (the environment is the
# source of truth; config.env is the fallback). No-op when CONFIG_FILE is absent.
#
# Single source of truth for both record_iteration.sh and record_phase.sh.

load_closedloop_env() {
  local config_file="$1"
  [[ -f "$config_file" ]] || return 0

  local env_run_id="${CLOSEDLOOP_RUN_ID:-}"
  local env_iteration="${CLOSEDLOOP_ITERATION:-}"
  local env_command="${CLOSEDLOOP_COMMAND:-}"

  set +u
  # shellcheck disable=SC1090
  source "$config_file"
  set -u

  if [[ -n "$env_run_id" ]]; then
    CLOSEDLOOP_RUN_ID="$env_run_id"
  fi
  if [[ -n "$env_iteration" ]]; then
    CLOSEDLOOP_ITERATION="$env_iteration"
  fi
  if [[ -n "$env_command" ]]; then
    CLOSEDLOOP_COMMAND="$env_command"
  fi
}
