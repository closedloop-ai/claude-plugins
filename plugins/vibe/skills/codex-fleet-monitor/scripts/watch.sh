#!/bin/zsh
# Usage: watch.sh <workDir> [intervalSeconds]. Exits with the diff on the first change.
K=${0:A:h}; W=${1:?workDir}; I=${2:-120}
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
if [ -s $W/last-snapshot.txt ]; then base=$(cat $W/last-snapshot.txt); else base=$(zsh $K/snapshot.sh $W); echo "$base" > $W/last-snapshot.txt; fi
for _ in $(seq 1 200); do
  sleep $I
  # Each tick runs a recovery pass first (recover.mjs), so a transient failure is resumed without you.
  now=$(RECOVER=1 zsh $K/snapshot.sh $W)
  beat
  if [ -n "$now" ] && [ "$now" != "$base" ]; then
    echo "$now" > $W/last-snapshot.txt; beat ",\"exitedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""; echo EVENT; diff <(echo "$base") <(echo "$now") | grep '^[<>]'; exit 0
  fi
done
beat ",\"exitedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
echo TIMEOUT; cat $W/last-snapshot.txt
