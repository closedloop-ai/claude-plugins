#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Subagent Start Hook
# Injects learnings into agents via systemPromptSuffix

set -e

# Debug logging (redirected to WORKDIR once discovered)
DEBUG_LOG="/dev/null"

# Read hook input from stdin (JSON)
INPUT=$(cat)

# Parse hook input
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Early debug log (before WORKDIR discovery) to catch all SubagentStart events
EARLY_DEBUG_LOG="${CWD:-.}/.closedloop-ai/subagent-start-hook-debug.log"
mkdir -p "$(dirname "$EARLY_DEBUG_LOG")" 2>/dev/null
echo "$(date): SubagentStart hook fired — agent_type=$AGENT_TYPE agent_id=$AGENT_ID session_id=$SESSION_ID" >> "$EARLY_DEBUG_LOG"

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
    DEBUG_LOG="$CLOSEDLOOP_WORKDIR/.learnings/subagent-start-hook-debug.log"
    echo "$(date): Hook started (WORKDIR=$CLOSEDLOOP_WORKDIR)" >> "$DEBUG_LOG"
fi

# Save agent_type for SubagentStop to read (workaround for missing agent_type in stop hook)
# Only write if CLOSEDLOOP_WORKDIR is set to avoid polluting project root
if [[ -n "$CLOSEDLOOP_WORKDIR" ]] && [[ -n "$AGENT_ID" ]] && [[ -n "$AGENT_TYPE" ]]; then
    AGENT_TYPES_DIR="$CLOSEDLOOP_WORKDIR/.agent-types"
    mkdir -p "$AGENT_TYPES_DIR"
    AGENT_SHORT_NAME="${AGENT_TYPE##*:}"
    STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "$AGENT_TYPE|$AGENT_SHORT_NAME|$STARTED_AT" > "$AGENT_TYPES_DIR/$AGENT_ID"
    echo "$(date): Saved agent_type=$AGENT_TYPE for agent_id=$AGENT_ID to $AGENT_TYPES_DIR" >> "$DEBUG_LOG"
fi

# Check if this is a loop agent and create state file if needed
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
LOOP_CONFIG="$PLUGIN_ROOT/scripts/loop-agents.json"

if [[ -f "$LOOP_CONFIG" ]] && [[ -n "$AGENT_TYPE" ]]; then
    AGENT_CONFIG=$(jq -r --arg type "$AGENT_TYPE" '.loop_agents[$type] // empty' "$LOOP_CONFIG" 2>/dev/null)
    if [[ -n "$AGENT_CONFIG" ]] && [[ "$AGENT_CONFIG" != "null" ]]; then
        # This is a loop agent - create state file if not exists
        STATE_FILE_SUFFIX=$(echo "$AGENT_CONFIG" | jq -r '.state_file_suffix // "loop.local.md"')
        PROMISE=$(echo "$AGENT_CONFIG" | jq -r '.promise // "COMPLETE"')
        CONFIG_MAX_ITERATIONS=$(echo "$AGENT_CONFIG" | jq -r '.max_iterations // 10')

        MAX_ITERATIONS="${CLOSEDLOOP_MAX_ITERATIONS:-$CONFIG_MAX_ITERATIONS}"
        PRD_FILE="${CLOSEDLOOP_PRD_FILE:-}"
        WORKDIR="${CLOSEDLOOP_WORKDIR:-$CWD}"
        STATE_FILE="$WORKDIR/.closedloop/$STATE_FILE_SUFFIX"

        echo "$(date): Loop agent detected: $AGENT_TYPE, state_file=$STATE_FILE" >> "$DEBUG_LOG"

        # Only create if state file doesn't exist (idempotent)
        if [[ ! -f "$STATE_FILE" ]] && [[ -n "$WORKDIR" ]]; then
            mkdir -p "$WORKDIR/.closedloop"

            PROMPT="Create a comprehensive implementation plan for the requirements in @${PRD_FILE}.

Follow these steps:
1. Read the PRD thoroughly to understand ALL requirements
2. Explore the codebase to understand existing patterns and architecture
3. Write the plan to $WORKDIR/plan.json following the quality criteria
4. After validation feedback, address ALL issues and update $WORKDIR/plan.json

Quality criteria your plan must meet:
- Every PRD requirement has a corresponding task
- Tasks use checkbox format (- [ ] or - [x])
- ## Open Questions section exists (with checkbox format)
- No TODO/TBD placeholders
- Justify any new file creation (prefer extending existing files)
- Avoid code duplication patterns

