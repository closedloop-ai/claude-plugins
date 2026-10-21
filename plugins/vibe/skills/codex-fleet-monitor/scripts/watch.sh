#!/bin/zsh
# Usage: watch.sh <workDir> [intervalSeconds]. Exits with the diff on the first change.
K=${0:A:h}; W=${1:?workDir}; I=${2:-120}
# Compare against the last snapshot the previous run saw, so a change between runs is still reported.
if [ -s $W/last-snapshot.txt ]; then base=$(cat $W/last-snapshot.txt); else base=$(zsh $K/snapshot.sh $W); echo "$base" > $W/last-snapshot.txt; fi
for _ in $(seq 1 200); do
  sleep $I
  # Each tick runs a recovery pass first (recover.mjs), so a transient failure is resumed without you.
  now=$(RECOVER=1 zsh $K/snapshot.sh $W)
  if [ -n "$now" ] && [ "$now" != "$base" ]; then
    echo "$now" > $W/last-snapshot.txt; echo EVENT; diff <(echo "$base") <(echo "$now") | grep '^[<>]'; exit 0
  fi
done
echo TIMEOUT; cat $W/last-snapshot.txt
