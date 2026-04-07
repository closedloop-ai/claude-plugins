#!/bin/bash
# Setup ClosedLoop config for hooks to source
# Usage: setup-closedloop.sh [workdir] [--prd <file>] [--plan <file>] [--max-iterations <n>] [--prompt <name>]

set -e

DEBUG_LOG="/tmp/setup-closedloop-debug.log"
echo "$(date): Setup started, PID=$$, PPID=$PPID, args: $*" >> "$DEBUG_LOG"

# Compute PLUGIN_ROOT early (needed for prompt detection)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

# Parse arguments — collect positional args into an array for classification after parsing
PRD_FILE=""
PLAN_FILE=""
MAX_ITERATIONS=10
PROMPT_NAME=""
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --prd)
            PRD_FILE="$2"
            shift 2
            ;;
        --plan)
            PLAN_FILE="$2"
            shift 2
            ;;
        --max-iterations)
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        --prompt)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --prompt requires a prompt name" >&2
                exit 1
            fi
            PROMPT_NAME="$2"
            shift 2
            ;;
        -*)
            echo "Unknown option: $1" >&2
            shift
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# First positional arg is workdir
WORKDIR=""
if [[ ${#POSITIONAL_ARGS[@]} -gt 0 ]]; then
    WORKDIR="${POSITIONAL_ARGS[0]}"
fi

PROMPT_NAME="${PROMPT_NAME:-prompt}"
WORKDIR="${WORKDIR:-.}"
# Convert to absolute path for consistent hook injection
if [[ ! "$WORKDIR" = /* ]]; then
    WORKDIR="$PWD/$WORKDIR"
fi
if [[ -z "$PLAN_FILE" ]] && [[ -z "$PRD_FILE" ]]; then
    # Try common patterns in order of preference
    for pattern in "prd.md" "prd.pdf" "requirements.md" "requirements.txt" "ticket.md"; do
        if [[ -f "$WORKDIR/$pattern" ]]; then
            PRD_FILE="$WORKDIR/$pattern"
            echo "$(date): Discovered PRD file: $PRD_FILE" >> "$DEBUG_LOG"
            break
        fi
    done
    # Fallback: find the first non-directory file (excluding hidden files and attachments/)
    if [[ -z "$PRD_FILE" ]]; then
        PRD_FILE=$(find "$WORKDIR" -maxdepth 1 -type f ! -name ".*" 2>/dev/null | head -1)
        if [[ -n "$PRD_FILE" ]]; then
            echo "$(date): Discovered PRD file (fallback): $PRD_FILE" >> "$DEBUG_LOG"
        fi
    fi
fi

# Mutual exclusion: --plan and --prd cannot both be set
if [[ -n "$PLAN_FILE" ]] && [[ -n "$PRD_FILE" ]]; then
    echo "Error: --plan and --prd are mutually exclusive; specify only one" >&2
    exit 1
fi

# Resolve PLAN_FILE to absolute path and validate it exists
if [[ -n "$PLAN_FILE" ]]; then
    if [[ ! "$PLAN_FILE" = /* ]]; then
        PLAN_FILE="$PWD/$PLAN_FILE"
    fi
    if [[ ! -f "$PLAN_FILE" ]]; then
        echo "Error: plan file not found: $PLAN_FILE" >&2
        exit 1
    fi
fi

# Step 1: Find session_id by walking up process tree
# SessionStart hook wrote to .closedloop-ai/pid-<Claude Code PID>.session
# Claude Code's PID is an ancestor of this process
SESSION_ID=""
CURRENT_PID=$$
while [[ $CURRENT_PID -gt 1 ]]; do
    SESSION_FILE=".closedloop-ai/pid-$CURRENT_PID.session"
    echo "$(date): Checking $SESSION_FILE" >> "$DEBUG_LOG"
    if [[ -f "$SESSION_FILE" ]]; then
        SESSION_ID=$(cat "$SESSION_FILE")
        echo "$(date): Found session_id=$SESSION_ID from $SESSION_FILE (PID=$CURRENT_PID)" >> "$DEBUG_LOG"
        break
    fi
    # Get parent PID
    CURRENT_PID=$(ps -o ppid= -p $CURRENT_PID 2>/dev/null | tr -d ' ')
    if [[ -z "$CURRENT_PID" ]]; then
        break
    fi
done

if [[ -n "$SESSION_ID" ]]; then
    # Step 2: Write workdir mapping so hooks can find it via session_id
    echo "$WORKDIR" > ".closedloop-ai/session-$SESSION_ID.workdir"
    echo "$(date): Wrote workdir mapping: .closedloop-ai/session-$SESSION_ID.workdir -> $WORKDIR" >> "$DEBUG_LOG"
else
    echo "$(date): WARNING: Could not find session_id in process tree" >> "$DEBUG_LOG"
fi

# Step 3: Validate prompt before creating any directories
# Validate prompt name contains no path separators
if [[ "$PROMPT_NAME" == */* || "$PROMPT_NAME" == *..* || "$PROMPT_NAME" =~ [[:space:]] ]]; then
    echo "ERROR: prompt name must not contain path separators or spaces" >&2
    exit 1
fi

CLOSEDLOOP_PROMPT_FILE="$PLUGIN_ROOT/prompts/$PROMPT_NAME.md"

# Validate the prompt file exists
if [[ ! -f "$CLOSEDLOOP_PROMPT_FILE" ]]; then
    echo "ERROR: Prompt file not found: $CLOSEDLOOP_PROMPT_FILE" >&2
    echo "Available prompts:" >&2
    shopt -s nullglob
    for f in "$PLUGIN_ROOT/prompts/"*.md; do
        basename "$f" .md >&2
    done
    shopt -u nullglob
    exit 1
fi

# Write full config to WORKDIR
mkdir -p "$WORKDIR/.closedloop"

cat > "$WORKDIR/.closedloop/config.env" << EOF
CLOSEDLOOP_WORKDIR="$WORKDIR"
CLOSEDLOOP_PRD_FILE="$PRD_FILE"
CLOSEDLOOP_PLAN_FILE="$PLAN_FILE"
CLOSEDLOOP_MAX_ITERATIONS="$MAX_ITERATIONS"
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
CLOSEDLOOP_PROMPT_FILE="$CLOSEDLOOP_PROMPT_FILE"
EOF

echo "ClosedLoop config written to $WORKDIR/.closedloop/config.env"
cat "$WORKDIR/.closedloop/config.env"
