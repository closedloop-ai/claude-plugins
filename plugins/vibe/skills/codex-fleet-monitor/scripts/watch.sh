#!/bin/zsh
# Usage: watch.sh <workDir> [intervalSeconds]. Exits with the diff on the first change, or with HEARTBEAT
# after HEARTBEAT_SECONDS (config.env or environment, default 1800) with none, so an armed watcher wakes its
# orchestrator at least that often to read teammate messages: writers' questions once sat unread for 7 hours.
K=${0:A:h}; W=${1:?workDir}; I=${2:-120}
H=${HEARTBEAT_SECONDS:-$([ -f $W/config.env ] && sed -n 's/^HEARTBEAT_SECONDS=\([0-9][0-9]*\).*/\1/p' $W/config.env | tail -1)}
H=${H:-1800}; T=$(( H / I )); (( T < 1 )) && T=1
S=${WATCH_SNAPSHOT:-$K/snapshot.sh}
# One watcher per work dir. A second copy (one started with `&` in a foreground shell, then started again)
# double-reports every event and outlives the turn that started it, so it is refused, not run.
lock=$W/watch.lock
if ! mkdir $lock 2>/dev/null; then
  other=$(cat $lock/pid 2>/dev/null)
  if [ -n "$other" ] && [ "$other" -gt 1 ] && kill -0 $other 2>/dev/null; then
    print -u2 "watch.sh: watcher pid $other already runs for $W; read its events when it exits, then start it again with your harness's background option (run_in_background), never with &"
    exit 3
  fi
  rm -rf $lock; mkdir $lock || exit 3
fi
print $$ > $lock/pid
trap 'rm -rf $lock' EXIT
trap 'exit 143' TERM HUP INT
# watcher.json records this watcher's pid and last tick, and its exit, so watcher.mjs can tell a lapsed watcher.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
beat() {
  local extra=${1:-}
  print -r -- "{\"pid\":$$,\"startedAt\":\"$started\",\"lastTickAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"intervalSeconds\":$I$extra}" > $W/watcher.json.tmp && mv $W/watcher.json.tmp $W/watcher.json
}
beat
# Compare against the last snapshot the previous run saw, so a change between runs is still reported.
if [ -s $W/last-snapshot.txt ]; then base=$(cat $W/last-snapshot.txt); else base=$(zsh $S $W); echo "$base" > $W/last-snapshot.txt; fi
for _ in $(seq 1 $T); do
  sleep $I
  # Each tick runs a recovery pass first (recover.mjs), so a transient failure is resumed without you.
  now=$(RECOVER=1 zsh $S $W)
  beat
  if [ -n "$now" ] && [ "$now" != "$base" ]; then
    echo "$now" > $W/last-snapshot.txt; beat ",\"exitedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""; echo EVENT; diff <(echo "$base") <(echo "$now") | grep '^[<>]'; exit 0
  fi
done
beat ",\"exitedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
echo "HEARTBEAT no change for ${H}s: read every teammate message and each idle writer's question, then re-arm"; cat $W/last-snapshot.txt
