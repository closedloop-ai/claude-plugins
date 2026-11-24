#!/bin/zsh
# Usage: watch.sh <workDir> [intervalSeconds]. Exits with the diff on the first change, or with HEARTBEAT
# after HEARTBEAT_SECONDS (config.env or environment, default 1800) with none, so an armed watcher wakes its
# orchestrator at least that often to read teammate messages: writers' questions once sat unread for 7 hours.
# <workDir> resolves through work-dir.mjs, so a fleet home watches its active program's dir.
K=${0:A:h}; I=${2:-120}; H=${HEARTBEAT_SECONDS:-}
env_lines=$(node $K/work-dir.mjs sh ${1:?workDir}) || exit 2; eval "$env_lines"
H=${H:-${HEARTBEAT_SECONDS:-1800}}; T=$(( H / I )); (( T < 1 )) && T=1
S=${WATCH_SNAPSHOT:-$K/snapshot.sh}
gap_script="$K/../../../lib/codex-fleet-monitor/scripts/watch-gap.mjs"
# An unreadable clock has no endpoint. Never pass it to shell arithmetic as epoch zero.
read_clock() {
  timestamp=$(date +%s) && [[ $timestamp == <0-9999999999> ]] || timestamp=''
}
sample_tick() {
  local start=$1 end=$2
  local -a windows
  # The filenames carry the clock window, so order them by epoch without following journal links.
  windows=( "$W"/watch-window.*.pending(N^/n) )
  if [[ -n $start && -n $end ]] && (( end - start > I + 120 )); then
    # Retire the window only after the helper commits it or saves it for retry.
    node "$gap_script" "$W" "$start" "$end" "$(uname -s)" "$windows[1]" "$base_gap" || return 1
    sampled_gap=1
  elif (( ${#windows} )); then
    node "$gap_script" publish "$W" "$windows[1]" "$base_gap"
  fi
  tick_start=$end
}
snapshot() {
  local recover=${1:-0} event digest current read_status
  if (( recover )); then
    current=$(RECOVER=1 zsh $S $W)
    read_status=$?
    read_clock
    sample_tick "$tick_start" "$timestamp"
    if (( read_status )) && [[ -z $current && -n $base_fleet ]]; then
      current=$(print -r -- "$base_fleet" | sed '/^event /d')
    fi
  else
    current=$(zsh $S $W)
  fi
  fleet=$current
  for event in $W/events/*(.N); do
    digest=$(cksum < "$event")
    fleet+=$'\n'"event ${event:t} ${digest%% *}"
  done
  read_gap "$recover"
}
read_gap() {
  local recover=$1 queued
  gap=$base_gap
  if (( recover )) && [[ -f $W/watch-gap ]]; then
    { IFS= read -r gap; IFS= read -r queued; } < "$W/watch-gap"
  fi
  if (( recover )); then
    if [[ -n $prepared_gap && $prepared_gap != "$written_gap" ]]; then gap=$prepared_gap; fi
    local -a pending
    pending=( "$W"/watch-sleep.*.retry(N.) )
    if [[ -n $queued ]] || (( ${#pending} )); then node "$gap_script" retry "$W" "${pending[@]}"; fi
  fi
  now=$fleet
  if [[ -n $gap ]]; then now+=${now:+$'\n'}"$gap"; fi
}
# A late final write belongs to this arm. A short tail can also push an otherwise ordinary tick over tolerance.
sample_final_gap() {
  read_clock
  local end=$timestamp start=$tick_start
  if [[ -z $start || -z $end ]]; then tick_start=$end; return 1; fi
  if (( !sampled_gap )) && [[ -n $iteration_start ]]; then start=$iteration_start; fi
  (( end - start > I + 120 )) || return 1
  sample_tick "$start" "$end" || return 2
  read_gap 1
}
# Read times and sources belong in usage reports, but they are not material watcher changes. Compare a fingerprint
# with those fields removed, then retain the newest full snapshot so a later real event reports current read times.
snapshot_key() {
  print -r -- "$1" | sed -E '/^(codex|claude)-usage /s/ read=[^ ]+ source=[^ ]+//'
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
trap 'rm -rf $lock' EXIT
trap 'exit 143' TERM HUP INT
# watcher.json records this watcher's pid and last tick, and its exit, so watcher.mjs can tell a lapsed watcher.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
beat() {
  local stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) extra=''
  if [[ $1 == exited ]]; then extra=",\"exitedAt\":\"$stamp\""; fi
  print -r -- "{\"pid\":$$,\"startedAt\":\"$started\",\"lastTickAt\":\"$stamp\",\"intervalSeconds\":$I$extra}" > $W/watcher.json.tmp && mv $W/watcher.json.tmp $W/watcher.json
}
acknowledge() {
  local file=${2:-$W/last-snapshot.txt} staged=$lock/last-snapshot.tmp
  if [[ ! -d $file ]] && echo "$1" > "$staged" && mv "$staged" "$file" && cmp -s "$file" <(echo "$1"); then return 0; fi
  print -u2 "watch.sh: could not acknowledge snapshot in $file"
  return 1
}
beat
read_clock; tick_start=$timestamp
# A documented fleet-baseline reset must keep the last delivered gap distinct from a pending publication.
gap_ack=$W/watch-gap-ack
if [[ ! -f $gap_ack ]]; then
  base_gap=''
  if [[ -s $W/last-snapshot.txt ]]; then base_gap=$(sed -n '/^watch-gap /p' "$W/last-snapshot.txt"); fi
  acknowledge "$base_gap" "$gap_ack" || exit 1
fi
# A legacy one-line record is the last delivered window. Matching preparation and delivery lines retire
# the exact gap. A preparation without the third line remains retryable.
{ IFS= read -r base_gap || exit 1
  IFS= read -r prepared_gap
  IFS= read -r written_gap || written_gap=''
} < "$gap_ack" || exit 1
if [[ -n $prepared_gap && $written_gap == "$prepared_gap" ]]; then base_gap=$written_gap; fi
# Compare against the last snapshot the previous run saw, so a change between runs is still reported.
if [ -s $W/last-snapshot.txt ]; then
  base_fleet=$(sed '/^watch-gap /d' "$W/last-snapshot.txt")
else
  snapshot; base_fleet=$fleet
  acknowledge "$now" || exit 1
fi
base_key=$(snapshot_key "$base_fleet")
for tick_number in $(seq 1 $T); do
  iteration_start=$tick_start; sampled_gap=0
  sleep $I
  # Each tick runs a recovery pass first (recover.mjs), so a transient failure is resumed without you.
  snapshot 1
  now_key=$(snapshot_key "$fleet")
  fleet_changed=0; gap_changed=0
  [[ -n $fleet && $now_key != "$base_key" ]] && fleet_changed=1
  [[ -n $gap && $gap != "$base_gap" ]] && gap_changed=1
  beat
  if (( fleet_changed || gap_changed || tick_number == T )); then
    beat exited
    snapshot_saved=1
    if ! acknowledge "$now"; then
      # The rename may have succeeded. Report the in-memory fleet diff and leave the gap pending.
      sample_final_gap
      (( fleet_changed )) || exit 1
      snapshot_saved=0
      gap_changed=0
    fi
    acknowledged_gap=$gap
    reported_gap=$base_gap
    while (( snapshot_saved )); do
      if [[ $acknowledged_gap != "$reported_gap" ]]; then
        preparation=$base_gap$'\n'$acknowledged_gap
        if ! cmp -s "$gap_ack" <(echo "$preparation") && ! acknowledge "$preparation" "$gap_ack"; then
          acknowledged_gap=$reported_gap
          [[ $reported_gap != "$base_gap" ]] || gap_changed=0
          (( fleet_changed || gap_changed )) || exit 1
          break
        fi
        reported_gap=$acknowledged_gap
      fi
      sample_final_gap
      case $? in
        1) break ;; # The arm is up to date.
        2) (( fleet_changed || gap_changed )) || exit 1; break ;;
      esac
      beat exited
      if [[ $gap != "$acknowledged_gap" ]]; then
        if ! acknowledge "$now"; then
          # An ordinary change may already be acknowledged. Emit only that change; the new gap stays pending.
          sample_final_gap
          (( fleet_changed || gap_changed )) || exit 1
          break
        fi
        acknowledged_gap=$gap
        gap_changed=1
      fi
    done
    if (( !fleet_changed && !gap_changed )); then
      echo "HEARTBEAT no change for ${H}s: read every teammate message and each idle writer's question, then re-arm"; echo "$fleet"
      exit 0
    fi
    if (( gap_changed )); then
      # Stage the complete record on the same filesystem before stdout, while file growth can still fail safely.
      delivered=$lock/last-snapshot.tmp
      record=$base_gap$'\n'$acknowledged_gap$'\n'$acknowledged_gap
      if ! { zmodload -F zsh/files b:zf_mv && print -r -- "$record" > "$delivered" && [[ $(<"$delivered") == "$record" ]]; }; then
        (( fleet_changed )) || exit 1
        gap_changed=0
      fi
    fi
    # Once the gap event starts, finish its output and retirement before a catchable stop can end this arm.
    if (( gap_changed )); then trap '' TERM HUP INT; fi
    echo EVENT || exit 1
    if (( fleet_changed )); then diff <(echo "$base_fleet") <(echo "$fleet") | grep '^[<>]'; fi
    if (( gap_changed )); then
      # A successful gap write only needs a same-filesystem rename. A failed write leaves the preparation in place.
      print -r -- "> ${acknowledged_gap#watch-gap * }" || exit 1
      # A failed rename leaves the prepared file in place. Its third line independently retires this identity.
      zf_mv -f -- "$delivered" "$gap_ack" || print -r -- "$acknowledged_gap" >> "$gap_ack" || exit 1
    fi
    exit 0
  fi
  if ! acknowledge "$now"; then
    sample_final_gap
    exit 1
  fi
  base_fleet=$fleet; base_gap=$gap; base_key=$now_key
done
