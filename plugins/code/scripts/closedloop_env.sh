#!/bin/bash
# closedloop_env.sh - Shared helper to hydrate CLOSEDLOOP_* env vars from
# config.env without letting the file clobber values already present in the
# environment.
#
# Source this file, then call:
#   load_closedloop_env "$CONFIG_FILE"
#
# Existing non-empty CLOSEDLOOP_WORKDIR / CLOSEDLOOP_RUN_ID /
# CLOSEDLOOP_ITERATION / CLOSEDLOOP_COMMAND values take precedence over whatever
# config.env defines (the environment is the source of truth; config.env is the
# fallback). No-op when CONFIG_FILE is absent.
#
# config.env is parsed line-by-line (NOT sourced) so a malformed or hostile file
# can never execute arbitrary shell. Only the allowlisted keys are read; all
# other lines are ignored. Backslash-escaped spaces are decoded so values written
# by `printf %q` for common paths still round-trip without eval/source.
#
# Single source of truth for both record_iteration.sh and record_phase.sh.

decode_closedloop_env_value() {
  local val="$1"
  val="${val//\\ / }"
  printf '%s' "$val"
}

load_closedloop_env() {
  local config_file="$1"
  [[ -f "$config_file" ]] || return 0

  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      CLOSEDLOOP_WORKDIR=*|CLOSEDLOOP_RUN_ID=*|CLOSEDLOOP_ITERATION=*|CLOSEDLOOP_COMMAND=*)
        key="${line%%=*}"
        val="$(decode_closedloop_env_value "${line#*=}")"
        # Environment is the source of truth; only fall back to config.env
        # when the corresponding env var is unset or empty.
        case "$key" in
          CLOSEDLOOP_WORKDIR)
            if [[ -z "${CLOSEDLOOP_WORKDIR:-}" ]]; then CLOSEDLOOP_WORKDIR="$val"; fi
            ;;
          CLOSEDLOOP_RUN_ID)
            if [[ -z "${CLOSEDLOOP_RUN_ID:-}" ]]; then CLOSEDLOOP_RUN_ID="$val"; fi
            ;;
          CLOSEDLOOP_ITERATION)
            if [[ -z "${CLOSEDLOOP_ITERATION:-}" ]]; then CLOSEDLOOP_ITERATION="$val"; fi
            ;;
          CLOSEDLOOP_COMMAND)
            if [[ -z "${CLOSEDLOOP_COMMAND:-}" ]]; then CLOSEDLOOP_COMMAND="$val"; fi
            ;;
        esac
        ;;
    esac
  done < "$config_file"
}
