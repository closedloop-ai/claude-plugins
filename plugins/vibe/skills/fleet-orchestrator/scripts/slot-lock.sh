#!/usr/bin/env bash
# Usage: slot-lock.sh [--slots N | --heavy-machine local|remote] [--preflight-node <file>] [--admission-note <text>] <lockName> <ownerLabel> <command...>
#        slot-lock.sh --status <lockName>
# Runs <command> once one of N slots named <lockName> is free on this machine (default 1), and frees the
# slot when the command exits or this script is interrupted. A slot whose holder pid is dead is reclaimed.
# Locks live in absolute SLOT_LOCK_DIR (default ~/.local/state/fleet-orchestrator/locks); SLOT_LOCK_POLL_SECONDS
# sets the wait between tries (default 20).
# SLOT_LOCK_HELD_PATH and SLOT_LOCK_HELD_PID identify the one live slot exported to descendants so a nested
# request for that same lock name reuses it. Only one held slot is remembered: heavy -> e2e -> heavy waits.
set -u

usage() {
  sed -n '2,3p' "$0" | sed 's/^# //' >&2
  exit 2
}

lock_root=${SLOT_LOCK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/fleet-orchestrator/locks}
poll=${SLOT_LOCK_POLL_SECONDS:-20}
slots=1
slots_explicit=
heavy_machine=
preflight_node=
admission_note=

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
    --slots) slots=${2:-}; slots_explicit=1; shift 2 2>/dev/null || usage ;;
    --heavy-machine) heavy_machine=${2:-}; shift 2 2>/dev/null || usage ;;
    --preflight-node) preflight_node=${2:-}; [ -n "$preflight_node" ] || usage; shift 2 2>/dev/null || usage ;;
    --admission-note) admission_note=${2:-}; [ -n "$admission_note" ] || usage; shift 2 2>/dev/null || usage ;;
    *) break ;;
  esac
done
[ -z "$heavy_machine" ] || [ -z "$slots_explicit" ] || usage
case "$heavy_machine" in '' | local | remote) ;; *) usage ;; esac
case "$slots" in '' | *[!0-9]* | 0) usage ;; esac
[ $# -ge 3 ] || usage
name=$1 owner=$2
shift 2
case "$name" in '' | *[!A-Za-z0-9._-]*) usage ;; esac
[ -z "$heavy_machine" ] || [ "$name" = heavy ] || usage
case "$admission_note" in *$'\n'*) usage ;; esac

mkdir -p "$lock_root"
lock=
reused=
held_lock=${SLOT_LOCK_HELD_PATH:-}
held_pid=${SLOT_LOCK_HELD_PID:-}

is_process_ancestor() {
  local candidate=$1 current=$$ parent seen=' ' steps=0
  case "$candidate" in '' | *[!0-9]* | 0 | 1) return 1 ;; esac
  while [ "$steps" -lt 64 ]; do
    case "$current" in 0 | 1) return 1 ;; esac
    case "$seen" in *" $current "*) return 1 ;; esac
    seen="$seen$current "
    parent=$(ps -o ppid= -p "$current" 2>/dev/null) || return 1
    parent=${parent#"${parent%%[![:space:]]*}"}
    parent=${parent%"${parent##*[![:space:]]}"}
    case "$parent" in '' | *[!0-9]*) return 1 ;; esac
    [ "$parent" = "$candidate" ] && return 0
    current=$parent
    steps=$((steps + 1))
  done
  return 1
}

