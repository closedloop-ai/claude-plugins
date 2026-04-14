#!/usr/bin/env bash
# Stamp the critic cache after reviews complete.
# Usage: stamp_critic_cache.sh <WORKDIR>
#
# Hashes plan.json (+ critic-gates.json if present) and writes to
# <WORKDIR>/reviews/.plan-hash so subsequent runs can skip critics.
#
# Probe paths match check_critic_cache.sh: CWD-relative first,
# then $(dirname WORKDIR)/settings/ as fallback.

set -euo pipefail

WORKDIR="${1:?Usage: stamp_critic_cache.sh <WORKDIR>}"

CRITIC_GATES_PATH=".closedloop-ai/settings/critic-gates.json"
WORKDIR_STATE_DIR=$(dirname "$WORKDIR")

if [ -f "$CRITIC_GATES_PATH" ]; then
  cat "$WORKDIR/plan.json" "$CRITIC_GATES_PATH" | shasum -a 256 | cut -d' ' -f1 > "$WORKDIR/reviews/.plan-hash"
elif [ -f "$WORKDIR_STATE_DIR/settings/critic-gates.json" ]; then
  cat "$WORKDIR/plan.json" "$WORKDIR_STATE_DIR/settings/critic-gates.json" | shasum -a 256 | cut -d' ' -f1 > "$WORKDIR/reviews/.plan-hash"
else
  shasum -a 256 "$WORKDIR/plan.json" | cut -d' ' -f1 > "$WORKDIR/reviews/.plan-hash"
fi

echo "CRITIC_CACHE_STAMPED"
