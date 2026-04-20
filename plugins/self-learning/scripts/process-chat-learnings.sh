#!/bin/bash

# Process Chat Learnings
# Lightweight script that processes pending learnings from a chat session.
# Extracted from run-loop.sh Step 7 for standalone use when the chat dialog closes.
#
# Usage: process-chat-learnings.sh <workdir>
#   workdir: The .closedloop-ai/work directory containing .learnings/pending/*.json

set -euo pipefail

# Claude binary path. When spawned by the closedloop-electron desktop app,
# CLAUDE_BIN is set to the absolute path that the desktop validated in its
# pre-flight check. Falls back to bare `claude` for manual runs.
CLAUDE="${CLAUDE_BIN:-claude}"

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
CLAUDE_OK=false
if "$CLAUDE" -p "Run /self-learning:process-learnings $WORKDIR" \
    --allowed-tools=Bash,Grep,Glob,Read,Write \
    --max-turns 100 2>/dev/null; then
  CLAUDE_OK=true
fi

# Write merge-result.json → org-patterns.toon (deterministic)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MERGE_SCRIPT="$SCRIPT_DIR/../tools/python/write_merged_patterns.py"
MERGE_RESULT="$WORKDIR/.learnings/merge-result.json"
TOON_OK=true
if [[ -f "$MERGE_RESULT" ]] && [[ -f "$MERGE_SCRIPT" ]]; then
  if python3 "$MERGE_SCRIPT" --merge-result "$MERGE_RESULT" 2>&1; then
    # Cleanup session files after successful write
    rm -rf "$WORKDIR/.learnings/sessions/run-"* 2>/dev/null || true
  else
    TOON_OK=false
  fi
fi

# Set status based on both steps
if $CLAUDE_OK && $TOON_OK; then
  write_status "completed" "Learnings processed successfully"
elif $CLAUDE_OK; then
  write_status "error" "Classification succeeded but TOON write failed"
else
  write_status "error" "Learning processing encountered errors"
fi
