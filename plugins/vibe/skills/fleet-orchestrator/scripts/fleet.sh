#!/usr/bin/env bash
# Usage: fleet.sh <orchDir> <local|remote> session <turn|steer|last> <name> [codex-session.mjs options]
#        fleet.sh <orchDir> <local|remote> slot <lockName> <owner> <dir> <command...>
# Settings come from <orchDir>/config.env (references/setup.md); without the REMOTE_* keys only `local` works.
# `remote` copies the scripts it needs, and a session's prompt file, to <REMOTE_STATE_DIR>/.fleet-orchestrator/
# on REMOTE_HOST over ssh and runs them there in REMOTE_SHELL.
set -euo pipefail

usage() {
  sed -n '2,3p' "$0" | sed 's/^# //' >&2
  exit 2
}

[ $# -ge 3 ] || usage
orch=$1 where=$2 action=$3
shift 3
[ -d "$orch" ] || { echo "fleet: no orchestration dir $orch" >&2; exit 2; }
if [ -f "$orch/config.env" ]; then . "$orch/config.env"; fi
here=$(cd "$(dirname "$0")" && pwd)
skills=$(cd "$here/../.." && pwd)
case "$where" in
  local) ;;
  remote)
    : "${REMOTE_HOST:?set REMOTE_HOST in $orch/config.env}" "${REMOTE_STATE_DIR:?set REMOTE_STATE_DIR in $orch/config.env}"
    remote_dir=$REMOTE_STATE_DIR/.fleet-orchestrator
    ;;
  *) usage ;;
esac

ship=(codex-fleet-monitor/scripts/liveness.mjs fleet-orchestrator/scripts/codex-session.mjs fleet-orchestrator/scripts/slot-lock.sh fleet-orchestrator/scripts/request-visual.mjs)
extra=()

# Runs a shell command line on REMOTE_HOST after unpacking the shipped scripts (and `extra`) into remote_dir.
run_remote() {
  local outer
  outer="mkdir -p $(printf %q "$remote_dir") && tar -C $(printf %q "$remote_dir") -xf - && ${REMOTE_SHELL:-zsh -lic} $(printf %q "$1")"
  COPYFILE_DISABLE=1 tar -cf - -C "$skills" "${ship[@]}" ${extra[@]+"${extra[@]}"} |
    ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 "$REMOTE_HOST" "$outer"
}

has_option() {
  local word
  for word in ${args[@]+"${args[@]}"}; do
    case "$word" in "$1" | "$1"=*) return 0 ;; esac
  done
  return 1
}

session() {
  [ $# -ge 2 ] || usage
  local command=$1 name=$2 i prompt=
  shift 2
  args=("$@")
  if [ "$command" = turn ]; then
    if [ -n "${CODEX_MODEL:-}" ] && ! has_option --model; then args+=(--model "$CODEX_MODEL"); fi
    if [ -n "${CODEX_EFFORT:-}" ] && ! has_option --effort; then args+=(--effort "$CODEX_EFFORT"); fi
  fi
  if [ "$where" = local ]; then
    local state=${LOCAL_STATE_DIR:-$orch/sessions}
    mkdir -p "$state"
    exec node "$here/codex-session.mjs" "$command" "$state" "$name" ${args[@]+"${args[@]}"}
  fi
  for i in "${!args[@]}"; do
    case "${args[$i]}" in
      --prompt-file) prompt=${args[$((i + 1))]:-} ;;
      --prompt-file=*) prompt=${args[$i]#--prompt-file=} ;;
    esac
  done
  if [ -n "$prompt" ]; then
    [ -f "$prompt" ] || { echo "fleet: no prompt file $prompt" >&2; exit 2; }
    extra=(-C "$(cd "$(dirname "$prompt")" && pwd)" "$(basename "$prompt")")
    for i in "${!args[@]}"; do
      case "${args[$i]}" in
        --prompt-file) args[$((i + 1))]=$remote_dir/$(basename "$prompt") ;;
        --prompt-file=*) args[$i]=--prompt-file=$remote_dir/$(basename "$prompt") ;;
      esac
    done
  fi
  run_remote "$(printf '%q ' node "$remote_dir/fleet-orchestrator/scripts/codex-session.mjs" "$command" "$REMOTE_STATE_DIR" "$name" ${args[@]+"${args[@]}"})"
}

slot() {
  [ $# -ge 4 ] || usage
  local name=$1 owner=$2 dir=$3 slots=1
  shift 3
  if [ "$name" = heavy ]; then
    if [ "$where" = local ]; then slots=${HEAVY_SLOTS:-1}; else slots=${REMOTE_HEAVY_SLOTS:-1}; fi
  fi
  if [ "$where" = local ]; then
    cd "$dir"
    exec bash "$here/slot-lock.sh" --slots "$slots" "$name" "$owner" "$@"
  fi
  run_remote "cd $(printf %q "$dir") && $(printf '%q ' bash "$remote_dir/fleet-orchestrator/scripts/slot-lock.sh" --slots "$slots" "$name" "$owner" "$@")"
}

case "$action" in
  session) session "$@" ;;
  slot) slot "$@" ;;
  *) usage ;;
esac
