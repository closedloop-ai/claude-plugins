#!/bin/zsh
# stdin: "<where> <stateName> <turnStatus> <progress> <flag>". $1: item history file. $2: stall seconds.
# A running turn whose progress (its newest item) has not changed for $2 seconds is STALLED (a Codex usage
# limit leaves the turn open and silent, so "turn is open" alone is not liveness). A MODEL(...) word that
# liveness.mjs put first in the tail (a thread on another model or effort) is kept for every state.
# An IDLE writer whose final message asks something (NEEDS-REPLY) and has waited $3 seconds (default 900)
# is QUESTION-UNANSWERED: a writer once held its PR six hours on a question nobody answered.
H=$1; STALL=${2:-720}; ASK=${3:-900}; touch $H; now=$(date +%s)
while read where n st items flag tail; do
  prev=$(grep "^$where:$n " $H | awk '{print $2, $3}'); pi=${prev% *}; pt=${prev#* }
  if [ -z "$prev" ] || [ "$pi" != "$items" ]; then pt=$now; fi
  grep -v "^$where:$n " $H > $H.tmp; echo "$where:$n $items $pt" >> $H.tmp; mv $H.tmp $H
  drift=; if [[ $tail == MODEL\(* ]]; then drift=${tail%% *}; tail=${tail#$drift}; tail=${tail# }; fi
  if [ "$flag" != "-" ]; then s="FAILED($flag)"
  elif [ "$st" = inProgress ] && [ $((now - pt)) -ge $STALL ]; then s="STALLED(no progress $((STALL / 60))m+)"
  elif [ "$st" = inProgress ]; then s=RUN
  elif [ "$st" = completed ] && [[ $tail == NEEDS-REPLY* ]] && [ $((now - pt)) -ge $ASK ]; then s="IDLE QUESTION-UNANSWERED($((ASK / 60))m+) $tail"
  elif [ "$st" = completed ]; then s="IDLE${tail:+ $tail}"
  else s="STOPPED($st)"; fi
  echo "session $where $n $s${drift:+ $drift}"
done
