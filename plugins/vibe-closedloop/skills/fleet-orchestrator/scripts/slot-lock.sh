#!/usr/bin/env bash
# Usage: slot-lock.sh [--slots N] [--wait-seconds N] [--preflight-node <file>] [--admission-note <text>] <lockName> <ownerLabel> <command...>
#        slot-lock.sh --status <lockName>
# Runs <command> once one of N slots named <lockName> is free on this machine (default 1), and frees the
# slot when the command exits or this script is interrupted. A slot whose holder pid is dead is reclaimed.
# Locks live in absolute SLOT_LOCK_DIR (default ~/.local/state/fleet-orchestrator/locks); SLOT_LOCK_POLL_SECONDS
# sets the wait between tries (default 20).
set -u

usage() {
  sed -n '2,3p' "$0" | sed 's/^# //' >&2
  exit 2
}

lock_root=${SLOT_LOCK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/fleet-orchestrator/locks}
poll=${SLOT_LOCK_POLL_SECONDS:-20}
slots=1
wait_seconds=
draining=
preflight_node=
stack_node=
stack_ticket=
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
    --slots) slots=${2:-}; shift 2 2>/dev/null || usage ;;
    --wait-seconds) wait_seconds=${2:-}; [ -n "$wait_seconds" ] || usage; shift 2 2>/dev/null || usage ;;
    --drain-command) draining=1; shift ;;
    --stack-ticket) stack_ticket=${2:-}; [ -n "$stack_ticket" ] || usage; shift 2 ;;
    --stack-node) stack_node=${2:-}; [ -n "$stack_node" ] || usage; shift 2 2>/dev/null || usage ;;
    --disk-node) preflight_node=${2:-}; [ -n "$preflight_node" ] || usage; shift 2 2>/dev/null || usage ;;
    --preflight-node) stack_node=${2:-}; preflight_node=${2:-}; [ -n "$preflight_node" ] || usage; shift 2 2>/dev/null || usage ;;
    --admission-note) admission_note=${2:-}; [ -n "$admission_note" ] || usage; shift 2 2>/dev/null || usage ;;
    *) break ;;
  esac
done
case "$slots" in '' | *[!0-9]* | 0) usage ;; esac
case "$wait_seconds" in *[!0-9]*) usage ;; esac
[ $# -ge 3 ] || usage
name=$1 owner=$2
shift 2
case "$name" in '' | *[!A-Za-z0-9._-]*) usage ;; esac
case "$admission_note" in *$'\n'*) usage ;; esac

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
      printf '%s pid %s since %s%s\n' "$owner" $$ "$(date '+%Y-%m-%d %H:%M')" "${admission_note:+; $admission_note}" >"$candidate/owner"
      lock=$candidate
      return 0
    fi
  done
  return 1
}

child=
admitting=
release() {
  [ -n "$child" ] && kill "$child" 2>/dev/null
  # Fence admission handles the signal and exits promptly; reap it before removing its record.
  [ -n "$child" ] && [ -n "$admitting$draining" ] && wait "$child" 2>/dev/null
  [ -n "$lock" ] && rm -rf "$lock"
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

waiting_at=$SECONDS
until acquire; do
  sleep_for=$poll
  if [ -n "$wait_seconds" ]; then
    remaining=$((10#$wait_seconds - (SECONDS - waiting_at)))
    if [ "$remaining" -le 0 ]; then
      echo "slot-lock: admission deadline exceeded for $name" >&2
      exit 75
    fi
    case "$sleep_for" in
      *[!0-9]*) ;;
      *) if [ "$remaining" -lt "$sleep_for" ]; then sleep_for=$remaining; fi ;;
    esac
  fi
  echo "slot-lock: $name busy ($(holders "$name")); waiting ${poll}s" >&2
  sleep "$sleep_for"
done

if [ "$name" = heavy ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  admitting=1
  node "$here/../../vibe/scripts/owned-state.mjs" admit-heavy "$lock" "$$" "$owner" </dev/null >/dev/null &
  child=$!
  wait "$child"
  status=$?
  child= admitting=
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
if [ -n "$stack_node" ]; then
  # Keep the machine-wide stack lease until the admitted command exits.
  local_stack_owner() {
    if [[ ${1##*/} == node && ${2:-} -ef "$(dirname "$0")/capture-command.mjs" ]]; then shift 4; fi
    [[ ${1##*/} == node && ${3:-} == run && ${2:-} -ef "$stack_node" ]]
  }
  if ! local_stack_owner "$@"; then
    ticket_args=()
    if [ -n "$stack_ticket" ]; then ticket_args=(--ticket "$stack_ticket"); fi
    set -- node "$stack_node" run --owner "$owner" --label "$owner" ${ticket_args[@]+"${ticket_args[@]}"} -- "$@"
  fi
fi

# The command runs in the background so a signal reaches the traps at once instead of after it exits;
# the explicit <&0 keeps its stdin, which bash would otherwise point at /dev/null for a background job.
started=$SECONDS
"$@" <&0 &
child=$!
wait "$child"
status=$?
child=
if [ "$status" -ne 0 ] && [ $((SECONDS - started)) -le 5 ]; then
  printf 'slot-lock: worker command failed immediately after slot grant (exit %s):' "$status" >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
fi
exit "$status"