Output <promise>$PROMISE</promise> ONLY when validation passes."

            cat > "$STATE_FILE" <<STATEEOF
---
active: true
iteration: 1
max_iterations: $MAX_ITERATIONS
prd_file: "$PRD_FILE"
workdir: "$WORKDIR"
agent_type: "$AGENT_TYPE"
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---

$PROMPT
STATEEOF
            echo "$(date): Created state file: $STATE_FILE" >> "$DEBUG_LOG"
        else
            echo "$(date): State file already exists or WORKDIR not set, skipping creation" >> "$DEBUG_LOG"
        fi
    fi
fi

# Exit early if not in a closedloop run context
if [[ -z "$CLOSEDLOOP_WORKDIR" ]]; then
    exit 0
fi

# Write base environment (same for all agents, only write once)
mkdir -p "$CWD/.closedloop-ai"
BASE_ENV_FILE="$CWD/.closedloop-ai/env"
# If legacy env exists but new one doesn't, copy it forward
LEGACY_ENV_FILE="$CWD/.claude/.closedloop/env"
if [[ ! -f "$BASE_ENV_FILE" ]] && [[ -f "$LEGACY_ENV_FILE" ]]; then
    cp "$LEGACY_ENV_FILE" "$BASE_ENV_FILE"
    echo "$(date): Copied legacy env to $BASE_ENV_FILE" >> "$DEBUG_LOG"
fi
if [[ ! -f "$BASE_ENV_FILE" ]]; then
    cat > "$BASE_ENV_FILE" << EOF
CLOSEDLOOP_WORKDIR=$CLOSEDLOOP_WORKDIR
CLAUDE_PLUGIN_ROOT=$PLUGIN_ROOT
CLOSEDLOOP_PRD_FILE=${CLOSEDLOOP_PRD_FILE:-}
CLOSEDLOOP_MAX_ITERATIONS=${CLOSEDLOOP_MAX_ITERATIONS:-10}
EOF
    echo "$(date): Wrote base environment to $BASE_ENV_FILE" >> "$DEBUG_LOG"
fi

# Strip plugin prefix for agent-specific files (e.g., "code:plan-validator" -> "plan-validator")
AGENT_NAME_ONLY="${AGENT_TYPE##*:}"
AGENT_NAME_LOWER=$(echo "$AGENT_NAME_ONLY" | tr '[:upper:]' '[:lower:]')

# Build systemPromptSuffix with environment info (always inject for closedloop runs)
SUFFIX_PARTS=""
ENV_INFO="<closedloop-environment>
CLOSEDLOOP_WORKDIR=$CLOSEDLOOP_WORKDIR
CLOSEDLOOP_AGENT_ID=${AGENT_ID:-}
CLOSEDLOOP_PRD_FILE=${CLOSEDLOOP_PRD_FILE:-}
CLOSEDLOOP_MAX_ITERATIONS=${CLOSEDLOOP_MAX_ITERATIONS:-10}
CLAUDE_PLUGIN_ROOT=$PLUGIN_ROOT

IMPORTANT: When your instructions reference \${VARIABLE_NAME} (e.g., \${CLAUDE_PLUGIN_ROOT}), substitute it with the corresponding value from this block. For example, \${CLAUDE_PLUGIN_ROOT}/schemas/plan-schema.json means: $PLUGIN_ROOT/schemas/plan-schema.json

When running bash commands that need these variables, first export them:
export CLOSEDLOOP_WORKDIR=\"$CLOSEDLOOP_WORKDIR\"
export CLAUDE_PLUGIN_ROOT=\"$PLUGIN_ROOT\"
</closedloop-environment>"
SUFFIX_PARTS="$ENV_INFO"

# Derive agent name for learnings filtering
# SubagentStart input provides agent_type (e.g., "code:plan-writer")
# but not agentName. Use the short name already derived above.
AGENT_NAME="$AGENT_NAME_ONLY"

# Path to org-patterns.toon (fall back to legacy location during migration)
PATTERNS_FILE="$HOME/.closedloop-ai/learnings/org-patterns.toon"
if [[ ! -f "$PATTERNS_FILE" ]]; then
    PATTERNS_FILE="$HOME/.claude/.learnings/org-patterns.toon"
fi

