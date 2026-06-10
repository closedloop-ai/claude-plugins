#!/usr/bin/env bash
# user-prompt-expansion-hook.sh - Initialize native PLAN/EXECUTE perf metadata.
#
# Fails open on all errors so prompt expansion never blocks the user command.

trap 'exit 0' ERR

CLOSEDLOOP_STATE_DIR=".closedloop-ai"

INPUT=$(cat)
COMMAND_NAME=$(echo "$INPUT" | jq -r '.command_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

case "$COMMAND_NAME" in
  create-plan|code:create-plan)
    CLOSEDLOOP_COMMAND_VALUE="PLAN"
    ;;
  execute-implementation|code:execute-implementation)
    CLOSEDLOOP_COMMAND_VALUE="EXECUTE"
    ;;
  *)
    exit 0
    ;;
esac

CONFIG_FILE=""
if [[ -n "${CLOSEDLOOP_WORKDIR:-}" ]] && [[ -f "${CLOSEDLOOP_WORKDIR}/${CLOSEDLOOP_STATE_DIR}/config.env" ]]; then
  CONFIG_FILE="${CLOSEDLOOP_WORKDIR}/${CLOSEDLOOP_STATE_DIR}/config.env"
elif [[ -n "$CWD" ]] && [[ -f "$CWD/${CLOSEDLOOP_STATE_DIR}/config.env" ]]; then
  CONFIG_FILE="$CWD/${CLOSEDLOOP_STATE_DIR}/config.env"
fi

if [[ -z "$CONFIG_FILE" ]]; then
  exit 0
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

WORKDIR="${CLOSEDLOOP_WORKDIR:-}"
if [[ -z "$WORKDIR" ]]; then
  exit 0
fi

RUN_ID="${CLOSEDLOOP_RUN_ID:-}"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run_$(date +%s)_$$"
fi

CONFIG_TMP="${CONFIG_FILE}.tmp.$$"
grep -v -E '^(CLOSEDLOOP_RUN_ID|CLOSEDLOOP_ITERATION|CLOSEDLOOP_COMMAND)=' "$CONFIG_FILE" > "$CONFIG_TMP" 2>/dev/null || true
{
  cat "$CONFIG_TMP"
  printf 'CLOSEDLOOP_RUN_ID=%q\n' "$RUN_ID"
  printf 'CLOSEDLOOP_ITERATION=0\n'
  printf 'CLOSEDLOOP_COMMAND=%q\n' "$CLOSEDLOOP_COMMAND_VALUE"
} > "$CONFIG_FILE"
rm -f "$CONFIG_TMP" 2>/dev/null || true

export CLOSEDLOOP_WORKDIR="$WORKDIR"
export CLOSEDLOOP_RUN_ID="$RUN_ID"
export CLOSEDLOOP_ITERATION=0
export CLOSEDLOOP_COMMAND="$CLOSEDLOOP_COMMAND_VALUE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
bash "$SCRIPT_DIR/record_run.sh" "$WORKDIR" 2>/dev/null || true

exit 0
