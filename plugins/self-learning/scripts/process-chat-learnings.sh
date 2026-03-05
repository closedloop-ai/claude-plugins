#!/bin/bash

# Process Chat Learnings
# Lightweight script that processes pending learnings from a chat session.
# Extracted from run-loop.sh Step 7 for standalone use when the chat dialog closes.
#
# Usage: process-chat-learnings.sh <workdir>
#   workdir: The .claude/work directory containing .learnings/pending/*.json

set -euo pipefail

WORKDIR="${1:?Usage: process-chat-learnings.sh <workdir>}"

PENDING_DIR="$WORKDIR/.learnings/pending"
STATUS_FILE="$WORKDIR/.learnings/processing-status.json"

# Ensure status directory exists
mkdir -p "$(dirname "$STATUS_FILE")"

# Write status helper
write_status() {
  local status="$1"
  local message="${2:-}"
  cat > "$STATUS_FILE" <<EOF
{
  "status": "$status",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "message": "$message"
}
EOF
}

# Check if pending learnings exist
if [[ ! -d "$PENDING_DIR" ]] || [[ -z "$(ls -A "$PENDING_DIR"/*.json 2>/dev/null)" ]]; then
  write_status "completed" "No pending learnings found"
  exit 0
fi

# Mark as processing
write_status "processing" "Running process-learnings"

# Run the process-learnings command via Claude
if claude -p "Run /self-learning:process-learnings $WORKDIR" \
    --allowed-tools=Bash,Grep,Glob,Read,Write \
    --max-turns 100 2>/dev/null; then
  write_status "completed" "Learnings processed successfully"
else
  write_status "error" "Learning processing encountered errors"
fi
