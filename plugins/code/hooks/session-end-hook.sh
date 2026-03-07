#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Session End Hook
# Cleans up session-level artifacts when Claude Code session ends

set -e

# Debug logging (redirected once CWD is known)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Parse hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // empty')

# Redirect debug logs into project dir (not shared /tmp)
if [[ -n "$CWD" ]]; then
    mkdir -p "$CWD/.closedloop-ai"
    DEBUG_LOG="$CWD/.closedloop-ai/session-end-hook-debug.log"
fi
echo "$(date): Session end hook started, session=$SESSION_ID, reason=$REASON" >> "$DEBUG_LOG"

# ============================================================================
# CLEANUP: Session Mappings
# Remove session-specific files from .closedloop-ai/
# ============================================================================

CLOSEDLOOP_DIR="$CWD/.closedloop-ai"
LEGACY_DIR="$CWD/.claude/.closedloop"

# Discover CLOSEDLOOP_WORKDIR before cleaning up mappings
CLOSEDLOOP_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
    if [[ -f "$CLOSEDLOOP_DIR/session-$SESSION_ID.workdir" ]]; then
        CLOSEDLOOP_WORKDIR=$(cat "$CLOSEDLOOP_DIR/session-$SESSION_ID.workdir")
    elif [[ -f "$LEGACY_DIR/session-$SESSION_ID.workdir" ]]; then
        CLOSEDLOOP_WORKDIR=$(cat "$LEGACY_DIR/session-$SESSION_ID.workdir")
    fi
fi

# Clean up legacy directory if it exists (only this session's files + stale PIDs)
if [[ -d "$LEGACY_DIR" ]]; then
    echo "$(date): Cleaning up legacy directory: $LEGACY_DIR" >> "$DEBUG_LOG"

    # Remove only this session's workdir mapping
    rm -f "$LEGACY_DIR/session-$SESSION_ID.workdir" 2>/dev/null || true

    # Remove stale PID mappings (processes that no longer exist)
    for pid_file in "$LEGACY_DIR"/pid-*.session; do
        if [[ -f "$pid_file" ]]; then
            PID=$(basename "$pid_file" | sed 's/pid-\(.*\)\.session/\1/')
            if ! ps -p "$PID" &>/dev/null; then
                rm -f "$pid_file"
            fi
        fi
    done

    # Remove stale session workdir mappings (older than 24 hours)
    find "$LEGACY_DIR" -name "session-*.workdir" -mmin +1440 -delete 2>/dev/null || true

    # Remove ephemeral files only if no active sessions remain
    if ! ls "$LEGACY_DIR"/pid-*.session &>/dev/null && ! ls "$LEGACY_DIR"/session-*.workdir &>/dev/null; then
        rm -f "$LEGACY_DIR"/learnings-* "$LEGACY_DIR"/env 2>/dev/null || true
    fi

    # Remove directory if empty
    rmdir "$LEGACY_DIR" 2>/dev/null || true
fi

if [[ -d "$CLOSEDLOOP_DIR" ]]; then
    # Clean up session workdir mapping
    SESSION_WORKDIR_FILE="$CLOSEDLOOP_DIR/session-$SESSION_ID.workdir"
    if [[ -f "$SESSION_WORKDIR_FILE" ]]; then
        echo "$(date): Removing session workdir mapping: $SESSION_WORKDIR_FILE" >> "$DEBUG_LOG"
        rm -f "$SESSION_WORKDIR_FILE"
    fi

    # Clean up stale PID->session mappings (processes that no longer exist)
    for pid_file in "$CLOSEDLOOP_DIR"/pid-*.session; do
        if [[ -f "$pid_file" ]]; then
            # Extract PID from filename
            PID=$(basename "$pid_file" | sed 's/pid-\(.*\)\.session/\1/')
            # Check if process still exists
            if ! ps -p "$PID" &>/dev/null; then
                echo "$(date): Removing stale PID mapping (PID $PID no longer exists): $pid_file" >> "$DEBUG_LOG"
                rm -f "$pid_file"
            fi
        fi
    done

    # Clean up stale session workdir mappings (older than 24 hours)
    find "$CLOSEDLOOP_DIR" -name "session-*.workdir" -mmin +1440 -delete 2>/dev/null || true

    # Remove directory if empty
    rmdir "$CLOSEDLOOP_DIR" 2>/dev/null || true
fi

# ============================================================================
# CLEANUP: Agent Type Tracking
# Remove any orphaned .agent-types files in CLOSEDLOOP_WORKDIR (if known)
# ============================================================================

# Fallback: Check CWD's config.env (CLOSEDLOOP_WORKDIR was discovered above before cleanup)
if [[ -z "$CLOSEDLOOP_WORKDIR" ]] && [[ -f "$CWD/.closedloop/config.env" ]]; then
    source "$CWD/.closedloop/config.env"
fi

if [[ -n "$CLOSEDLOOP_WORKDIR" ]] && [[ -d "$CLOSEDLOOP_WORKDIR/.agent-types" ]]; then
    echo "$(date): Cleaning up agent-types directory: $CLOSEDLOOP_WORKDIR/.agent-types" >> "$DEBUG_LOG"

    # Remove all agent type files and retry tracking files
    rm -f "$CLOSEDLOOP_WORKDIR/.agent-types"/* 2>/dev/null || true

    # Remove directory if empty
    rmdir "$CLOSEDLOOP_WORKDIR/.agent-types" 2>/dev/null || true
fi

# ============================================================================
# CLEANUP: Project Root Orphans
# Clean up any orphaned .agent-types in project root (from old code versions)
# ============================================================================

PROJECT_ROOT_AGENT_TYPES="$CWD/.agent-types"
if [[ -d "$PROJECT_ROOT_AGENT_TYPES" ]]; then
    echo "$(date): Cleaning up orphaned .agent-types in project root: $PROJECT_ROOT_AGENT_TYPES" >> "$DEBUG_LOG"

    # Remove all files in the directory
    rm -f "$PROJECT_ROOT_AGENT_TYPES"/* 2>/dev/null || true

    # Remove directory if empty
    rmdir "$PROJECT_ROOT_AGENT_TYPES" 2>/dev/null || true
fi

echo "$(date): Session cleanup complete" >> "$DEBUG_LOG"

# SessionEnd hooks cannot block, so just exit success
exit 0
