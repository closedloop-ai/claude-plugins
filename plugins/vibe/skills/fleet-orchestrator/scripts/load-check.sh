#!/usr/bin/env bash
# Usage: load-check.sh. Exits 0 when this machine can take a heavy run, 4 when its load per core is over
# MAX_LOAD_PER_CORE (default 1.5), naming the load so the run goes to the less loaded machine. A fixed
# machine choice once drove one laptop past twice its core count while the other sat idle.
# FLEET_FORCE_HERE=1 runs it here anyway; FLEET_LOAD="<load1> <cores>" stands in for the reading.
set -euo pipefail
reading=${FLEET_LOAD:-}
if [ -z "$reading" ]; then
  if [ -r /proc/loadavg ]; then load=$(cut -d' ' -f1 /proc/loadavg); else load=$(sysctl -n vm.loadavg | awk '{print $2}'); fi
  reading="$load $(getconf _NPROCESSORS_ONLN)"
fi
read -r load cores <<<"$reading"
max=${MAX_LOAD_PER_CORE:-1.5}
if awk -v l="$load" -v c="$cores" -v m="$max" 'BEGIN { exit !(c > 0 && l / c > m) }'; then
  if [ "${FLEET_FORCE_HERE:-}" = 1 ]; then
    echo "load-check: load $load on $cores cores is over $max per core; running here because FLEET_FORCE_HERE=1" >&2
    exit 0
  fi
  echo "load-check: load $load on $cores cores is over $max per core on $(hostname); run this heavy check on the other machine (fleet.sh <orchDir> local|remote slot heavy ...), or set FLEET_FORCE_HERE=1" >&2
  exit 4
fi
