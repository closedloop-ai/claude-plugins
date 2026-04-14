#!/usr/bin/env bash
# ClosedLoop Session Start Hook
# Creates PID -> session_id mapping so slash commands can discover their session
# Uses Claude Code's PID (our PPID) as the key, which will be an ancestor of any ! command

set -e

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

# Debug logging (redirected once CWD is known)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Extract session_id and cwd from input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [[ -z "$SESSION_ID" ]] || [[ -z "$CWD" ]]; then
    exit 0
fi

# Create state directory at project root
mkdir -p "$CWD/$CLOSEDLOOP_STATE_DIR"

# Redirect debug logs into project dir (not shared /tmp)
DEBUG_LOG="$CWD/$CLOSEDLOOP_STATE_DIR/session-start-hook-debug.log"
echo "$(date): SessionStart hook started, PPID=$PPID" >> "$DEBUG_LOG"

# Write PID -> session_id mapping using Claude Code's PID (our PPID)
# ! commands will walk up their process tree to find this
echo "$SESSION_ID" > "$CWD/$CLOSEDLOOP_STATE_DIR/pid-$PPID.session"
echo "$(date): Wrote session mapping: pid-$PPID.session -> $SESSION_ID" >> "$DEBUG_LOG"

exit 0
