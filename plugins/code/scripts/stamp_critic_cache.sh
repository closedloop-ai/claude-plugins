#!/usr/bin/env bash
# Stamp the critic cache after reviews complete.
# Usage: stamp_critic_cache.sh <WORKDIR>
#
# Hashes plan.json (+ critic-gates.json if present) and writes to
# <WORKDIR>/reviews/.plan-hash so subsequent runs can skip critics.

set -euo pipefail

WORKDIR="${1:?Usage: stamp_critic_cache.sh <WORKDIR>}"

if [ -f ".closedloop-ai/settings/critic-gates.json" ]; then
  cat "$WORKDIR/plan.json" .closedloop-ai/settings/critic-gates.json | shasum -a 256 > "$WORKDIR/reviews/.plan-hash"
else
  shasum -a 256 "$WORKDIR/plan.json" > "$WORKDIR/reviews/.plan-hash"
fi

echo "CRITIC_CACHE_STAMPED"
