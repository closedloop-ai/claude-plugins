#!/bin/zsh
# Usage: snapshot.sh <workDir>. One line per watched item; any changed line is an event.
# With RECOVER=1 (watch.sh sets it) it first runs a recover.mjs pass on each machine that has sessions.
K=${0:A:h}; W=${1:?workDir}; [ -f $W/config.env ] && source $W/config.env
: ${STALL_SECONDS:=720} ${BOT_LOGIN_REGEX:=vercel|codex|github-actions|copilot|bot} ${REMOTE_SHELL:=zsh -lic}
: > $W/live.txt
HIGH=${USAGE_HIGH_PERCENT:-${MOVE_AT_PERCENT:-}}
# Ships the scripts (ratelimit.mjs and recover.mjs import liveness.mjs) to REMOTE_HOST and runs one there.
# The recovery settings travel as environment; CONTINUE_PROMPT_FILE there is REMOTE_CONTINUE_PROMPT_FILE.
remote_node() {
  local d=$REMOTE_STATE_DIR/.fleet-monitor
  local e="USAGE_HIGH_PERCENT=$HIGH AUTO_RESTART_DAEMON=${AUTO_RESTART_DAEMON:-} RECOVERY_BACKOFF_SECONDS=${${RECOVERY_BACKOFF_SECONDS:-}// /,}"
  e+=" RESTART_COOLDOWN_SECONDS=${RESTART_COOLDOWN_SECONDS:-} CONTINUE_PROMPT_FILE=${REMOTE_CONTINUE_PROMPT_FILE:-}"
  COPYFILE_DISABLE=1 tar -C $K -cf - liveness.mjs ratelimit.mjs recover.mjs 2>/dev/null | ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 \
    ${REMOTE_HOST:?set REMOTE_HOST} "mkdir -p $d && tar -C $d -xf - && $REMOTE_SHELL 'env $e node $d/$*'" 2>/dev/null
}
# A failed gh call prints nothing; keep the last non-empty value for that key so a blip is not an event.
keep() { local f=$W/keep-${1//[^A-Za-z0-9_-]/_}.txt; if [ -n "$2" ]; then echo "$2" > $f; echo "$2"; elif [ -f $f ]; then cat $f; fi; }
# "requests <where> <count> <newest file>" from a newest-first listing command.
requests() {
  local where=$1 out; shift
  if out=$("$@" 2>/dev/null); then printf '%s' "$out" | awk -v w=$where 'NR==1{f=$0} END{print "requests", w, NR, (NR ? f : "-")}'
  else echo "requests $where UNREADABLE"; fi
}
# "<where> <name>" reads <stateDir>/<name>.json; "<where> <label> <threadId>" names the thread directly.
L=$(awk '$1=="local"{print (NF>=3 ? $2"="$3 : $2)}' $W/sessions.txt 2>/dev/null | tr '\n' ' ')
R=$(awk '$1=="remote"{print (NF>=3 ? $2"="$3 : $2)}' $W/sessions.txt 2>/dev/null | tr '\n' ' ')
if [ "${RECOVER:-}" = 1 ]; then
  [ -n "${L// }" ] && AUTO_RESTART_DAEMON=${AUTO_RESTART_DAEMON:-} RECOVERY_BACKOFF_SECONDS=${RECOVERY_BACKOFF_SECONDS:-} \
    RESTART_COOLDOWN_SECONDS=${RESTART_COOLDOWN_SECONDS:-} CONTINUE_PROMPT_FILE=${CONTINUE_PROMPT_FILE:-} \
    node $K/recover.mjs ${LOCAL_STATE_DIR:?set LOCAL_STATE_DIR} ${=L} >/dev/null 2>&1
  [ -n "${R// }" ] && remote_node recover.mjs $REMOTE_STATE_DIR $R >/dev/null
fi
if [ -n "${L// }" ]; then
  node $K/recover.mjs --report $LOCAL_STATE_DIR local
  node $K/liveness.mjs ${LOCAL_STATE_DIR:?set LOCAL_STATE_DIR} ${=L} | sed 's/^/local /' >> $W/live.txt
fi
if [ -n "${R// }" ]; then
  out=$(remote_node recover.mjs --report $REMOTE_STATE_DIR remote); echo "${out:-recovery remote unreadable}"
  out=$(remote_node liveness.mjs $REMOTE_STATE_DIR $R)
  if [ -n "$out" ]; then echo "$out" | sed 's/^/remote /' >> $W/live.txt
  else echo "session remote $REMOTE_HOST UNREACHABLE"; fi
fi
USAGE_HIGH_PERCENT=$HIGH node $K/ratelimit.mjs local 2>/dev/null
if [ -n "${REMOTE_HOST:-}" ]; then out=$(remote_node ratelimit.mjs remote); echo "${out:-codex-usage remote unreadable READFAIL}"; fi
if [ -n "${REQUESTS_DIR:-}" ]; then requests local ls -t $REQUESTS_DIR; fi
if [ -n "${REMOTE_REQUESTS_DIR:-}" ]; then requests remote ssh -o ConnectTimeout=10 ${REMOTE_HOST:?set REMOTE_HOST} "ls -t $REMOTE_REQUESTS_DIR"; fi
zsh $K/classify.sh $W/item-history.txt $STALL_SECONDS < $W/live.txt
for r in ${=WATCH_NEW_PR_REPOS}; do
  op=$(gh pr list -R $r --state open --search "${PR_SEARCH:-}" --json number --jq '.[].number' 2>/dev/null | sort -n | tr '\n' ' ')
  echo "open-prs $r $(keep open-$r "$op")"
done
[ -s $W/prs.txt ] || exit 0
ME=${MY_GH_LOGIN:-$(gh api user --jq .login 2>/dev/null)}
skip="(.user.login==\"$ME\" or (.user.login|test(\"$BOT_LOGIN_REGEX\";\"i\")))"
while read r n; do
  [ -z "$n" ] && continue
  st=$(gh pr view $n -R $r --json state,headRefOid,reviewDecision,mergeable --jq '"\(.state) \(.headRefOid[0:8]) \(.reviewDecision) \(.mergeable)"' 2>/dev/null); st=$(keep st-$r-$n "$st")
  m=${st##* }; k=$W/merge-${r//\//_}-$n.txt
  # GitHub reports UNKNOWN while it recomputes; keep the last known value so it does not flap.
  if [ "$m" = UNKNOWN ] && [ -f $k ]; then m=$(cat $k); else echo $m > $k; fi
  st="${st% *} $m"
  c=$(gh api "repos/$r/issues/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); c=$(keep c-$r-$n "$c")
  v=$(gh api "repos/$r/pulls/$n/reviews" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); v=$(keep v-$r-$n "$v")
  i=$(gh api "repos/$r/pulls/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); i=$(keep i-$r-$n "$i")
  ck=$(gh pr checks $n -R $r 2>/dev/null | awk -F'\t' '{print $2}' | sort | uniq -c | tr -s ' ' | tr '\n' ',')
  # Report only settled results: while any check is pending, repeat the last settled value. An empty
  # answer (a failed call, or GitHub re-listing the checks) repeats the last printed value instead.
  kc=$W/checks-${r//\//_}-$n.txt
  if [ -z "$ck" ]; then ck=$(keep ck-$r-$n "")
  elif [[ "$ck" == *pending* ]]; then ck=$(keep ck-$r-$n "$(cat $kc 2>/dev/null) (running)")
  else echo "$ck" > $kc; ck=$(keep ck-$r-$n "$ck"); fi
  echo "pr $r#$n $st comments=$c reviews=$v inline=$i checks=$ck"
done < $W/prs.txt
