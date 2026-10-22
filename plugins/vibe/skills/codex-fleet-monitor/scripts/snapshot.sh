#!/bin/zsh
# Usage: snapshot.sh <workDir>. One line per watched item; any changed line is an event.
# With RECOVER=1 (watch.sh sets it) it first runs a recover.mjs pass on each machine that has sessions.
# State files of PRs no longer in prs.txt are removed. prs.txt lines are `<owner/repo> <number> [<writer>]`.
# <workDir> is a fleet home (its active program), a program dir or a flat work dir; work-dir.mjs resolves it.
K=${0:A:h}; env_lines=$(node $K/work-dir.mjs sh ${1:?workDir}) || exit 2; eval "$env_lines"
: ${STALL_SECONDS:=720} ${BOT_LOGIN_REGEX:=vercel|codex|github-actions|copilot|bot} ${REMOTE_SHELL:=zsh -lic}
: > $W/live.txt
HIGH=${USAGE_HIGH_PERCENT:-${MOVE_AT_PERCENT:-}}
# Ships the scripts (ratelimit.mjs and recover.mjs import liveness.mjs) to REMOTE_HOST and runs one there.
# The recovery settings travel as environment; CONTINUE_PROMPT_FILE there is REMOTE_CONTINUE_PROMPT_FILE.
remote_node() {
  local d=$REMOTE_STATE_DIR/.fleet-monitor
  local e="USAGE_HIGH_PERCENT=$HIGH AUTO_RESTART_DAEMON=${AUTO_RESTART_DAEMON:-} RECOVERY_BACKOFF_SECONDS=${${RECOVERY_BACKOFF_SECONDS:-}// /,}"
  e+=" RESTART_COOLDOWN_SECONDS=${RESTART_COOLDOWN_SECONDS:-} CONTINUE_PROMPT_FILE=${REMOTE_CONTINUE_PROMPT_FILE:-}"
  e+=" PASS_TIMEOUT_SECONDS=${PASS_TIMEOUT_SECONDS:-} LOG_MAX_BYTES=${LOG_MAX_BYTES:-} SUPERVISOR_RSS_CAP_MB=${SUPERVISOR_RSS_CAP_MB:-}"
  e+=" CODEX_MODEL=${CODEX_MODEL:-} CODEX_EFFORT=${CODEX_EFFORT:-}"
  COPYFILE_DISABLE=1 tar -C $K -cf - liveness.mjs ratelimit.mjs recover.mjs 2>/dev/null | ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 \
    ${REMOTE_HOST:?set REMOTE_HOST} "mkdir -p $d && tar -C $d -xf - && $REMOTE_SHELL 'env $e node $d/$*'" 2>/dev/null
}
# A failed gh call prints nothing; keep the last non-empty value for that key so a blip is not an event.
zmodload zsh/datetime
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
    PASS_TIMEOUT_SECONDS=${PASS_TIMEOUT_SECONDS:-} LOG_MAX_BYTES=${LOG_MAX_BYTES:-} \
    node $K/recover.mjs ${LOCAL_STATE_DIR:?set LOCAL_STATE_DIR} ${=L} >/dev/null 2>&1
  [ -n "${R// }" ] && remote_node recover.mjs $REMOTE_STATE_DIR $R >/dev/null
fi
if [ -n "${L// }" ]; then
  SUPERVISOR_RSS_CAP_MB=${SUPERVISOR_RSS_CAP_MB:-} node $K/recover.mjs --report $LOCAL_STATE_DIR local
  CODEX_MODEL=${CODEX_MODEL:-} CODEX_EFFORT=${CODEX_EFFORT:-} node $K/liveness.mjs ${LOCAL_STATE_DIR:?set LOCAL_STATE_DIR} ${=L} | sed 's/^/local /' >> $W/live.txt