# Only process learnings if we have agent name and patterns file
if [[ -z "$AGENT_NAME" ]] || [[ ! -f "$PATTERNS_FILE" ]]; then
    # Output environment info only
    SUFFIX_ESCAPED=$(echo "$SUFFIX_PARTS" | jq -Rs '.')
    echo "$(date): Injecting environment variables for agent: $AGENT_TYPE" >> "$DEBUG_LOG"
    echo "$(date): additionalContext: $SUFFIX_ESCAPED" >> "$DEBUG_LOG"
    echo "{\"hookSpecificOutput\": {\"additionalContext\": $SUFFIX_ESCAPED}}"
    exit 0
fi

# Check if agent requires learnings (learnings-required agents)
# For now, inject to all agents - the agent definition can specify if it processes learnings
LEARNINGS_REQUIRED=true

if [[ "$LEARNINGS_REQUIRED" != "true" ]]; then
    # Still output environment info even if learnings not required
    SUFFIX_ESCAPED=$(echo "$SUFFIX_PARTS" | jq -Rs '.')
    echo "{\"systemPromptSuffix\": $SUFFIX_ESCAPED}"
    exit 0
fi

# Get pattern priority from goal config (if available)
PATTERN_PRIORITY=""
if [[ -n "$CLOSEDLOOP_ACTIVE_GOAL" ]]; then
    GOAL_FILE="$CLOSEDLOOP_WORKDIR/.learnings/goal.yaml"
    if [[ -f "$GOAL_FILE" ]] && command -v python3 &> /dev/null; then
        # Extract pattern priority using Python (more reliable for YAML)
        PATTERN_PRIORITY=$(python3 -c "
import yaml
import sys
try:
    with open('$GOAL_FILE') as f:
        config = yaml.safe_load(f)
    goal = config.get('goals', {}).get('$CLOSEDLOOP_ACTIVE_GOAL', {})
    priority = goal.get('pattern_priority', [])
    if priority:
        print(','.join(priority))
except:
    pass
" 2>/dev/null || true)
    fi
fi

# Derive repo ID from git remote or directory name
# Handles worktrees: git-common-dir points to the main repo's .git even from a worktree
get_repo_id() {
    local dir="$1"
    local remote_url
    remote_url=$(git -C "$dir" remote get-url origin 2>/dev/null || echo "")
    if [[ -n "$remote_url" ]]; then
        # Extract repo name: strip trailing .git, take basename
        basename "$remote_url" .git
    else
        # Resolve the real repo root (works for both worktrees and normal checkouts)
        local git_common_dir
        git_common_dir=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null || echo "")
        if [[ -n "$git_common_dir" ]]; then
            # git-common-dir returns path to .git dir; parent is the repo root
            basename "$(cd "$dir" && cd "$git_common_dir/.." && pwd)"
        else
            basename "$dir"
        fi
    fi
}

REPO_ID=$(get_repo_id "$CWD")
echo "$(date): Derived REPO_ID=$REPO_ID" >> "$DEBUG_LOG"

# Parse org-patterns.toon and filter for this agent
# TOON format (comma-delimited, 10 fields):
# id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo
# Legacy 9-field rows accepted (repo defaults to "*")
# Use gawk with FPAT to handle quoted fields properly

