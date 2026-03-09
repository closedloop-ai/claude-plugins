#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Subagent Stop Hook
# Verifies learning capture and acknowledgment
# Blocks agents that don't acknowledge learnings (if configured as learning_agent)

set -e

# Debug logging (redirected to WORKDIR once discovered)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Get config paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
LOOP_CONFIG="$PLUGIN_ROOT/scripts/loop-agents.json"

# Get agent info from hook input
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Discover WORKDIR via session_id mapping (created by setup-closedloop.sh)
CLOSEDLOOP_WORKDIR=""
if [[ -n "$SESSION_ID" ]]; then
    WORKDIR_FILE="$CWD/.closedloop-ai/session-$SESSION_ID.workdir"
    # Fallback: check legacy path for mid-upgrade sessions
    if [[ ! -f "$WORKDIR_FILE" ]] && [[ -f "$CWD/.claude/.closedloop/session-$SESSION_ID.workdir" ]]; then
        WORKDIR_FILE="$CWD/.claude/.closedloop/session-$SESSION_ID.workdir"
    fi
    if [[ -f "$WORKDIR_FILE" ]]; then
        CLOSEDLOOP_WORKDIR=$(cat "$WORKDIR_FILE")
        echo "$(date): Found WORKDIR=$CLOSEDLOOP_WORKDIR from session mapping" >> "$DEBUG_LOG"
    else
        echo "$(date): No workdir mapping found at $WORKDIR_FILE" >> "$DEBUG_LOG"
    fi
fi

# Source closedloop config from WORKDIR if found
if [[ -n "$CLOSEDLOOP_WORKDIR" ]]; then
    CLOSEDLOOP_CONFIG="$CLOSEDLOOP_WORKDIR/.closedloop/config.env"
    if [[ -f "$CLOSEDLOOP_CONFIG" ]]; then
        source "$CLOSEDLOOP_CONFIG"
    fi
    # Redirect debug logs into workdir (per-run, not shared /tmp)
    mkdir -p "$CLOSEDLOOP_WORKDIR/.learnings"
    DEBUG_LOG="$CLOSEDLOOP_WORKDIR/.learnings/subagent-stop-hook-debug.log"
    echo "$(date): Hook started (WORKDIR=$CLOSEDLOOP_WORKDIR)" >> "$DEBUG_LOG"
fi

# Get agent_type from file (written by subagent-start-hook)
# Only look in CLOSEDLOOP_WORKDIR - don't fall back to CWD
AGENT_TYPES_DIR=""
AGENT_TYPE=""
if [[ -n "$CLOSEDLOOP_WORKDIR" ]]; then
    AGENT_TYPES_DIR="$CLOSEDLOOP_WORKDIR/.agent-types"
    if [[ -n "$AGENT_ID" ]] && [[ -f "$AGENT_TYPES_DIR/$AGENT_ID" ]]; then
        AGENT_TYPE=$(cut -d'|' -f1 "$AGENT_TYPES_DIR/$AGENT_ID")
        echo "$(date): Agent type from file: $AGENT_TYPE" >> "$DEBUG_LOG"
    fi
fi

# Exit early if not in a closedloop run context
if [[ -z "$CLOSEDLOOP_WORKDIR" ]]; then
    echo "$(date): No CLOSEDLOOP_WORKDIR, exiting" >> "$DEBUG_LOG"
    exit 0
fi

# Derive agent name from AGENT_TYPE (read from .agent-types mapping above)
# SubagentStop input does not provide agentName or output fields.
AGENT_NAME="${AGENT_TYPE##*:}"

if [[ -z "$AGENT_NAME" ]]; then
    echo "$(date): No agent name derived, exiting" >> "$DEBUG_LOG"
    exit 0
fi

