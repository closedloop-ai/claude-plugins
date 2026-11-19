#!/usr/bin/env bash
# One coordinator-side admission spans local and remote heavy queues. It refuses duplicate owner/tree work and
# permits only one declared full-corpus pass for the fleet program.
set -euo pipefail
[ "$#" -ge 5 ] || { echo "usage: fleet-admission.sh <orch> <owner> <dir> <ordinary|full-corpus> <command...>" >&2; exit 2; }
orch=$1 owner=$2 dir=$3 kind=$4
shift 4
[ "$kind" = ordinary ] || [ "$kind" = full-corpus ] || exit 2
root=$orch/.fleet-admission
mkdir -p "$root"
tree=$(git -C "$dir" rev-parse 'HEAD^{tree}' 2>/dev/null || printf 'remote-or-non-git:%s' "$dir")
key=$(printf '%s\0%s' "$owner" "$tree" | cksum | awk '{print $1 "-" $2}')
locks=("$root/work-$key.lock")
[ "$kind" = full-corpus ] && locks+=("$root/full-corpus.lock")
held=()
cleanup() { for lock in ${held[@]+"${held[@]}"}; do rm -rf "$lock"; done; }
child=
stop_child() {
  local fallback=$1 status
  [ -n "$child" ] || exit "$fallback"
  kill -TERM "$child" 2>/dev/null || true
  set +e
  wait "$child"
  status=$?
  set -e
  exit "$status"
}
trap cleanup EXIT
trap 'stop_child 129' HUP
trap 'stop_child 130' INT
trap 'stop_child 143' TERM
for lock in "${locks[@]}"; do
  if [ -f "$lock/pid" ] && ! kill -0 "$(cat "$lock/pid")" 2>/dev/null; then rm -rf "$lock"; fi
  if ! mkdir "$lock" 2>/dev/null; then
    case "$lock" in
      */full-corpus.lock) echo "fleet admission: another full-corpus pass is queued or running" >&2 ;;
      *) echo "fleet admission: duplicate heavy work for owner $owner and source tree $tree" >&2 ;;
    esac
    exit 75
  fi
  printf '%s\n' "$$" >"$lock/pid"
  printf '%s\n' "$owner" >"$lock/owner"
  printf '%s\n' "$tree" >"$lock/tree"
  held+=("$lock")
done
"$@" &
child=$!
set +e
wait "$child"
status=$?
set -e
child=
exit "$status"
