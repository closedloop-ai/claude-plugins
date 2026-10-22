#!/bin/zsh
# stdin: "<where> <stateName> <turnStatus> <progress> <flag>". $1: item history file. $2: stall seconds.
# A running turn whose progress (its newest item) has not changed for $2 seconds is STALLED (a Codex usage
# limit leaves the turn open and silent, so "turn is open" alone is not liveness).
H=$1; STALL=${2:-720}; touch $H; now=$(date +%s)
while read where n st items flag tail; do
  prev=$(grep "^$where:$n " $H | awk '{print $2, $3}'); pi=${prev% *}; pt=${prev#* }
  if [ -z "$prev" ] || [ "$pi" != "$items" ]; then pt=$now; fi
  grep -v "^$where:$n " $H > $H.tmp; echo "$where:$n $items $pt" >> $H.tmp; mv $H.tmp $H
  if [ "$flag" != "-" ]; then s="FAILED($flag)"
  elif [ "$st" = inProgress ] && [ $((now - pt)) -ge $STALL ]; then s="STALLED(no progress $((STALL / 60))m+)"
  elif [ "$st" = inProgress ]; then s=RUN
  elif [ "$st" = completed ]; then s="IDLE${tail:+ $tail}"
  else s="STOPPED($st)"; fi
  echo "session $where $n $s"
done
