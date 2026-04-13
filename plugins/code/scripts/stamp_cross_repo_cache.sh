#!/usr/bin/env bash
# Stamp the cross-repo cache after coordinator completes.
# Usage: stamp_cross_repo_cache.sh <WORKDIR>
#
# Computes a hash of peer repo HEADs (from .workspace-repos.json) or
# falls back to hashing .cross-repo-needs.json. Writes to <WORKDIR>/.cross-repo-hash.

set -euo pipefail

WORKDIR="${1:?Usage: stamp_cross_repo_cache.sh <WORKDIR>}"

if [ -f ".workspace-repos.json" ]; then
  python3 -c "import json; [print(r['path']) for r in json.load(open('.workspace-repos.json')) if r.get('path')]" 2>/dev/null \
    | while IFS= read -r repo_path; do
        if [ -d "$repo_path/.git" ]; then
          printf '%s:%s\n' "$repo_path" "$(git -C "$repo_path" rev-parse HEAD 2>/dev/null || echo unknown)"
        fi
      done \
    | LC_ALL=C sort \
    | shasum -a 256 > "$WORKDIR/.cross-repo-hash"
else
  shasum -a 256 "$WORKDIR/.cross-repo-needs.json" > "$WORKDIR/.cross-repo-hash"
fi

echo "CROSS_REPO_CACHE_STAMPED"
