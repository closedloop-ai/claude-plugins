#!/usr/bin/env bash
# Stamp the cross-repo cache after coordinator completes.
# Usage: stamp_cross_repo_cache.sh <WORKDIR>
#
# Computes a hash of peer repo HEADs (from .workspace-repos.json) or
# falls back to hashing .cross-repo-needs.json. Writes to <WORKDIR>/.cross-repo-hash.
#
# Hash format matches check_cross_repo_cache.sh: space-separated "path:hash " entries
# hashed via echo | shasum, stored as hash-only (cut -d' ' -f1).

set -euo pipefail

WORKDIR="${1:?Usage: stamp_cross_repo_cache.sh <WORKDIR>}"

if [ -f ".workspace-repos.json" ]; then
  repo_paths=$(python3 -c "import json; [print(r['path']) for r in json.load(open('.workspace-repos.json')) if r.get('path')]" 2>/dev/null) || {
    echo "CROSS_REPO_CACHE_STAMP_FAILED"
    echo "reason: failed to parse .workspace-repos.json"
    exit 1
  }

  repo_hashes=""
  while IFS= read -r repo_path; do
    [ -z "$repo_path" ] && continue
    if [ -d "$repo_path/.git" ]; then
      h=$(git -C "$repo_path" rev-parse HEAD 2>/dev/null || echo unknown)
      repo_hashes="$repo_hashes$repo_path:$h "
    fi
  done <<< "$repo_paths"
  # Sort for deterministic ordering regardless of JSON array order
  echo "$repo_hashes" | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ' | shasum -a 256 | cut -d' ' -f1 > "$WORKDIR/.cross-repo-hash"
else
  shasum -a 256 "$WORKDIR/.cross-repo-needs.json" | cut -d' ' -f1 > "$WORKDIR/.cross-repo-hash"
fi

echo "CROSS_REPO_CACHE_STAMPED"
