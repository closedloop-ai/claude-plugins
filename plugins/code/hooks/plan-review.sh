#!/bin/bash
# Codex Plan Review Hook
# Triggers when Claude exits plan mode to get a second opinion on the plan
# The plan content is available directly from tool_response.plan

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

# Read hook input from stdin (must happen before CWD extraction)
INPUT=$(cat)

# Debug logging — keeps at most 15 log files in $CLOSEDLOOP_STATE_DIR/plan-review-logs/
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
CWD="${CWD:-$PWD}"
LOG_DIR="$CWD/$CLOSEDLOOP_STATE_DIR/plan-review-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"

log() { echo "$(date): $*" >> "$LOG_FILE"; }

# Prune old logs — keep only the 14 most recent (this run makes 15)
ls -1t "$LOG_DIR"/*.log 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null

log "Plan review hook started"

# Extract the plan content directly from the tool response
PLAN_CONTENT=$(echo "$INPUT" | jq -r '.tool_response.plan // empty')

# Exit silently if no plan content
if [ -z "$PLAN_CONTENT" ]; then
    log "No plan content found in tool_response, exiting"
    exit 0
fi

log "Plan content received (${#PLAN_CONTENT} chars)"

# Write prompt to a temp file to avoid shell injection
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
cat > "$TMPFILE" <<EOF
You are reviewing a plan that Claude Code created. Analyze it for:

1. Potential issues or risks
2. Missing steps or considerations
3. Better alternatives (if any)
4. Edge cases not addressed

Be concise. Only flag significant concerns.

PLAN:
$PLAN_CONTENT

Respond with:
- LGTM (if plan is solid)
- OR specific concerns (bullet points, max 5)
EOF

# Get Codex's review using stdin to avoid shell escaping issues
log "Calling codex exec..."
REVIEW=$(codex exec --full-auto -m "gpt-5.3-codex-spark" < "$TMPFILE" 2>/dev/null)

# If codex failed, exit silently
if [ -z "$REVIEW" ]; then
    log "Codex returned empty response, exiting"
    exit 0
fi

log "Codex review received (${#REVIEW} chars)"
log "Review content: $REVIEW"

# Output as JSON so Claude Code injects it as context
REVIEW_JSON=$(jq -Rs . <<< "$REVIEW")
OUTPUT=$(jq -n --argjson review "$REVIEW_JSON" \
  '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $review}}')

log "Output JSON: $OUTPUT"
echo "$OUTPUT"

exit 0
