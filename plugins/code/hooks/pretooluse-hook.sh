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

# ── Security blocklist ──────────────────────────────────────────────────────
# Deny credential theft patterns BEFORE any other processing (including workspace allow).
# Fires for ALL sessions (not just ClosedLoop-managed ones).
# Must run FIRST so that e.g. "cp ~/.ssh/id_rsa .closedloop-ai/loot" is denied
# rather than auto-allowed by the workspace rule below.
_SEC_DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: credential access denied by security policy"}}'

case "$TOOL_NAME" in
    Bash)
        _sec_cmd=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || echo "")
        case "$_sec_cmd" in
            # Broad process killing — globally denied.
            # pkill/killall match by name and kill processes outside the current context
            # (e.g. a running desktop-dev in the main tree killed by a worktree agent).
            # Claude should never need these; use process.kill(pid) for specific PIDs instead.
            *pkill*|*killall*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # macOS Keychain
            *security\ find-generic-password*|*security\ find-internet-password*|*security\ dump-keychain*|\
            *security\ delete-generic-password*|*security\ delete-internet-password*|\
            *find-generic-password*|*find-internet-password*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # Browser profile directories
            *"Library/Application Support/Google/Chrome"*|*"Library/Application Support/Chromium"*|\
            *"Library/Application Support/BraveSoftware"*|*"Library/Application Support/Microsoft Edge"*|\
            *"Library/Application Support/Firefox"*|*.mozilla/firefox*|*"Library/Safari/Cookies"*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # Browser DBs via sqlite3
            *sqlite3*Cookies*|*sqlite3*"Login Data"*|*sqlite3*"Web Data"*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # SSH private keys
            */.ssh/id_*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # Cloud credentials (commands and file paths)
            */.aws/credentials*|*"gcloud auth print-access-token"*|*"gcloud auth application-default"*|\
            */.config/gcloud/credentials.db*|*/.config/gcloud/application_default_credentials.json*|\
            */.config/gcloud/legacy_credentials/*)
                echo "$_SEC_DENY"
                exit 0
                ;;
        esac
        ;;
    Read|Write|Edit)
        _sec_file=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")
        case "$_sec_file" in
            # Browser cookie/credential databases
            */Google/Chrome/*/Cookies|*/Google/Chrome/*/Login\ Data|\
            */Chromium/*/Cookies|*/Firefox/Profiles/*/cookies.sqlite|\
            */Safari/Cookies/Cookies.binarycookies)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # SSH private keys
            */.ssh/id_*)
                echo "$_SEC_DENY"
                exit 0
                ;;
            # Cloud credentials
            */.aws/credentials|*/.config/gcloud/credentials.db|\
            */.config/gcloud/legacy_credentials/*|*/.config/gcloud/application_default_credentials.json)
                echo "$_SEC_DENY"
                exit 0
                ;;
        esac
        ;;
esac

# Auto-allow all tools targeting .closedloop-ai/ — the plugin's general-purpose workspace.
# Fixes background agent permission denials (they can't prompt for approval).
# hookEventName is REQUIRED for permissionDecision to take effect — see claude-code #13890.
# NOTE: This runs AFTER the security blocklist so credential theft via workspace paths is denied.
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
    WORKDIR_FILE="$CWD/.closedloop-ai/session-$SESSION_ID.workdir"
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

# Source closedloop config and skip learning injection if disabled
CLOSEDLOOP_CONFIG="$CLOSEDLOOP_WORKDIR/.closedloop/config.env"
if [[ -f "$CLOSEDLOOP_CONFIG" ]]; then
    source "$CLOSEDLOOP_CONFIG"
fi
if [[ "${CLOSEDLOOP_SELF_LEARNING:-false}" != "true" ]]; then
    exit 0
fi

# Path to org-patterns.toon
PATTERNS_FILE="$HOME/.closedloop-ai/learnings/org-patterns.toon"

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
# Prefer gawk when available, but keep the parser portable because these hooks
# run on a mix of developer and CI machines.
AWK_BIN=$(command -v gawk || command -v awk || true)
if [[ -z "$AWK_BIN" ]]; then
    echo "$(date): No awk interpreter available, skipping tool learnings" >> "$DEBUG_LOG"
    exit 0
fi
LEARNINGS=$("$AWK_BIN" -v filter_tags="$FILTER_TAGS" -v input_filter="$INPUT_FILTER" -v tool_name="$TOOL_NAME" '
function csv_split(line, fields,   i, ch, next_ch, in_quotes, field, count) {
    count = 1
    field = ""
    in_quotes = 0
    for (i = 1; i <= length(line); i++) {
        ch = substr(line, i, 1)
        if (ch == "\"") {
            next_ch = substr(line, i + 1, 1)
            if (in_quotes && next_ch == "\"") {
                field = field "\""
                i++
            } else {
                in_quotes = !in_quotes
            }
        } else if (ch == "," && !in_quotes) {
            fields[count++] = field
            field = ""
        } else {
            field = field ch
        }
    }
    fields[count] = field
    return count
}
BEGIN {
    n = 0
    num_tags = split(filter_tags, tag_arr, /\|/)
}
/^#/ { next }
/^[[:space:]]*$/ { next }
/^patterns\[/ { next }
{
    gsub(/^[[:space:]]+/, "")
    for (field_idx in fields) delete fields[field_idx]
    if (csv_split($0, fields) < 9) next

    summary = fields[3]
    confidence = fields[4]
    context = fields[9]

    gsub(/^"|"$/, "", summary)
    gsub(/^"|"$/, "", context)

    text_to_check = tolower(summary " " context)
    matched = 0

    for (i = 1; i <= num_tags; i++) {
        tag = tolower(tag_arr[i])
        if (tag != "" && index(text_to_check, tag) > 0) {
            matched = 1
            break
        }
    }

    if (!matched && input_filter != "") {
        input_lower = tolower(input_filter)
        word_count = split(tolower(summary), summ_words, /[^a-z0-9]+/)
        for (w = 1; w <= word_count; w++) {
            if (length(summ_words[w]) > 3 && index(input_lower, summ_words[w]) > 0) {
                matched = 1
                break
            }
        }
    }

    if (matched) {
        pattern_confidence[n] = confidence
        pattern_summary[n] = summary
        n++
    }
}
END {
    if (n == 0) exit

    printf "<tool-learnings tool=\"%s\">\n", tool_name
    for (i = 0; i < n && i < 10; i++) {
        printf "[%s] %s\n", pattern_confidence[i], pattern_summary[i]
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
