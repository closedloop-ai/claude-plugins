#!/usr/bin/env bash
# Usage: slot-lock.sh [--slots N] [--preflight-node <file>] <lockName> <ownerLabel> <command...>
#        slot-lock.sh --status <lockName>
# Runs <command> once one of N slots named <lockName> is free on this machine (default 1), and frees the
# slot when the command exits or this script is interrupted. A slot whose holder pid is dead is reclaimed.
# Locks live in SLOT_LOCK_DIR (default ~/.local/state/fleet-orchestrator/locks); SLOT_LOCK_POLL_SECONDS
# sets the wait between tries (default 20).
set -u

usage() {
  sed -n '2,3p' "$0" | sed 's/^# //' >&2
  exit 2
}

lock_root=${SLOT_LOCK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/fleet-orchestrator/locks}
poll=${SLOT_LOCK_POLL_SECONDS:-20}
slots=1
preflight_node=

holders() {
  cat "$lock_root/$1"-*.lock/owner 2>/dev/null | paste -sd ';' -
}

if [ "${1:-}" = "--status" ]; then
  [ $# -eq 2 ] || usage
  printf '%s\n' "$(holders "$2")"
  exit 0
fi
while :; do
  case "${1:-}" in
    --slots) slots=${2:-}; shift 2 2>/dev/null || usage ;;
    --preflight-node) preflight_node=${2:-}; [ -n "$preflight_node" ] || usage; shift 2 2>/dev/null || usage ;;
    *) break ;;
  esac
done
case "$slots" in '' | *[!0-9]* | 0) usage ;; esac
[ $# -ge 3 ] || usage
name=$1 owner=$2
shift 2
case "$name" in '' | *[!A-Za-z0-9._-]*) usage ;; esac

mkdir -p "$lock_root"
lock=
acquire() {
  local n candidate
  for n in $(seq 1 "$slots"); do
    candidate="$lock_root/$name-$n.lock"
    if [ -f "$candidate/pid" ] && ! kill -0 "$(cat "$candidate/pid")" 2>/dev/null; then rm -rf "$candidate"; fi
    if mkdir "$candidate" 2>/dev/null; then
      echo $$ >"$candidate/pid"
      pwd -P >"$candidate/cwd"
      printf '%s pid %s since %s\n' "$owner" $$ "$(date '+%Y-%m-%d %H:%M')" >"$candidate/owner"
      lock=$candidate
      return 0
    fi
  done
  return 1
}

child=
release() {
  [ -n "$child" ] && kill "$child" 2>/dev/null
  [ -n "$lock" ] && rm -rf "$lock"
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

until acquire; do
  echo "slot-lock: $name busy ($(holders "$name")); waiting ${poll}s" >&2
  sleep "$poll"
done

# Admission is read only and executes while this slot is held, immediately
# before the child. A failed probe releases the slot through the EXIT trap.
if [ -n "$preflight_node" ]; then
  node "$preflight_node" check <&0
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "slot-lock: containerized E2E disk admission refused the command" >&2
    exit 78
  fi
fi

# The command runs in the background so a signal reaches the traps at once instead of after it exits;
# the explicit <&0 keeps its stdin, which bash would otherwise point at /dev/null for a background job.
"$@" <&0 &
child=$!
wait "$child"
status=$?
child=
exit "$status"