held_lock_is_owned() {
  local held_slot current_pid
  held_slot=${held_lock#"$lock_root/$name-"}
  held_slot=${held_slot%.lock}
  [ "$held_lock" = "$lock_root/$name-$held_slot.lock" ] || return 1
  case "$held_slot" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$held_pid" ] && [ -f "$held_lock/pid" ] || return 1
  current_pid=$(cat "$held_lock/pid" 2>/dev/null) || return 1
  [ "$current_pid" = "$held_pid" ] && kill -0 "$held_pid" 2>/dev/null &&
    is_process_ancestor "$held_pid"
}

if held_lock_is_owned; then reused=1; fi

if [ -n "$heavy_machine" ] && [ -z "$reused" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  case "${FLEET_FORCE_HERE:-}" in '' | 0 | 1) ;; *) usage ;; esac
  case "${FLEET_FORCE_REASON:-}" in *$'\n'* | *$'\r'* | *$'\t'*) usage ;; esac
  if [ "$heavy_machine" = local ]; then
    slots=${HEAVY_SLOTS:-1}
    max_load=${MAX_LOAD_PER_CORE:-1.5}
  else
    slots=${REMOTE_HEAVY_SLOTS:-1}
    max_load=${REMOTE_MAX_LOAD_PER_CORE:-${MAX_LOAD_PER_CORE:-1.5}}
  fi
  case "$slots" in '' | *[!0-9]* | 0) usage ;; esac
  MAX_LOAD_PER_CORE=$max_load bash "$here/load-check.sh" || exit $?
  if [ -z "$admission_note" ] && [ "${FLEET_FORCE_HERE:-}" = 1 ] && [ -n "${FLEET_FORCE_REASON:-}" ]; then
    admission_note="force reason: $FLEET_FORCE_REASON"
  fi
fi
acquire() {
  local n candidate
  for n in $(seq 1 "$slots"); do
    candidate="$lock_root/$name-$n.lock"
    if [ -f "$candidate/pid" ] && ! kill -0 "$(cat "$candidate/pid")" 2>/dev/null; then rm -rf "$candidate"; fi
    if mkdir "$candidate" 2>/dev/null; then
      echo $$ >"$candidate/pid"
      pwd -P >"$candidate/cwd"
      printf '%s pid %s since %s%s\n' "$owner" $$ "$(date '+%Y-%m-%d %H:%M')" "${admission_note:+; $admission_note}" >"$candidate/owner"
      lock=$candidate
      return 0
    fi
  done
  return 1
}

child=
releasing=
exit_signal=
release() {
  [ -n "$releasing" ] && return
  releasing=1
  trap '' HUP INT TERM
  # A reused wrapper owns no process group. Relay its terminating signal to the already-verified
  # outer lock owner, which is the single actor responsible for bounded group cleanup.
  if [ -n "$reused" ] && [ -n "$exit_signal" ] && held_lock_is_owned; then
    kill -s "$exit_signal" "$held_pid" 2>/dev/null || :
  fi
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null
    # The owning child helper applies a bounded TERM/grace/KILL to its detached group. Reused wrappers
    # remain in that group, so waiting here reaps the helper before the owned lock releases capacity.
    wait "$child" 2>/dev/null
  fi
  [ -n "$lock" ] && rm -rf "$lock"
}
trap release EXIT
exit_for_signal() {
  exit_signal=$1
  case "$1" in HUP) exit 129 ;; INT) exit 130 ;; TERM) exit 143 ;; esac
}
install_exit_traps() {
  trap 'exit_for_signal HUP' HUP
  trap 'exit_for_signal INT' INT
  trap 'exit_for_signal TERM' TERM
}
install_exit_traps

if [ -z "$reused" ]; then
  until acquire; do
    echo "slot-lock: $name busy ($(holders "$name")); waiting ${poll}s" >&2
    sleep "$poll"
  done
fi

if [ "$name" = heavy ] && [ -z "$reused" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  node "$here/../../vibe/scripts/owned-state.mjs" admit-heavy "$lock" "$$" "$owner" </dev/null >/dev/null &
  child=$!
  wait "$child"
  status=$?
  child=
  [ "$status" -eq 0 ] || exit "$status"
fi

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
if [ -z "$reused" ]; then
  export SLOT_LOCK_HELD_PATH=$lock SLOT_LOCK_HELD_PID=$$
  here=$(cd "$(dirname "$0")" && pwd)
  pending_signal=
  trap '[ -n "$pending_signal" ] || pending_signal=HUP' HUP
  trap '[ -n "$pending_signal" ] || pending_signal=INT' INT
  trap '[ -n "$pending_signal" ] || pending_signal=TERM' TERM
  node "$here/slot-lock-child.mjs" "$@" <&0 &
  child=$!
  install_exit_traps
  [ -z "$pending_signal" ] || exit_for_signal "$pending_signal"
else
  "$@" <&0 &
  child=$!
fi
wait "$child"
status=$?
child=
exit "$status"
