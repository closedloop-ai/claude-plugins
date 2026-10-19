#!/bin/zsh
# Usage: snapshot.sh <workDir>. One line per watched item; any changed line is an event.
K=${0:A:h}; W=${1:?workDir}; [ -f $W/config.env ] && source $W/config.env
: ${STALL_SECONDS:=720} ${BOT_LOGIN_REGEX:=vercel|codex|github-actions|copilot|bot} ${REMOTE_SHELL:=zsh -lic}
: > $W/live.txt
# "<where> <name>" reads <stateDir>/<name>.json; "<where> <label> <threadId>" names the thread directly.
L=$(awk '$1=="local"{print (NF>=3 ? $2"="$3 : $2)}' $W/sessions.txt 2>/dev/null | tr '\n' ' ')
if [ -n "${L// }" ]; then
  node $K/liveness.mjs ${LOCAL_STATE_DIR:?set LOCAL_STATE_DIR} ${=L} | sed 's/^/local /' >> $W/live.txt
fi
R=$(awk '$1=="remote"{print (NF>=3 ? $2"="$3 : $2)}' $W/sessions.txt 2>/dev/null | tr '\n' ' ')
if [ -n "${R// }" ]; then
  rl=$REMOTE_STATE_DIR/.fleet-liveness.mjs
  out=$(ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 ${REMOTE_HOST:?set REMOTE_HOST} \
    "cat > $rl && $REMOTE_SHELL 'node $rl $REMOTE_STATE_DIR $R'" < $K/liveness.mjs 2>/dev/null)
  if [ -n "$out" ]; then echo "$out" | sed 's/^/remote /' >> $W/live.txt
  else echo "session remote $REMOTE_HOST UNREACHABLE"; fi
fi
zsh $K/classify.sh $W/item-history.txt $STALL_SECONDS < $W/live.txt
for r in ${=WATCH_NEW_PR_REPOS}; do
  echo "open-prs $r $(gh pr list -R $r --state open --search "${PR_SEARCH:-}" --json number --jq '.[].number' 2>/dev/null | sort -n | tr '\n' ' ')"
done
[ -s $W/prs.txt ] || exit 0
ME=${MY_GH_LOGIN:-$(gh api user --jq .login 2>/dev/null)}
skip="(.user.login==\"$ME\" or (.user.login|test(\"$BOT_LOGIN_REGEX\";\"i\")))"
while read r n; do
  [ -z "$n" ] && continue
  st=$(gh pr view $n -R $r --json state,headRefOid,reviewDecision,mergeable --jq '"\(.state) \(.headRefOid[0:8]) \(.reviewDecision) \(.mergeable)"' 2>/dev/null)
  m=${st##* }; k=$W/merge-${r//\//_}-$n.txt
  # GitHub reports UNKNOWN while it recomputes; keep the last known value so it does not flap.
  if [ "$m" = UNKNOWN ] && [ -f $k ]; then m=$(cat $k); else echo $m > $k; fi
  st="${st% *} $m"
  c=$(gh api "repos/$r/issues/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null)
  v=$(gh api "repos/$r/pulls/$n/reviews" --jq "[.[]|select($skip|not)]|length" 2>/dev/null)
  i=$(gh api "repos/$r/pulls/$n/comments" --jq "[.[]|select($skip|not)]|length" 2>/dev/null)
  ck=$(gh pr checks $n -R $r 2>/dev/null | awk -F'\t' '{print $2}' | sort | uniq -c | tr -s ' ' | tr '\n' ',')
  echo "pr $r#$n $st comments=$c reviews=$v inline=$i checks=$ck"
done < $W/prs.txt
