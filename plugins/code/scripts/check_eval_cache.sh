#!/usr/bin/env bash
# Check if plan-evaluation.json is a valid cache hit (exists and newer than plan.json).
# Usage: check_eval_cache.sh <WORKDIR>
#
# Output (stdout, machine-parseable):
#   EVAL_CACHE_HIT
#   simple_mode: true|false
#   selected_critics: [critic1, critic2, ...]
#   summary: <cached evaluation summary>
#
#   -- or --
#
#   EVAL_CACHE_MISS
#   reason: <why the cache is stale or missing>

set -euo pipefail

WORKDIR="${1:?Usage: check_eval_cache.sh <WORKDIR>}"

PLAN_JSON="$WORKDIR/plan.json"
EVAL_JSON="$WORKDIR/plan-evaluation.json"

# --- existence checks ---
if [ ! -f "$PLAN_JSON" ]; then
  echo "EVAL_CACHE_MISS"
  echo "reason: plan.json does not exist"
  exit 0
fi

if [ ! -f "$EVAL_JSON" ]; then
  echo "EVAL_CACHE_MISS"
  echo "reason: plan-evaluation.json does not exist"
  exit 0
fi

# --- freshness check: eval must be newer than plan ---
if [ "$PLAN_JSON" -nt "$EVAL_JSON" ]; then
  echo "EVAL_CACHE_MISS"
  echo "reason: plan.json is newer than plan-evaluation.json (plan was modified)"
  exit 0
fi

# --- read cached values ---
simple_mode=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
print(str(d.get('simple_mode', False)).lower())
" "$EVAL_JSON" 2>/dev/null) || {
  echo "EVAL_CACHE_MISS"
  echo "reason: plan-evaluation.json is malformed"
  exit 0
}

selected_critics=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
print(json.dumps(d.get('selected_critics', [])))
" "$EVAL_JSON" 2>/dev/null) || selected_critics="[]"

summary=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
print(d.get('evaluation_summary', 'Cached result'))
" "$EVAL_JSON" 2>/dev/null) || summary="Cached result"

echo "EVAL_CACHE_HIT"
echo "simple_mode: $simple_mode"
echo "selected_critics: $selected_critics"
echo "summary: $summary"
