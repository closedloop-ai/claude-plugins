#!/bin/bash
# Discovers peer repositories using env var or sibling scan
# Usage: discover-repos.sh [project_root]
# Output: JSON to stdout

set -e

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

PROJECT_ROOT="${1:-$PWD}"
PROJECT_ROOT=$(cd "$PROJECT_ROOT" && pwd)

# Read current repo's identity
CURRENT_IDENTITY="$PROJECT_ROOT/$CLOSEDLOOP_STATE_DIR/.repo-identity.json"
if [[ -f "$CURRENT_IDENTITY" ]]; then
    CURRENT_NAME=$(jq -r '.name // "unknown"' "$CURRENT_IDENTITY")
    CURRENT_TYPE=$(jq -r '.type // "unknown"' "$CURRENT_IDENTITY")
else
    CURRENT_NAME=$(basename "$PROJECT_ROOT")
    CURRENT_TYPE="unknown"
fi

# Accumulator for all peer JSON objects (dedup by path)
# SEEN_PATHS is a newline-delimited list of resolved paths already added
SEEN_PATHS=""
PEER_JSONS=()

# Helper: check if a path is already seen
_path_seen() {
    local p="$1"
    echo "$SEEN_PATHS" | grep -qxF "$p"
}

# Helper: mark a path as seen
_mark_seen() {
    SEEN_PATHS="${SEEN_PATHS}
$1"
}

# Tier 0: Explicitly added directories via CLOSEDLOOP_ADD_DIRS (pipe-separated)
if [[ -n "${CLOSEDLOOP_ADD_DIRS:-}" ]]; then
    IFS='|' read -ra ADD_PATHS <<< "$CLOSEDLOOP_ADD_DIRS"
    for path in "${ADD_PATHS[@]}"; do
        # Expand ~ and resolve path
        path="${path/#\~/$HOME}"
        [[ "$path" != /* ]] && path="$PROJECT_ROOT/$path"
        path=$(cd "$path" 2>/dev/null && pwd) || continue

        # Skip current repo
        [[ "$path" == "$PROJECT_ROOT" ]] && continue

        # Skip already seen paths
        _path_seen "$path" && continue
        _mark_seen "$path"

        # Read identity if exists, fall back to basename
        identity_file="$path/$CLOSEDLOOP_STATE_DIR/.repo-identity.json"
        repo_name=""
        repo_type="unknown"
        if [[ -f "$identity_file" ]]; then
            repo_name=$(jq -r '.name // empty' "$identity_file")
            repo_type=$(jq -r '.type // "unknown"' "$identity_file")
        fi
        repo_name="${repo_name:-$(basename "$path")}"

        PEER_JSONS+=("{\"name\": \"$repo_name\", \"type\": \"$repo_type\", \"path\": \"$path\", \"local\": true}")
    done
fi

# Determine root-level discovery method. Tier 1 (env_var) wins if present;
# otherwise Tier 0 (add_dir) wins if it contributed peers; sibling_scan is
# the default fallback when nothing else produced results.
DISCOVERY_METHOD="sibling_scan"
if [[ ${#PEER_JSONS[@]} -gt 0 ]]; then
    DISCOVERY_METHOD="add_dir"
fi
if [[ -n "$CLAUDE_WORKSPACE_REPOS" ]]; then
    DISCOVERY_METHOD="env_var"
    IFS=',' read -ra REPOS <<< "$CLAUDE_WORKSPACE_REPOS"
    for repo in "${REPOS[@]}"; do
        name="${repo%%:*}"
        path="${repo#*:}"

        # Expand ~ and resolve path
        path="${path/#\~/$HOME}"
        [[ "$path" != /* ]] && path="$PROJECT_ROOT/$path"
        path=$(cd "$path" 2>/dev/null && pwd) || continue

        # Skip current repo
        [[ "$path" == "$PROJECT_ROOT" ]] && continue

        # Skip already seen paths (dedup with Tier 0)
        _path_seen "$path" && continue
        _mark_seen "$path"

        # Read identity if exists
        identity_file="$path/$CLOSEDLOOP_STATE_DIR/.repo-identity.json"
        type="unknown"
        repo_name=""
        if [[ -f "$identity_file" ]]; then
            type=$(jq -r '.type // "unknown"' "$identity_file")
            repo_name=$(jq -r '.name // empty' "$identity_file")
        fi
        repo_name="${repo_name:-$name}"

        PEER_JSONS+=("{\"name\": \"$repo_name\", \"type\": \"$type\", \"path\": \"$path\"}")
    done
fi

# Tier 2: Sibling directory scan (only if no Tier 1 env var)
if [[ -z "$CLAUDE_WORKSPACE_REPOS" ]]; then
    PARENT_DIR=$(dirname "$PROJECT_ROOT")

    for sibling in "$PARENT_DIR"/*/; do
        sibling="${sibling%/}"
        [[ "$sibling" == "$PROJECT_ROOT" ]] && continue
        [[ ! -d "$sibling" ]] && continue

        identity_file="$sibling/$CLOSEDLOOP_STATE_DIR/.repo-identity.json"
        if [[ -f "$identity_file" ]]; then
            name=$(jq -r '.name // "unknown"' "$identity_file")
            type=$(jq -r '.type // "unknown"' "$identity_file")
            discoverable=$(jq -r '.discoverable // true' "$identity_file")

            [[ "$discoverable" == "false" ]] && continue

            # Skip already seen paths (dedup with Tier 0)
            _path_seen "$sibling" && continue
            _mark_seen "$sibling"

            PEER_JSONS+=("{\"name\": \"$name\", \"type\": \"$type\", \"path\": \"$sibling\"}")
        fi
    done
fi

# Emit merged JSON output
echo "{"
echo "  \"currentRepo\": {"
echo "    \"name\": \"$CURRENT_NAME\","
echo "    \"type\": \"$CURRENT_TYPE\","
echo "    \"path\": \"$PROJECT_ROOT\""
echo "  },"
echo "  \"discoveryMethod\": \"$DISCOVERY_METHOD\","
echo "  \"peers\": ["

first=true
for peer in "${PEER_JSONS[@]}"; do
    $first || echo ","
    first=false
    echo "    $peer"
done

echo "  ],"

# Check for monorepo
if [[ "$CURRENT_TYPE" == "monorepo" ]] || [[ -d "$PROJECT_ROOT/apps" ]] || [[ -d "$PROJECT_ROOT/packages" ]]; then
    echo "  \"monorepo\": true"
else
    echo "  \"monorepo\": false"
fi

echo "}"
