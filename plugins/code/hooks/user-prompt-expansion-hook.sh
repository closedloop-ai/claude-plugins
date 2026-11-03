#!/usr/bin/env bash
# user-prompt-expansion-hook.sh - Initialize native PLAN/EXECUTE perf metadata.
#
# Fails open on all errors so prompt expansion never blocks the user command.

trap 'exit 0' ERR

CLOSEDLOOP_STATE_DIR=".closedloop-ai"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
# shellcheck source=../scripts/closedloop_env.sh
source "$SCRIPT_DIR/closedloop_env.sh"

INPUT=$(cat)
COMMAND_NAME=$(echo "$INPUT" | jq -r '.command_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
COMMAND_ARGS=$(echo "$INPUT" | jq -r '
  .command_args // .command_arguments // .arguments // .args // empty
  | if type == "array" then map(tostring) | join(" ") else tostring end
')

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

try_config_candidate() {
  local candidate="$1"
  if [[ -z "$CONFIG_FILE" && -n "$candidate" && -f "${candidate}/${CLOSEDLOOP_STATE_DIR}/config.env" ]]; then
    CONFIG_FILE="${candidate}/${CLOSEDLOOP_STATE_DIR}/config.env"
  fi
}

try_config_candidate "${CLOSEDLOOP_WORKDIR:-}"
while IFS= read -r candidate; do
  try_config_candidate "$candidate"
done < <(
  echo "$INPUT" | jq -r '
    [
      .workdir?,
      .working_directory?,
      .target_workdir?,
      .command?.workdir?,
      .command?.working_directory?
    ]
    | .[]
    | select(type == "string" and length > 0)
  '
)
if [[ -z "$CONFIG_FILE" && -n "$COMMAND_ARGS" && "$COMMAND_ARGS" != --* ]]; then
  try_config_candidate "${COMMAND_ARGS%% --*}"
fi
try_config_candidate "$CWD"

if [[ -z "$CONFIG_FILE" ]]; then
  exit 0
fi

load_closedloop_env "$CONFIG_FILE"

WORKDIR="${CLOSEDLOOP_WORKDIR:-}"
if [[ -z "$WORKDIR" ]]; then
  exit 0
fi

RUN_ID="${CLOSEDLOOP_RUN_ID:-}"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run_$(date +%s)_$$"
fi

CONFIG_TMP="${CONFIG_FILE}.tmp.$$"
CONFIG_NEW="${CONFIG_FILE}.new.$$"
grep -v -E '^(CLOSEDLOOP_RUN_ID|CLOSEDLOOP_ITERATION|CLOSEDLOOP_COMMAND)=' "$CONFIG_FILE" > "$CONFIG_TMP" 2>/dev/null || true
# Build the new file fully, then atomically rename it over the original so an
# interruption mid-write can never leave config.env empty or half-written.
{
  cat "$CONFIG_TMP"
  printf 'CLOSEDLOOP_RUN_ID=%q\n' "$RUN_ID"
  printf 'CLOSEDLOOP_ITERATION=0\n'
  printf 'CLOSEDLOOP_COMMAND=%q\n' "$CLOSEDLOOP_COMMAND_VALUE"
} > "$CONFIG_NEW"
mv "$CONFIG_NEW" "$CONFIG_FILE"
rm -f "$CONFIG_TMP" 2>/dev/null || true

export CLOSEDLOOP_WORKDIR="$WORKDIR"
export CLOSEDLOOP_RUN_ID="$RUN_ID"
export CLOSEDLOOP_ITERATION=0
export CLOSEDLOOP_COMMAND="$CLOSEDLOOP_COMMAND_VALUE"

bash "$SCRIPT_DIR/record_run.sh" "$WORKDIR" 2>/dev/null || true

exit 0
