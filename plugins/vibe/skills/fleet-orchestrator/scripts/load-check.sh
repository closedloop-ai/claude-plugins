#!/usr/bin/env bash
# Usage: load-check.sh [--evaluate <load1> <cores>]. Exits 0 when this machine can take a heavy run, 4 when its load per core is over
# MAX_LOAD_PER_CORE (default 1.5), naming the load so the run goes to the less loaded machine. A fixed
# machine choice once drove one laptop past twice its core count while the other sat idle.
# FLEET_FORCE_HERE=1 runs a bounded overload here only with an operator-set FLEET_FORCE_REASON.
# A load above four times the core count is never admitted. --evaluate exposes the pure policy for tests;
# fleet.sh never passes it, so a heavy slot always uses this machine's OS reading.
set -euo pipefail
if [ "${1:-}" = --evaluate ]; then
  [ "$#" -eq 3 ] || { echo "Usage: load-check.sh [--evaluate <load1> <cores>]" >&2; exit 2; }
  reading="$2 $3"
elif [ "$#" -eq 0 ]; then
  if [ -r /proc/loadavg ]; then load=$(cut -d' ' -f1 /proc/loadavg); else load=$(sysctl -n vm.loadavg | awk '{print $2}'); fi
  reading="$load $(getconf _NPROCESSORS_ONLN)"
else
  echo "Usage: load-check.sh [--evaluate <load1> <cores>]" >&2
  exit 2
fi
read -r load cores <<<"$reading"
max=${MAX_LOAD_PER_CORE:-1.5}
hard=4
if [ "${FLEET_FORCE_HERE:-}" = 1 ] && [ -z "${FLEET_FORCE_REASON:-}" ]; then
  echo "load-check: FLEET_FORCE_HERE=1 requires an operator-set reason; refusing load $load on $cores cores" >&2
  exit 4
fi
if awk -v l="$load" -v c="$cores" -v h="$hard" 'BEGIN { exit !(c > 0 && l / c > h) }'; then
  echo "load-check: load $load on $cores cores is over the hard ceiling of $hard per core on $(hostname); refusing even with FLEET_FORCE_HERE=1" >&2
  exit 4
fi
if awk -v l="$load" -v c="$cores" -v m="$max" 'BEGIN { exit !(c > 0 && l / c > m) }'; then
  if [ "${FLEET_FORCE_HERE:-}" = 1 ]; then
    echo "load-check: load $load on $cores cores is over $max per core; running here because FLEET_FORCE_HERE=1; force reason: $FLEET_FORCE_REASON" >&2
    exit 0
  fi
  echo "load-check: load $load on $cores cores is over $max per core on $(hostname); run this heavy check on the other machine (fleet.sh <orchDir> local|remote slot heavy ...)" >&2
  exit 4
fi
