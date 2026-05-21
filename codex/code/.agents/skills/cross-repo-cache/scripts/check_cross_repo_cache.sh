#!/usr/bin/env bash
# Check if cross-repo coordinator results can be reused.
# Usage: check_cross_repo_cache.sh <WORKDIR>
#
# Output (stdout, machine-parseable):
#   CROSS_REPO_CACHE_HIT
#   status: NO_CROSS_REPO_NEEDED | CAPABILITIES_IDENTIFIED
#   capabilities: [list if applicable]
#
#   — or —
#
#   CROSS_REPO_CACHE_MISS
#   reason: <why the cache is stale or missing>

set -euo pipefail

WORKDIR="${1:?Usage: check_cross_repo_cache.sh <WORKDIR>}"

NEEDS_FILE="$WORKDIR/.cross-repo-needs.json"
REPOS_FILE=".workspace-repos.json"
HASH_FILE="$WORKDIR/.cross-repo-hash"

# --- existence checks ---
if [ ! -f "$NEEDS_FILE" ]; then
  echo "CROSS_REPO_CACHE_MISS"
  echo "reason: .cross-repo-needs.json does not exist"
  exit 0
fi

# --- compute current hash of peer repos ---
current_hash=""
if [ -f "$REPOS_FILE" ]; then
  # Extract repo paths from workspace-repos.json
  repo_paths=$(python3 -c "
import json, sys
try:
    with open('$REPOS_FILE') as f:
        repos = json.load(f)
    for r in repos:
        p = r.get('path', '')
        if p:
            print(p)
except Exception as e:
    print('ERROR:' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>/dev/null) || {
    echo "CROSS_REPO_CACHE_MISS"
    echo "reason: failed to parse .workspace-repos.json"
    exit 0
  }

  repo_hashes=""
  while IFS= read -r repo_path; do
    [ -z "$repo_path" ] && continue
    if [ -d "$repo_path/.git" ]; then
      h=$(git -C "$repo_path" rev-parse HEAD 2>/dev/null) || {
        echo "CROSS_REPO_CACHE_MISS"
        echo "reason: failed to read git hash for $repo_path"
        exit 0
      }
      repo_hashes="$repo_hashes$repo_path:$h "
    fi
  done <<< "$repo_paths"
  # Sort for deterministic ordering regardless of JSON array order
  current_hash=$(echo "$repo_hashes" | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ' | shasum -a 256 | cut -d' ' -f1)
else
  # No workspace repos file - hash the needs file alone
  current_hash=$(shasum -a 256 "$NEEDS_FILE" | cut -d' ' -f1)
fi

if [ ! -f "$HASH_FILE" ]; then
  echo "CROSS_REPO_CACHE_MISS"
  echo "reason: no cached cross-repo hash found"
  exit 0
fi

stored_hash=$(head -1 "$HASH_FILE" 2>/dev/null | cut -d' ' -f1)

if [ "$current_hash" != "$stored_hash" ]; then
  echo "CROSS_REPO_CACHE_MISS"
  echo "reason: peer repo git hashes changed since last coordinator run"
  exit 0
fi

# --- cache hit: extract status and capabilities in one pass ---
parsed=$(python3 -c "
import json, sys
try:
    with open('$NEEDS_FILE') as f:
        d = json.load(f)
    needs = d.get('needs', [])
    if not needs or d.get('status') == 'NO_CROSS_REPO_NEEDED':
        print('NO_CROSS_REPO_NEEDED')
    else:
        print('CAPABILITIES_IDENTIFIED')
        for n in needs:
            cap = n.get('capability', '')
            peer = n.get('peer_name', '')
            if cap and peer:
                print(f'  - {peer}: {cap}')
except Exception as e:
    print('ERROR:' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>/dev/null) || {
  echo "CROSS_REPO_CACHE_MISS"
  echo "reason: .cross-repo-needs.json is malformed"
  exit 0
}

# First line is status, remaining lines are capabilities
status=$(echo "$parsed" | head -1)

echo "CROSS_REPO_CACHE_HIT"
echo "status: $status"

if [ "$status" = "CAPABILITIES_IDENTIFIED" ]; then
  capabilities=$(echo "$parsed" | tail -n +2)
  if [ -n "$capabilities" ]; then
    echo "capabilities:"
    echo "$capabilities"
  fi
fi
