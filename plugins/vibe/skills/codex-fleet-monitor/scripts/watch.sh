#!/bin/zsh
# Usage: watch.sh <workDir> [intervalSeconds]. Exits with the diff on the first change, or with HEARTBEAT
# after HEARTBEAT_SECONDS (config.env or environment, default 1800) with none, so an armed watcher wakes its
# orchestrator at least that often to read teammate messages: writers' questions once sat unread for 7 hours.
# <workDir> resolves through work-dir.mjs, so a fleet home watches its active program's dir.
K=${0:A:h}; I=${2:-120}; H=${HEARTBEAT_SECONDS:-}
env_lines=$(node $K/work-dir.mjs sh ${1:?workDir}) || exit 2; eval "$env_lines"
H=${H:-${HEARTBEAT_SECONDS:-1800}}; T=$(( H / I )); (( T < 1 )) && T=1
S=${WATCH_SNAPSHOT:-$K/snapshot.sh}
snapshot() {
  local recover=${1:-0} event digest current
  if (( recover )); then current=$(RECOVER=1 zsh $S $W); else current=$(zsh $S $W); fi
  print -r -- "$current"
  for event in $W/events/*(.N); do
    digest=$(cksum < "$event")
    print -r -- "event ${event:t} ${digest%% *}"
  done
}
# Read times and sources belong in the full snapshot, outside the comparison key.
snapshot_key() {
  print -r -- "$1" | sed -E '/^codex-usage /s/ read=[^ ]+ source=[^ ]+//'
}
without_claude_usage() {
  print -r -- "$1" | sed -E '/^(claude-usage|usage claude)( |$)/d'
}
watch_usage() {
  local before=$1 current=$2
  shift 2
  printf '%s\0%s' "$before" "$current" | node "$K/watch-usage-state.mjs" "$W" "$@"
}
watch_visible() {
  if [ -f "$W/board.json" ]; then
    print -r -- "$1" | node "$K/../../fleet-orchestrator/scripts/writer-retirement.mjs" "$W/board.json"
  else print -r -- "$1"; fi
}
# One watcher per work dir. A second copy (one started with `&` in a foreground shell, then started again)
# double-reports every event and outlives the turn that started it, so it is refused, not run.
lock=$W/watch.lock
if ! mkdir $lock 2>/dev/null; then
  other=$(cat $lock/pid 2>/dev/null)
  if [ -n "$other" ] && [ "$other" -gt 1 ] && kill -0 $other 2>/dev/null; then
    print -u2 "watch.sh: watcher pid $other already runs for $W; read its events when it exits, then start it again with your harness's background option (run_in_background), never with &. A detached copy reports to nobody: stop it with 'node <vibe plugin>/hooks/kill-guard.mjs own $other' and 'kill $other' as two steps, then wait out its sleep tick before starting it again"
    exit 3
  fi
  rm -rf $lock; mkdir $lock || exit 3
fi
print $$ > $lock/pid
trap 'if [[ $(cat "$lock/pid" 2>/dev/null) == $$ ]]; then rm -f "$lock/pid" && rmdir "$lock"; fi' EXIT
trap 'exit 143' TERM HUP INT
# watcher.json records this watcher's pid and last tick, and its exit, so watcher.mjs can tell a lapsed watcher.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
identity=$(node --input-type=module -e 'const {readProcessIdentity} = await import(process.argv[1]); const id = readProcessIdentity(Number(process.argv[2])); if (!id) process.exit(1); console.log(JSON.stringify(id));' "$K/../../../shared/process-identity.mjs" $$) || exit 2
beat() {
  local extra=${1:-}
  print -r -- "{\"pid\":$$,\"identity\":$identity,\"startedAt\":\"$started\",\"lastTickAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"intervalSeconds\":$I$extra}" > $W/watcher.json.tmp && mv $W/watcher.json.tmp $W/watcher.json
}
finish_watch() {
  [[ $(cat "$lock/pid" 2>/dev/null) == $$ ]] || return
  local row=$(cat "$W/watcher.json" 2>/dev/null)
  if [[ "$row" == "{\"pid\":$$,\"identity\":$identity,\"startedAt\":\"$started\","* ]]; then
    beat ",\"exitedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  fi
  rm -f "$lock/pid" && rmdir "$lock"
}
trap 'finish_watch' EXIT
beat
# Compare against the last snapshot the previous run saw, so a change between runs is still reported.
if [ -s $W/last-snapshot.txt ]; then
  base=$(cat $W/last-snapshot.txt)
else
  base=$(snapshot)
  if [ ! -e $W/last-snapshot.txt ]; then watch_usage "$base" "" reset || exit 2; fi
  echo "$base" > $W/last-snapshot.txt
fi
for _ in $(seq 1 $T); do
  sleep $I
  # Each tick runs a recovery pass first (recover.mjs), so a transient failure is resumed without you.
  now=$(snapshot 1)
  before_visible=$(watch_visible "$base"); now_visible=$(watch_visible "$now")
  usage_events=""
  if [ -n "$now" ]; then usage_events=$(watch_usage "$before_visible" "$now_visible") || exit 2; fi
  before_other=$(without_claude_usage "$before_visible"); now_other=$(without_claude_usage "$now_visible")
  base_key=$(snapshot_key "$before_other"); now_key=$(snapshot_key "$now_other")
  beat
  if [ -n "$now" ] && { [ "$now_key" != "$base_key" ] || [ -n "$usage_events" ]; }; then
    echo "$now" > $W/last-snapshot.txt
    echo EVENT
    if [ "$now_key" != "$base_key" ]; then diff <(echo "$before_other") <(echo "$now_other") | grep '^[<>]'; fi
    if [ -n "$usage_events" ]; then print -r -- "$usage_events"; fi
    exit 0
  fi
  echo "$now" > $W/last-snapshot.txt
  base=$now
done
echo "HEARTBEAT no change for ${H}s: read every teammate message and each idle writer's question, then re-arm"; cat $W/last-snapshot.txt
