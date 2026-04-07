#!/bin/bash
# Discovers peer repositories using env var or sibling scan
# Usage: discover-repos.sh [project_root]
# Output: JSON to stdout

set -e
PROJECT_ROOT="${1:-$PWD}"
PROJECT_ROOT=$(cd "$PROJECT_ROOT" && pwd)

# Read current repo's identity
CURRENT_IDENTITY="$PROJECT_ROOT/.closedloop-ai/.repo-identity.json"
if [[ -f "$CURRENT_IDENTITY" ]]; then
    CURRENT_NAME=$(jq -r '.name // "unknown"' "$CURRENT_IDENTITY")
    CURRENT_TYPE=$(jq -r '.type // "unknown"' "$CURRENT_IDENTITY")
else
    CURRENT_NAME=$(basename "$PROJECT_ROOT")
    CURRENT_TYPE="unknown"
fi

# Start JSON output
echo "{"
echo "  \"currentRepo\": {"
echo "    \"name\": \"$CURRENT_NAME\","
echo "    \"type\": \"$CURRENT_TYPE\","
echo "    \"path\": \"$PROJECT_ROOT\""
echo "  },"

# Tier 1: Environment variable
if [[ -n "$CLAUDE_WORKSPACE_REPOS" ]]; then
    echo "  \"discoveryMethod\": \"env_var\","
    echo "  \"peers\": ["

    first=true
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

        # Read identity if exists
        identity_file="$path/.closedloop-ai/.repo-identity.json"
        if [[ -f "$identity_file" ]]; then
            type=$(jq -r '.type // "unknown"' "$identity_file")
            repo_name=$(jq -r '.name // "'"$name"'"' "$identity_file")
        else
            type="unknown"
            repo_name="$name"
        fi

        $first || echo ","
        first=false
        echo "    {\"name\": \"$repo_name\", \"type\": \"$type\", \"path\": \"$path\"}"
    done

    echo "  ],"
    echo "  \"monorepo\": false"
    echo "}"
    exit 0
fi

# Tier 2: Sibling directory scan
echo "  \"discoveryMethod\": \"sibling_scan\","
echo "  \"peers\": ["

PARENT_DIR=$(dirname "$PROJECT_ROOT")
first=true

for sibling in "$PARENT_DIR"/*/; do
    sibling="${sibling%/}"
    [[ "$sibling" == "$PROJECT_ROOT" ]] && continue
    [[ ! -d "$sibling" ]] && continue

    identity_file="$sibling/.closedloop-ai/.repo-identity.json"
    if [[ -f "$identity_file" ]]; then
        name=$(jq -r '.name // "unknown"' "$identity_file")
        type=$(jq -r '.type // "unknown"' "$identity_file")
        discoverable=$(jq -r '.discoverable // true' "$identity_file")

        [[ "$discoverable" == "false" ]] && continue

        $first || echo ","
        first=false
        echo "    {\"name\": \"$name\", \"type\": \"$type\", \"path\": \"$sibling\"}"
    fi
done

echo "  ],"

# Check for monorepo
if [[ "$CURRENT_TYPE" == "monorepo" ]] || [[ -d "$PROJECT_ROOT/apps" ]] || [[ -d "$PROJECT_ROOT/packages" ]]; then
    echo "  \"monorepo\": true"
else
    echo "  \"monorepo\": false"
fi

echo "}"
