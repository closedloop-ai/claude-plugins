#!/usr/bin/env bash
# ClosedLoop Self-Learning System - PreToolUse Hook
# Injects tool-specific learnings before tool execution via additionalContext.
#
# Key difference from SubagentStart hook:
#   SubagentStart: General org patterns filtered by agent name (broad context)
#   PreToolUse: Narrow, tool-specific patterns filtered by tool type + input (just-in-time)

set -e

# Debug logging (redirected to WORKDIR once discovered)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Parse hook input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Auto-allow all tools targeting .closedloop-ai/ — the plugin's general-purpose workspace.
# Fixes background agent permission denials (they can't prompt for approval).
# hookEventName is REQUIRED for permissionDecision to take effect — see claude-code #13890.
_CLOSEDLOOP_ALLOW='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-allow access to .closedloop-ai/ plugin workspace"}}'
case "$TOOL_NAME" in
    Read|Write|Edit)
        _file=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")
        case "$_file" in *.closedloop-ai/*)
            echo "$_CLOSEDLOOP_ALLOW"
            exit 0
            ;; esac
        ;;
    Bash)
        _cmd=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || echo "")
        case "$_cmd" in *.closedloop-ai/*)
            echo "$_CLOSEDLOOP_ALLOW"
            exit 0
            ;; esac
        ;;
esac

# Discover WORKDIR via session_id mapping (same pattern as subagent-start-hook.sh)
CLOSEDLOOP_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
    WORKDIR_FILE="$CWD/.claude/.closedloop/session-$SESSION_ID.workdir"
    if [[ -f "$WORKDIR_FILE" ]]; then
        CLOSEDLOOP_WORKDIR=$(cat "$WORKDIR_FILE")
    fi
fi

# Exit early if not in a closedloop session
if [[ -z "$CLOSEDLOOP_WORKDIR" ]]; then
    exit 0
fi

# Redirect debug logs into workdir (per-run, not shared /tmp)
mkdir -p "$CLOSEDLOOP_WORKDIR/.learnings"
DEBUG_LOG="$CLOSEDLOOP_WORKDIR/.learnings/pretooluse-hook-debug.log"
echo "$(date): PreToolUse hook started, tool=$TOOL_NAME" >> "$DEBUG_LOG"

# Path to org-patterns.toon (fall back to legacy location during migration)
PATTERNS_FILE="$HOME/.closedloop-ai/learnings/org-patterns.toon"
if [[ ! -f "$PATTERNS_FILE" ]]; then
    PATTERNS_FILE="$HOME/.claude/.learnings/org-patterns.toon"
fi

if [[ ! -f "$PATTERNS_FILE" ]]; then
    echo "$(date): No patterns file found, exiting" >> "$DEBUG_LOG"
    exit 0
fi

# Build tool-specific context tags to filter by
FILTER_TAGS=""
INPUT_FILTER=""

case "$TOOL_NAME" in
    Bash)
        FILTER_TAGS="build|test|validation|python|cli|monorepo|turborepo|code"
        # Extract command text for keyword matching
        INPUT_FILTER=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || echo "")
        ;;
    Write|Edit)
        FILTER_TAGS="react|components|typescript|editing|design-system|hooks|styling|radix-ui|enums|useMemo|grouping|precision|line-numbers"
        # Extract file path for extension-based filtering
        local_file=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")
        case "$local_file" in
            *.tsx|*.jsx) FILTER_TAGS="$FILTER_TAGS|react|jsx" ;;
            *.ts|*.js)   FILTER_TAGS="$FILTER_TAGS|javascript|typescript" ;;
            *.py)        FILTER_TAGS="$FILTER_TAGS|python" ;;
            *.css|*.scss) FILTER_TAGS="$FILTER_TAGS|styling|css" ;;
            *.json)      FILTER_TAGS="$FILTER_TAGS|config|json" ;;
        esac
        ;;
    *)
        # Only fire for Bash|Write|Edit
        echo "$(date): Ignoring tool $TOOL_NAME" >> "$DEBUG_LOG"
        exit 0
        ;;
esac

echo "$(date): FILTER_TAGS=$FILTER_TAGS INPUT_FILTER=${INPUT_FILTER:0:80}" >> "$DEBUG_LOG"

# Parse org-patterns.toon and filter for tool relevance
# TOON format (comma-delimited, 9 fields):
# id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context
# Use gawk with FPAT to handle quoted fields; filter by context tags + input keywords
LEARNINGS=$(gawk -v filter_tags="$FILTER_TAGS" -v input_filter="$INPUT_FILTER" -v tool_name="$TOOL_NAME" '
BEGIN {
    FPAT = "([^,]*|\"[^\"]*\")"
    n = 0
    # Split filter tags into array
    split(filter_tags, tag_arr, "|")
}
/^#/ { next }
/^[[:space:]]*$/ { next }
/^patterns\[/ { next }
{
    # Strip leading whitespace (TOON rows are indented 2 spaces)
    gsub(/^[[:space:]]+/, "")

    id = $1
    category = $2
    summary = $3
    confidence = $4
    seen_count = $5
    success_rate = $6
    flags = $7
    applies_to = $8
    context = $9

    gsub(/^"|"$/, "", summary)
    gsub(/^"|"$/, "", context)

    # Check context tags and summary for filter tag matches
    text_to_check = tolower(summary " " context)

    matched = 0

    # Check if any filter tag appears in the pattern text
    for (i in tag_arr) {
        tag = tolower(tag_arr[i])
        if (tag != "" && index(text_to_check, tag) > 0) {
            matched = 1
            break
        }
    }

    # Additional: if we have input text, check for keyword overlap with summary
    if (!matched && input_filter != "") {
        input_lower = tolower(input_filter)
        # Extract words from summary
        split(tolower(summary), summ_words, /[^a-z0-9]+/)
        for (w in summ_words) {
            if (length(summ_words[w]) > 3 && index(input_lower, summ_words[w]) > 0) {
                matched = 1
                break
            }
        }
    }

    if (matched) {
        patterns[n]["confidence"] = confidence
        patterns[n]["summary"] = summary
        n++
    }
}
END {
    if (n == 0) exit

    printf "<tool-learnings tool=\"%s\">\n", tool_name
    for (i = 0; i < n && i < 10; i++) {
        printf "[%s] %s\n", patterns[i]["confidence"], patterns[i]["summary"]
    }
    printf "</tool-learnings>\n"
}
' "$PATTERNS_FILE" 2>/dev/null)

echo "$(date): Found learnings: $(echo "$LEARNINGS" | wc -l) lines" >> "$DEBUG_LOG"

# Output additionalContext if we found relevant patterns
if [[ -n "$LEARNINGS" ]]; then
    ESCAPED=$(echo "$LEARNINGS" | jq -Rs '.')
    echo "$(date): Injecting tool-specific learnings for $TOOL_NAME" >> "$DEBUG_LOG"
    echo "{\"hookSpecificOutput\": {\"additionalContext\": $ESCAPED}}"
fi
