#!/usr/bin/env bash
# Creates a snapshot of judge agent definitions in the given directory.
# Usage: ensure_agents_snapshot.sh <snapshot-parent-dir>
#
# The snapshot is written to <snapshot-parent-dir>/agents-snapshot/.
# If manifest.json already exists there, the script exits immediately (idempotent).
# Agents are resolved relative to this script's location within the judges plugin.

set -euo pipefail

SNAPSHOT_PARENT="${1:?Usage: ensure_agents_snapshot.sh <snapshot-parent-dir>}"
SNAPSHOT_DIR="$SNAPSHOT_PARENT/agents-snapshot"
MANIFEST="$SNAPSHOT_DIR/manifest.json"

# Skip if snapshot already exists
if [[ -f "$MANIFEST" ]]; then
  echo "agents-snapshot: already exists, skipping"
  exit 0
fi

# Resolve agents dir relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENTS_SRC="$PLUGIN_DIR/agents"

if [[ ! -d "$AGENTS_SRC" ]]; then
  echo "WARNING: agents directory not found at $AGENTS_SRC, skipping snapshot"
  exit 0
fi

# Build sorted file list
file_list=$(find "$AGENTS_SRC" -type f -name "*.md" | LC_ALL=C sort -u)

if [[ -z "$file_list" ]]; then
  echo "WARNING: no .md files found in $AGENTS_SRC, skipping snapshot"
  exit 0
fi

mkdir -p "$SNAPSHOT_DIR"

# Copy all .md files preserving directory structure
while IFS= read -r src_file; do
  rel_path="${src_file#$AGENTS_SRC/}"
  dest_file="$SNAPSHOT_DIR/$rel_path"
  mkdir -p "$(dirname "$dest_file")"
  cp "$src_file" "$dest_file"
done <<< "$file_list"

# Read plugin version
PLUGIN_JSON="$PLUGIN_DIR/.claude-plugin/plugin.json"
PLUGIN_VERSION="unknown"
if [[ -f "$PLUGIN_JSON" ]]; then
  PLUGIN_VERSION=$(jq -r '.version // "unknown"' "$PLUGIN_JSON" 2>/dev/null || echo "unknown")
fi

# Build manifest.json
FILE_COUNT=$(echo "$file_list" | grep -c . || echo "0")
FILES_JSON=$(echo "$file_list" | sed "s|^$AGENTS_SRC/||" | jq -R . | jq -s .)
RUN_ID="${CLOSEDLOOP_RUN_ID:-$(basename "$SNAPSHOT_PARENT")}"
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg plugin "judges" \
  --arg plugin_version "$PLUGIN_VERSION" \
  --arg run_id "$RUN_ID" \
  --arg created_at "$CREATED_AT" \
  --arg source_dir "$AGENTS_SRC" \
  --argjson files "$FILES_JSON" \
  --argjson file_count "$FILE_COUNT" \
  '{plugin:$plugin,plugin_version:$plugin_version,run_id:$run_id,created_at:$created_at,source_dir:$source_dir,files:$files,file_count:$file_count}' \
  > "$MANIFEST"

# Validate manifest
if ! jq -e '(.file_count | type == "number") and (.file_count == (.files | length))' "$MANIFEST" > /dev/null 2>&1; then
  echo "WARNING: agents-snapshot manifest validation failed"
fi

echo "agents-snapshot: $FILE_COUNT agent files captured in $SNAPSHOT_DIR"