fi
if [ -n "${R// }" ]; then
  out=$(remote_node recover.mjs --report $REMOTE_STATE_DIR remote); echo "${out:-recovery remote unreadable}"
  out=$(remote_node liveness.mjs $REMOTE_STATE_DIR $R)
  if [ -n "$out" ]; then echo "$out" | sed 's/^/remote /' >> $W/live.txt
  else echo "session remote $REMOTE_HOST UNREACHABLE"; fi
fi
USAGE_HIGH_PERCENT=$HIGH node $K/ratelimit.mjs local 2>/dev/null
[ "${CLAUDE_USAGE:-1}" = 0 ] || USAGE_HIGH_PERCENT=$HIGH CLAUDE_USAGE_SECONDS=${CLAUDE_USAGE_SECONDS:-} node $K/claude-usage.mjs $W local 2>/dev/null
if [ -n "${REMOTE_HOST:-}" ]; then out=$(remote_node ratelimit.mjs remote); echo "${out:-codex-usage remote unreadable READFAIL}"; fi
if [ -n "${REQUESTS_DIR:-}" ]; then requests local ls -t $REQUESTS_DIR; fi
if [ -n "${REMOTE_REQUESTS_DIR:-}" ]; then requests remote ssh -o ConnectTimeout=10 ${REMOTE_HOST:?set REMOTE_HOST} "ls -t $REMOTE_REQUESTS_DIR"; fi
zsh $K/classify.sh $W/item-history.txt $STALL_SECONDS ${QUESTION_SECONDS:-900} < $W/live.txt
# The watch set is prs.txt plus every open PR in WATCH_NEW_PR_REPOS that PR_SEARCH lists or that
# WATCH_PR_AUTHOR (default the gh account) opened, whatever its branch prefix: a hand-kept prs.txt once held
# only merged PRs while a writer sat silent for 1h40m on two live ones, so STALE-PR never ran on them.
# A PR another chat owns is never added or reported: one listed in prs-ignore.txt, or in another program's prs.txt
# in the same fleet home. Discovery once put a PR another chat was shepherding in this fleet's watch set.
touch $W/prs.txt
others=$({ cat $W/prs-ignore.txt; [ -n "$FLEET_HOME" ] && for p in $FLEET_HOME/programs/*/prs.txt(N); do [ $p != $W/prs.txt ] && cat $p; done } 2>/dev/null | awk '{print $1" "$2}')
for r in ${=WATCH_NEW_PR_REPOS}; do
  op=$(gh pr list -R $r --state open --search "${PR_SEARCH:-}" --json number --jq '.[].number' 2>/dev/null | sort -n | tr '\n' ' ')
  echo "open-prs $r $(keep open-$r "$op")"
  mine=$(gh pr list -R $r --state open --author "${WATCH_PR_AUTHOR:-@me}" --json number --jq '.[].number' 2>/dev/null)
  for n in ${=op} ${(f)mine}; do
    [[ $'\n'$others$'\n' == *$'\n'"$r $n"$'\n'* ]] && continue
    grep -Eq "^$r $n( |\$)" $W/prs.txt || echo "$r $n" >> $W/prs.txt
  done
done
# keep-<field>-<repo>-<n>, merge-<repo>-<n> and checks-<repo>-<n> files of a PR that left prs.txt are removed.
prune_pr_state() {
  local -A live; local r n f rest
  [ -f $W/prs.txt ] && while read r n _; do [ -n "$n" ] && live[${r//[^A-Za-z0-9_-]/_}-$n]=1 && live[${r//\//_}-$n]=1; done < $W/prs.txt
  for f in $W/keep-(st|c|v|i|t|ck|pu)-*.txt(N) $W/merge-*.txt(N) $W/checks-*.txt(N); do
    rest=${${f:t:r}#keep-}; rest=${rest#*-}
    [ -n "${live[$rest]:-}" ] || rm -f $f
  done
}
prune_pr_state
[ -s $W/prs.txt ] || exit 0
ME=${MY_GH_LOGIN:-$(gh api user --jq .login 2>/dev/null)}
skip="(.user.login==\"$ME\" or (.user.login|test(\"$BOT_LOGIN_REGEX\";\"i\")))"
THREADS='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved}}}}}'
done_prs=()
while read r n owner; do
  [ -z "$n" ] && continue
  [[ $'\n'$others$'\n' == *$'\n'"$r $n"$'\n'* ]] && continue
  st=$(gh pr view $n -R $r --json state,headRefOid,reviewDecision,mergeable --jq '"\(.state) \(.headRefOid[0:8]) \(.reviewDecision) \(.mergeable)"' 2>/dev/null); st=$(keep st-$r-$n "$st")
  m=${st##* }; k=$W/merge-${r//\//_}-$n.txt
  # GitHub reports UNKNOWN while it recomputes; keep the last known value so it does not flap.
  if [ "$m" = UNKNOWN ] && [ -f $k ]; then m=$(cat $k); else echo $m > $k; fi
  st="${st% *} $m"
  c=$(gh api "repos/$r/issues/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); c=$(keep c-$r-$n "$c")
  v=$(gh api "repos/$r/pulls/$n/reviews" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); v=$(keep v-$r-$n "$v")
  i=$(gh api "repos/$r/pulls/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null); i=$(keep i-$r-$n "$i")
  # Unresolved review threads block a merge on their own, with approvals and auto-merge in place; approved PRs once
  # sat blocked for hours while their writers waited for auto-merge, so the block is its own word on the line.
  t=$(gh api graphql -f query="$THREADS" -F o=${r%%/*} -F n=${r#*/} -F p=$n --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)]|length' 2>/dev/null); t=$(keep t-$r-$n "$t")
  ck=$(gh pr checks $n -R $r 2>/dev/null | awk -F'\t' '{print $2}' | sort | uniq -c | tr -s ' ' | tr '\n' ',')
  # Report only settled results: while any check is pending, repeat the last settled value. An empty
  # answer (a failed call, or GitHub re-listing the checks) repeats the last printed value instead.
  kc=$W/checks-${r//\//_}-$n.txt
  if [ -z "$ck" ]; then ck=$(keep ck-$r-$n "")
  elif [[ "$ck" == *pending* ]]; then ck=$(keep ck-$r-$n "$(cat $kc 2>/dev/null) (running)")
  else echo "$ck" > $kc; ck=$(keep ck-$r-$n "$ck"); fi
  blocked=; [[ ${st%% *} == OPEN && ${t:-0} -gt 0 ]] && blocked=" BLOCKED(unresolved threads)"
  # An open PR that needs its writer (threads, a conflict, a draft, a failed check) with no push for
  # STALE_PR_SECONDS is STALE-PR, however busy the writer looks: one sat 6 hours on 5 threads with no push.
  pu=$(gh pr view $n -R $r --json isDraft,commits --jq '"\(.isDraft) \(.commits[-1].commit.committedDate)"' 2>/dev/null); pu=$(keep pu-$r-$n "$pu")
  stale=; pushed=0
  [[ -n ${pu#* } ]] && TZ=UTC strftime -r -s pushed '%Y-%m-%dT%H:%M:%SZ' "${pu#* }" 2>/dev/null
  if [[ ${st%% *} == OPEN && $pushed -gt 0 && $(( EPOCHSECONDS - pushed )) -ge ${STALE_PR_SECONDS:-2700} ]] &&
     [[ ${t:-0} -gt 0 || $m == CONFLICTING || ${pu%% *} == true || $ck == *fail* ]]; then
    stale=" STALE-PR(no push for ${STALE_PR_SECONDS:-2700}s+${owner:+ owner=$owner})"
  fi
  # A merged or closed PR is reported this once, then leaves the watch set.
  [[ ${st%% *} == (MERGED|CLOSED) ]] && done_prs+=("$r $n")
  echo "pr $r#$n $st comments=$c reviews=$v inline=$i threads=$t checks=$ck$blocked$stale"
done < $W/prs.txt
for d in $done_prs; do grep -Ev "^$d( |\$)" $W/prs.txt > $W/prs.txt.tmp; mv $W/prs.txt.tmp $W/prs.txt; done