# Read agent output from transcript file (SubagentStop provides agent_transcript_path)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // empty')
AGENT_OUTPUT=""
if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
    # Extract text from the last assistant message in the transcript
    LAST_ASSISTANT=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1)
    if [[ -n "$LAST_ASSISTANT" ]]; then
        AGENT_OUTPUT=$(echo "$LAST_ASSISTANT" | jq -r '
            .message.content |
            map(select(.type == "text")) |
            map(.text) |
            join("\n")
        ' 2>/dev/null || echo "")
    fi
    echo "$(date): Read agent output from transcript (${#AGENT_OUTPUT} chars)" >> "$DEBUG_LOG"
else
    echo "$(date): No transcript found at: $TRANSCRIPT_PATH" >> "$DEBUG_LOG"
fi

PENDING_DIR="$CLOSEDLOOP_WORKDIR/.learnings/pending"
LOGS_DIR="$CLOSEDLOOP_WORKDIR/.learnings"
RUN_ID="${CLOSEDLOOP_RUN_ID:-unknown}"
ITERATION="${CLOSEDLOOP_ITERATION:-0}"

# Track build-validator results for implementation-subagent attribution
if [[ "$AGENT_NAME" == "build-validator" ]]; then
    BUILD_STATUS=""
    if echo "$AGENT_OUTPUT" | grep -q "VALIDATION_PASSED"; then
        BUILD_STATUS="passed"
    elif echo "$AGENT_OUTPUT" | grep -q "VALIDATION_FAILED"; then
        BUILD_STATUS="failed"
    fi
    if [[ -n "$BUILD_STATUS" ]]; then
        TIMESTAMP_BUILD=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        mkdir -p "$LOGS_DIR"
        cat > "$LOGS_DIR/build-result.json" <<BUILDEOF
{"status": "$BUILD_STATUS", "timestamp": "$TIMESTAMP_BUILD", "iteration": "$ITERATION", "run_id": "$RUN_ID"}
BUILDEOF
        echo "$(date): Wrote build-result.json: status=$BUILD_STATUS" >> "$DEBUG_LOG"
    fi
fi

# Check for pending learning file from this agent
PENDING_FILE=$(find "$PENDING_DIR" -maxdepth 1 -name "*-${AGENT_NAME}.json" -type f 2>/dev/null | head -1)

# Check for LEARNINGS_ACKNOWLEDGED in agent output
ACKNOWLEDGED=false
EVIDENCE=""

if echo "$AGENT_OUTPUT" | grep -q "LEARNINGS_ACKNOWLEDGED"; then
    ACKNOWLEDGED=true
    # Extract evidence (everything after LEARNINGS_ACKNOWLEDGED)
    EVIDENCE=$(echo "$AGENT_OUTPUT" | grep -A 20 "LEARNINGS_ACKNOWLEDGED" | head -20)
fi

# Log acknowledgment for audit trail
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
APPLIED_PATTERNS=""

if [[ "$ACKNOWLEDGED" == "true" ]]; then
    # Parse applied patterns from evidence
    while IFS= read -r line; do
        if echo "$line" | grep -q 'Applied:'; then
            # Extract pattern trigger from Applied: "pattern" -> [evidence]
            PATTERN=$(echo "$line" | sed -n 's/.*Applied: "\([^"]*\)".*/\1/p')
            if [[ -n "$PATTERN" ]]; then
                APPLIED_PATTERNS="${APPLIED_PATTERNS}${PATTERN},"
            fi
        fi
    done <<< "$EVIDENCE"

    # Remove trailing comma
    APPLIED_PATTERNS="${APPLIED_PATTERNS%,}"

    # Log to acknowledgments.log
    # Format: timestamp|run_id|iteration|agent|acknowledged|patterns_applied|evidence_summary
    EVIDENCE_SUMMARY=$(echo "$EVIDENCE" | tr '\n' ' ' | cut -c1-200)
    echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_NAME|true|$APPLIED_PATTERNS|$EVIDENCE_SUMMARY" >> "$LOGS_DIR/acknowledgments.log"

    # Log explicitly-applied patterns to outcomes.log
    # Format: timestamp|run_id|iteration|agent|pattern|status|file_citations
    if [[ -n "$APPLIED_PATTERNS" ]]; then
        IFS=',' read -ra PATTERNS <<< "$APPLIED_PATTERNS"
        for pattern in "${PATTERNS[@]}"; do
            # Extract file:line citations from evidence
            CITATIONS=$(echo "$EVIDENCE" | grep -oE '[a-zA-Z0-9_/.-]+:[0-9]+' | tr '\n' ',' | sed 's/,$//')
            # Sanitize pipe chars to prevent corrupting pipe-delimited outcomes.log
            SAFE_PATTERN=$(echo "$pattern" | tr '|' '/')
            echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_NAME|$SAFE_PATTERN|applied|$CITATIONS" >> "$LOGS_DIR/outcomes.log"
        done
    fi
else
    # Log missing acknowledgment
    echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_NAME|false||missing acknowledgment" >> "$LOGS_DIR/acknowledgments.log"
fi

# ============================================================================
# ALWAYS write injected patterns to outcomes.log (regardless of acknowledgment)
# The start hook writes injected learnings to .closedloop-ai/learnings-{agent}
# Read that file and log each injected pattern with its actual outcome status:
#   - "applied" if agent explicitly cited it (already written above)
#   - "injected" if patterns were sent but agent didn't cite them
# This ensures compute_success_rates.py always has data to work with.
# ============================================================================
AGENT_NAME_LOWER=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')
LEARNINGS_FILE="$CWD/.closedloop-ai/learnings-$AGENT_NAME_LOWER"
# Fallback: check legacy path for mid-upgrade sessions
if [[ ! -f "$LEARNINGS_FILE" ]] && [[ -f "$CWD/.claude/.closedloop/learnings-$AGENT_NAME_LOWER" ]]; then
    LEARNINGS_FILE="$CWD/.claude/.closedloop/learnings-$AGENT_NAME_LOWER"
fi

if [[ -f "$LEARNINGS_FILE" ]]; then
    echo "$(date): Reading injected patterns from $LEARNINGS_FILE" >> "$DEBUG_LOG"

    # Extract pattern summaries from the learnings file
    # Format: [confidence] summary text (optional flags)
    while IFS= read -r line; do
        # Match lines like: [high] Some pattern summary [UNTESTED]
        INJECTED_PATTERN=$(echo "$line" | sed -n 's/^\[.*\] \(.*\)$/\1/p' | sed 's/ \[UNTESTED\]$//; s/ \[REVIEW\]$//; s/ \[STALE\]$//; s/ \[PRUNE\]$//')
        if [[ -z "$INJECTED_PATTERN" ]]; then
            continue
        fi

        # Skip if this pattern was already written as "applied" above
        ALREADY_APPLIED=false
        if [[ -n "$APPLIED_PATTERNS" ]]; then
            IFS=',' read -ra APPLIED_LIST <<< "$APPLIED_PATTERNS"
            for applied in "${APPLIED_LIST[@]}"; do
                if [[ "$applied" == "$INJECTED_PATTERN" ]]; then
                    ALREADY_APPLIED=true
                    break
                fi
            done
        fi

        if [[ "$ALREADY_APPLIED" == "false" ]]; then
            # Sanitize pipe chars to prevent corrupting pipe-delimited outcomes.log
            SAFE_INJECTED=$(echo "$INJECTED_PATTERN" | tr '|' '/')
            echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_NAME|$SAFE_INJECTED|injected|" >> "$LOGS_DIR/outcomes.log"
        fi
    done < "$LEARNINGS_FILE"

    echo "$(date): Wrote injected pattern outcomes to outcomes.log" >> "$DEBUG_LOG"
fi

# Verify pending file exists (if agent should have captured learnings)
# This is informational - we don't block the agent
if [[ -z "$PENDING_FILE" ]]; then
    # Check if agent output indicates no learnings needed
    if echo "$AGENT_OUTPUT" | grep -q "no_learnings"; then
        # Valid case - agent explicitly stated no learnings
        :
    else
        # Log warning about missing pending file
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_NAME|warning|missing pending file" >> "$LOGS_DIR/failures.log" 2>/dev/null || true
    fi
fi

# ============================================================================
# LEARNING ACKNOWLEDGMENT ENFORCEMENT
# Block agents that don't acknowledge learnings (if configured as learning_agent)
# ============================================================================

# Check if this agent is a learning agent
IS_LEARNING_AGENT=false
MAX_LEARNING_RETRIES=2

if [[ -f "$LOOP_CONFIG" ]] && [[ -n "$AGENT_TYPE" ]]; then
    # Check if agent is in learning_agents list
    LEARNING_AGENTS=$(jq -r '.learning_agents.agents // [] | .[]' "$LOOP_CONFIG" 2>/dev/null)
    MAX_LEARNING_RETRIES=$(jq -r '.learning_agents.max_retries // 2' "$LOOP_CONFIG" 2>/dev/null)

    for agent in $LEARNING_AGENTS; do
        if [[ "$agent" == "$AGENT_TYPE" ]]; then
            IS_LEARNING_AGENT=true
            echo "$(date): Agent $AGENT_TYPE is a learning agent" >> "$DEBUG_LOG"
            break
        fi
    done
fi

# If this is a learning agent, check for acknowledgment
if [[ "$IS_LEARNING_AGENT" == "true" ]]; then
    # Check if learnings were actually injected (org-patterns.toon exists)
    PATTERNS_FILE="$CLOSEDLOOP_WORKDIR/.learnings/org-patterns.toon"

    if [[ -f "$PATTERNS_FILE" ]]; then
        echo "$(date): Learnings file exists, checking acknowledgment" >> "$DEBUG_LOG"

        # Track retry count in state file
        LEARNING_STATE_DIR="$CLOSEDLOOP_WORKDIR/.agent-types"
        RETRY_FILE="$LEARNING_STATE_DIR/${AGENT_ID}-learning-retries"
        mkdir -p "$LEARNING_STATE_DIR"

        CURRENT_RETRY=0
        if [[ -f "$RETRY_FILE" ]]; then
            CURRENT_RETRY=$(cat "$RETRY_FILE")
        fi

        if [[ "$ACKNOWLEDGED" != "true" ]] && [[ $CURRENT_RETRY -lt $MAX_LEARNING_RETRIES ]]; then
            # Increment retry count
            NEXT_RETRY=$((CURRENT_RETRY + 1))
            echo "$NEXT_RETRY" > "$RETRY_FILE"

            echo "$(date): Blocking agent - no acknowledgment (retry $NEXT_RETRY/$MAX_LEARNING_RETRIES)" >> "$DEBUG_LOG"
            echo "$(date): ACKNOWLEDGED=$ACKNOWLEDGED, PATTERNS_FILE=$PATTERNS_FILE" >> "$DEBUG_LOG"

            # Block the agent and request acknowledgment
            BLOCK_MSG="LEARNING ACKNOWLEDGMENT REQUIRED (attempt $NEXT_RETRY/$MAX_LEARNING_RETRIES)

Organization learnings were injected into your context. You MUST acknowledge them before stopping.

Output ONE of:
1. LEARNINGS_ACKNOWLEDGED with evidence:
   Applied: \"pattern trigger\" -> [evidence at file:line]
   Applied: \"other pattern\" -> [evidence at file:line]

2. LEARNINGS_ACKNOWLEDGED: no_learnings (reason why none applied)

Without this acknowledgment, we cannot track learning effectiveness."

            # Output block JSON
            ACK_BLOCK_JSON=$(jq -n \
                --arg reason "Please acknowledge the organization learnings that were provided to you." \
                --arg msg "$BLOCK_MSG" \
                '{
                    "decision": "block",
                    "reason": $reason,
                    "systemMessage": $msg
                }')
            echo "$(date): Outputting acknowledgment block JSON: $ACK_BLOCK_JSON" >> "$DEBUG_LOG"
            echo "$ACK_BLOCK_JSON"
            exit 0
        elif [[ "$ACKNOWLEDGED" == "true" ]]; then
            # Clean up retry file on success
            rm -f "$RETRY_FILE"
            echo "$(date): Learning acknowledged successfully" >> "$DEBUG_LOG"
        else
            # Max retries reached, allow exit but log warning
            rm -f "$RETRY_FILE"
            echo "$(date): Max retries reached, allowing exit without acknowledgment" >> "$DEBUG_LOG"
            TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_TYPE|warning|max_retries_exceeded|no_acknowledgment" >> "$LOGS_DIR/failures.log" 2>/dev/null || true
        fi
    else
        echo "$(date): No learnings file exists, skipping acknowledgment check" >> "$DEBUG_LOG"
    fi
fi

# ============================================================================
# NEW LEARNING CAPTURE ENFORCEMENT
# Block learning agents that don't produce new learnings or explicitly state no_learnings
# ============================================================================

if [[ "$IS_LEARNING_AGENT" == "true" ]] && [[ -n "$CLOSEDLOOP_WORKDIR" ]]; then
    echo "$(date): Checking for new learning capture" >> "$DEBUG_LOG"

    # Create learnings directory if needed
    LEARNINGS_PENDING_DIR="$CLOSEDLOOP_WORKDIR/.learnings/pending"
    mkdir -p "$LEARNINGS_PENDING_DIR"

    # Extract agent short name from agent type (e.g., "code:plan-writer" -> "plan-writer")
    AGENT_SHORT_NAME="${AGENT_TYPE##*:}"
    echo "$(date): Agent short name: $AGENT_SHORT_NAME, searching in: $LEARNINGS_PENDING_DIR" >> "$DEBUG_LOG"

    # Check if agent produced a learning file (exact match by agent_id, or pattern match)
    LEARNING_FILE=""
    if [[ -n "$AGENT_ID" ]] && [[ -f "$LEARNINGS_PENDING_DIR/${AGENT_SHORT_NAME}-${AGENT_ID}.json" ]]; then
        LEARNING_FILE="$LEARNINGS_PENDING_DIR/${AGENT_SHORT_NAME}-${AGENT_ID}.json"
    else
        # Fallback: search for any recent file from this agent type
        LEARNING_FILE=$(find "$LEARNINGS_PENDING_DIR" -maxdepth 1 -name "${AGENT_SHORT_NAME}-*.json" -type f -mmin -5 2>/dev/null | head -1)
    fi
    echo "$(date): Learning file search result: '${LEARNING_FILE:-none found}'" >> "$DEBUG_LOG"

    # Check if agent output contains no_learnings
    HAS_NO_LEARNINGS=false
    if echo "$AGENT_OUTPUT" | grep -q "no_learnings"; then
        HAS_NO_LEARNINGS=true
        echo "$(date): Agent explicitly stated no_learnings" >> "$DEBUG_LOG"
    fi

    if [[ -z "$LEARNING_FILE" ]] && [[ "$HAS_NO_LEARNINGS" != "true" ]]; then
        # Track retry count for learning capture
        LEARNING_CAPTURE_RETRY_FILE="$CLOSEDLOOP_WORKDIR/.agent-types/${AGENT_ID}-capture-retries"
        CAPTURE_RETRY=0
        if [[ -f "$LEARNING_CAPTURE_RETRY_FILE" ]]; then
            CAPTURE_RETRY=$(cat "$LEARNING_CAPTURE_RETRY_FILE")
        fi

        if [[ $CAPTURE_RETRY -lt $MAX_LEARNING_RETRIES ]]; then
            # Increment retry count
            NEXT_CAPTURE_RETRY=$((CAPTURE_RETRY + 1))
            echo "$NEXT_CAPTURE_RETRY" > "$LEARNING_CAPTURE_RETRY_FILE"

            echo "$(date): Blocking agent - no learning captured (retry $NEXT_CAPTURE_RETRY/$MAX_LEARNING_RETRIES)" >> "$DEBUG_LOG"
            echo "$(date): HAS_NO_LEARNINGS=$HAS_NO_LEARNINGS, LEARNING_FILE='$LEARNING_FILE'" >> "$DEBUG_LOG"

            CAPTURE_BLOCK_MSG="LEARNING CAPTURE REQUIRED (attempt $NEXT_CAPTURE_RETRY/$MAX_LEARNING_RETRIES)

You MUST capture learnings before stopping. Write to: $LEARNINGS_PENDING_DIR/${AGENT_SHORT_NAME}-${AGENT_ID}.json

Format:
{
  \"what_happened\": \"Brief description\",
  \"why\": \"Root cause or why this matters\",
  \"fix_applied\": \"What you did (if applicable)\",
  \"pattern_to_remember\": \"Actionable takeaway (20+ chars, specific not generic)\",
  \"applies_to\": [\"${AGENT_TYPE}\"],
  \"context\": { \"file\": \"path/to/file\", \"line\": 42 }
}

OR if no learnings, output: { \"no_learnings\": true, \"reason\": \"explanation\" }

Good patterns: \"Always check for None before accessing .items() on optional dicts\"
Bad patterns: \"Be careful with None\" (too vague)"

            BLOCK_JSON=$(jq -n \
                --arg reason "Please capture learnings from your work before stopping." \
                --arg msg "$CAPTURE_BLOCK_MSG" \
                '{
                    "decision": "block",
                    "reason": $reason,
                    "systemMessage": $msg
                }')
            echo "$(date): Outputting learning capture block JSON: $BLOCK_JSON" >> "$DEBUG_LOG"
            echo "$BLOCK_JSON"
            exit 0
        else
            # Max retries reached
            rm -f "$LEARNING_CAPTURE_RETRY_FILE"
            echo "$(date): Max capture retries reached, allowing exit" >> "$DEBUG_LOG"
            TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            echo "$TIMESTAMP|$RUN_ID|$ITERATION|$AGENT_TYPE|warning|max_retries_exceeded|no_learning_captured" >> "$LOGS_DIR/failures.log" 2>/dev/null || true
        fi
    else
        # Learning captured or no_learnings stated - clean up
        rm -f "$CLOSEDLOOP_WORKDIR/.agent-types/${AGENT_ID}-capture-retries"
        if [[ -n "$LEARNING_FILE" ]]; then
            echo "$(date): Learning file found: $LEARNING_FILE" >> "$DEBUG_LOG"
        fi
    fi
fi

# --- Performance instrumentation: emit agent timing event ---
if [[ -n "$AGENT_ID" ]] && [[ -n "$CLOSEDLOOP_WORKDIR" ]] && [[ -f "$AGENT_TYPES_DIR/$AGENT_ID" ]]; then
    AGENT_STARTED_AT=$(cut -d'|' -f3 "$AGENT_TYPES_DIR/$AGENT_ID")
    if [[ -n "$AGENT_STARTED_AT" ]]; then
        AGENT_ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        if [[ "$(uname)" == "Darwin" ]]; then
            AGENT_START_EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$AGENT_STARTED_AT" "+%s" 2>/dev/null || echo "")
        else
            AGENT_START_EPOCH=$(date -u -d "$AGENT_STARTED_AT" "+%s" 2>/dev/null || echo "")
        fi
        AGENT_END_EPOCH=$(date +%s)
        if [[ -n "$AGENT_START_EPOCH" ]]; then
            AGENT_DURATION=$((AGENT_END_EPOCH - AGENT_START_EPOCH))
        else
            AGENT_DURATION=0
        fi
        PERF_FILE="$CLOSEDLOOP_WORKDIR/perf.jsonl"
        jq -n -c \
            --arg event "agent" \
            --arg run_id "${CLOSEDLOOP_RUN_ID:-unknown}" \
            --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
            --arg agent_id "$AGENT_ID" \
            --arg agent_type "${AGENT_TYPE:-unknown}" \
            --arg agent_name "${AGENT_NAME:-unknown}" \
            --arg started_at "$AGENT_STARTED_AT" \
            --arg ended_at "$AGENT_ENDED_AT" \
            --argjson duration_s "$AGENT_DURATION" \
            '{event:$event,run_id:$run_id,iteration:$iteration,agent_id:$agent_id,agent_type:$agent_type,agent_name:$agent_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s}' \
            >> "$PERF_FILE"
        echo "$(date): Emitted agent perf event: agent=$AGENT_NAME duration=${AGENT_DURATION}s" >> "$DEBUG_LOG"
    fi
fi

# Clean up agent_type file
if [[ -n "$AGENT_ID" ]] && [[ -f "$AGENT_TYPES_DIR/$AGENT_ID" ]]; then
    rm -f "$AGENT_TYPES_DIR/$AGENT_ID"
fi

# Output empty JSON (no modifications to response)
echo "{}"
