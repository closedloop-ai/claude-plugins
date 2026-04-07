#!/usr/bin/env bash
# Check if critic reviews are still valid (plan.json + critic-gates.json unchanged).
# Usage: check_critic_cache.sh <WORKDIR>
#
# Output (stdout, machine-parseable):
#   CRITIC_CACHE_HIT
#
#   — or —
#
#   CRITIC_CACHE_MISS
#   reason: <why the cache is stale or missing>

set -euo pipefail

WORKDIR="${1:?Usage: check_critic_cache.sh <WORKDIR>}"

PLAN_JSON="$WORKDIR/plan.json"
REVIEWS_DIR="$WORKDIR/reviews"
HASH_FILE="$REVIEWS_DIR/.plan-hash"

# --- existence checks ---
if [ ! -f "$PLAN_JSON" ]; then
  echo "CRITIC_CACHE_MISS"
  echo "reason: plan.json does not exist"
  exit 0
fi

if [ ! -d "$REVIEWS_DIR" ]; then
  echo "CRITIC_CACHE_MISS"
  echo "reason: reviews directory does not exist"
  exit 0
fi

# Check that at least one review file exists
review_count=$(find "$REVIEWS_DIR" -name "*.review.json" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
if [ "$review_count" -eq 0 ]; then
  echo "CRITIC_CACHE_MISS"
  echo "reason: no review files found in reviews directory"
  exit 0
fi

if [ ! -f "$HASH_FILE" ]; then
  echo "CRITIC_CACHE_MISS"
  echo "reason: no cached plan hash found (reviews/.plan-hash missing)"
  exit 0
fi

# --- compute current combined hash ---
# Hash both plan.json and critic-gates.json (if it exists) to detect config changes
current_hash=""
CRITIC_GATES_PATH=".closedloop-ai/settings/critic-gates.json"
WORKDIR_STATE_DIR=$(dirname "$WORKDIR")
if [ -f "$CRITIC_GATES_PATH" ]; then
  current_hash=$(cat "$PLAN_JSON" "$CRITIC_GATES_PATH" | shasum -a 256 | cut -d' ' -f1)
elif [ -f "$WORKDIR_STATE_DIR/settings/critic-gates.json" ]; then
  current_hash=$(cat "$PLAN_JSON" "$WORKDIR_STATE_DIR/settings/critic-gates.json" | shasum -a 256 | cut -d' ' -f1)
else
  current_hash=$(shasum -a 256 "$PLAN_JSON" | cut -d' ' -f1)
fi

# --- compare against stored hash ---
stored_hash=$(head -1 "$HASH_FILE" 2>/dev/null | cut -d' ' -f1)

if [ "$current_hash" != "$stored_hash" ]; then
  echo "CRITIC_CACHE_MISS"
  echo "reason: plan.json or critic-gates.json changed since last critic run"
  exit 0
fi

echo "CRITIC_CACHE_HIT"