LEARNINGS=$(gawk -v agent="$AGENT_NAME" -v agent_full="$AGENT_TYPE" -v priority="$PATTERN_PRIORITY" -v repo="$REPO_ID" '
BEGIN {
    FPAT = "([^,]*|\"[^\"]*\")"
    n = 0
}
/^#/ { next }  # Skip comments
/^[[:space:]]*$/ { next }  # Skip empty lines
/^patterns\[/ { next }  # Skip schema declaration
{
    # Strip leading whitespace (TOON rows are indented 2 spaces)
    gsub(/^[[:space:]]+/, "")

    # Parse comma-delimited fields
    id = $1
    category = $2
    summary = $3
    confidence = $4
    seen_count = $5
    success_rate = $6
    flags = $7
    applies_to = $8
    context = $9
    repo_field = $10  # 10th field; empty for legacy 9-field rows

    # Remove surrounding quotes from summary if present
    gsub(/^"|"$/, "", summary)

    # Remove surrounding quotes from repo_field if present
    gsub(/^"|"$/, "", repo_field)

    # Check if pattern applies to this repo
    # repo_field: "*" or empty = matches all repos, otherwise must match current repo
    repo_applies = 0
    if (repo_field == "*" || repo_field == "" || repo_field == repo) {
        repo_applies = 1
    }

    if (!repo_applies) next

    # Check if pattern applies to this agent
    # applies_to uses pipe-separated agent names: * (all), agent_name, or "agent1|agent2"
    applies = 0
    gsub(/^"|"$/, "", applies_to)
    if (applies_to == "*" || applies_to == "") {
        applies = 1
    } else {
        # Split by pipe (agents are pipe-separated in TOON)
        # Match against both short name (e.g., "plan-writer") and
        # full name (e.g., "code:plan-writer") since applies_to
        # uses both conventions
        split(applies_to, agents, "|")
        for (i in agents) {
            if (agents[i] == agent || agents[i] == agent_full) {
                applies = 1
                break
            }
        }
    }

    if (applies) {
        patterns[n]["id"] = id
        patterns[n]["category"] = category
        patterns[n]["confidence"] = confidence
        patterns[n]["flags"] = flags
        patterns[n]["summary"] = summary
        n++
    }
}
END {
    if (n == 0) exit

    # Sort by category priority (default: mistake > convention > pattern > insight)
    if (priority == "") {
        priority = "mistake,convention,pattern,insight"
    }
    split(priority, prio_order, ",")

    # Confidence sort values: high=0, medium=1, low=2
    # Bubble sort by: 1) category priority, 2) confidence (high first)
    for (i = 0; i < n-1; i++) {
        for (j = 0; j < n-1-i; j++) {
            cat1 = patterns[j]["category"]
            cat2 = patterns[j+1]["category"]
            prio1 = 999
            prio2 = 999
            for (p in prio_order) {
                if (prio_order[p] == cat1) prio1 = p
                if (prio_order[p] == cat2) prio2 = p
            }
            swap = 0
            if (prio1 > prio2) {
                swap = 1
            } else if (prio1 == prio2) {
                # Secondary sort: confidence (high < medium < low)
                conf1 = patterns[j]["confidence"]
                conf2 = patterns[j+1]["confidence"]
                cv1 = (conf1 == "high" ? 0 : (conf1 == "medium" ? 1 : 2))
                cv2 = (conf2 == "high" ? 0 : (conf2 == "medium" ? 1 : 2))
                if (cv1 > cv2) swap = 1
            }
            if (swap) {
                for (k in patterns[j]) {
                    tmp = patterns[j][k]
                    patterns[j][k] = patterns[j+1][k]
                    patterns[j+1][k] = tmp
                }
            }
        }
    }

    # Cap at 15 patterns
    max_inject = 15
    truncated = 0
    if (n > max_inject) {
        truncated = n - max_inject
        n = max_inject
    }

    # Output for LLM consumption
    print "<organization-learnings>"
    print "# Patterns from organization knowledge base"
    print "# Format: [CONFIDENCE] SUMMARY (FLAGS if any)"
    if (truncated > 0) {
        printf "# Note: %d additional patterns omitted (showing top %d by priority)\n", truncated, max_inject
    }
    print ""
    for (i = 0; i < n; i++) {
        conf = patterns[i]["confidence"]
        summ = patterns[i]["summary"]
        flgs = patterns[i]["flags"]

        if (flgs != "") {
            printf "[%s] %s %s\n", conf, summ, flgs
        } else {
            printf "[%s] %s\n", conf, summ
        }
    }
    print ""
    print "IMPORTANT: You MUST acknowledge these patterns in your response."
    print "Output LEARNINGS_ACKNOWLEDGED with evidence showing which patterns you applied."
    print "Format: Applied: \"pattern summary\" -> [evidence at file:line]"
    print "If no patterns were applicable, output: LEARNINGS_ACKNOWLEDGED: no_learnings (reason)"
    print "</organization-learnings>"
}
' "$PATTERNS_FILE" 2>/dev/null)

# Add learnings to suffix if they exist
if [[ -n "$LEARNINGS" ]]; then
    SUFFIX_PARTS="$SUFFIX_PARTS

$LEARNINGS"
    # Write learnings to agent-specific file
    LEARNINGS_FILE="$CWD/.closedloop-ai/learnings-$AGENT_NAME_LOWER"
    echo "$LEARNINGS" > "$LEARNINGS_FILE"
    echo "$(date): Wrote learnings to $LEARNINGS_FILE" >> "$DEBUG_LOG"
fi

# Always output env info (and learnings if present)
# SUFFIX_PARTS is guaranteed to have at least ENV_INFO at this point
SUFFIX_ESCAPED=$(echo "$SUFFIX_PARTS" | jq -Rs '.')
echo "$(date): additionalContext (with learnings): $SUFFIX_ESCAPED" >> "$DEBUG_LOG"
echo "{\"hookSpecificOutput\": {\"additionalContext\": $SUFFIX_ESCAPED}}"
