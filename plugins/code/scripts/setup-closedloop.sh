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
PROMPT_NAME_EXPLICIT=false
POSITIONAL_ARGS=()
ADD_DIRS=()

array_contains() {
    local needle="$1"
    shift

    local value
    for value in "$@"; do
        if [[ "$value" == "$needle" ]]; then
            return 0
        fi
    done

    return 1
}

make_unique_repo_name() {
    local base_name="$1"
    local repo_path="$2"
    shift 2
    local used_names=("$@")

    local path_without_root="${repo_path#/}"
    local path_parts=()
    local old_ifs="$IFS"
    IFS='/'
    read -r -a path_parts <<< "$path_without_root"
    IFS="$old_ifs"

    local last_index=$((${#path_parts[@]} - 1))
    local suffix_end_index="$last_index"
    local start_index="$last_index"
    if [[ ${#path_parts[@]} -gt 0 ]] && [[ "${path_parts[$last_index]}" == "$base_name" ]]; then
        start_index=$((last_index - 1))
        suffix_end_index=$((last_index - 1))
    fi

    local candidate=""
    local suffix=""
    local counter=2
    while [[ $start_index -ge 0 ]]; do
        suffix="$(IFS='-'; echo "${path_parts[*]:$start_index:$((suffix_end_index - start_index + 1))}")"
        candidate="$base_name-$suffix"
        if ! array_contains "$candidate" "${used_names[@]}"; then
            echo "$candidate"
            return 0
        fi
        start_index=$((start_index - 1))
    done

    candidate="$base_name-$counter"
    while array_contains "$candidate" "${used_names[@]}"; do
        counter=$((counter + 1))
        candidate="$base_name-$counter"
    done

    echo "$candidate"
}

resolve_directory_path() {
    local raw_dir="$1"
    local resolved_path=""

    if ! resolved_path="$(cd "$raw_dir" 2>/dev/null && pwd -P)"; then
        return 1
    fi

    echo "$resolved_path"
}

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
            PROMPT_NAME_EXPLICIT=true
            shift 2
            ;;
        --add-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --add-dir requires a directory path" >&2
                exit 1
            fi
            ADD_DIRS+=("$2")
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

WORKDIR="${WORKDIR:-.}"
# Resolve to a canonical absolute path so primary-vs-secondary comparisons are reliable.
if ! WORKDIR="$(resolve_directory_path "$WORKDIR")"; then
    echo "Error: workdir path does not exist or is not a directory: ${POSITIONAL_ARGS[0]:-.}" >&2
    exit 1
fi

PRIMARY_REPO_NAME="$(basename "$WORKDIR")"
PRIMARY_REPO_NAME="${PRIMARY_REPO_NAME:-primary}"

# Post-loop: resolve and validate each ADD_DIRS entry
RESOLVED_ADD_DIRS=()
ADD_DIR_NAMES=()
USED_REPO_NAMES=("$PRIMARY_REPO_NAME")
for raw_dir in "${ADD_DIRS[@]}"; do
    if ! abs_path="$(resolve_directory_path "$raw_dir")"; then
        echo "Error: --add-dir path does not exist or is not a directory: $raw_dir" >&2
        exit 1
    fi
    if [[ "$abs_path" == "$WORKDIR" ]]; then
        continue
    fi
    if array_contains "$abs_path" "${RESOLVED_ADD_DIRS[@]}"; then
        continue
    fi
    identity_file="$abs_path/.closedloop-ai/.repo-identity.json"
    repo_name="$(jq -r '.name // empty' "$identity_file" 2>/dev/null || true)"
    if [[ -z "$repo_name" ]]; then
        repo_name="$(basename "$abs_path")"
    fi
    if array_contains "$repo_name" "${USED_REPO_NAMES[@]}"; then
        repo_name="$(make_unique_repo_name "$repo_name" "$abs_path" "${USED_REPO_NAMES[@]}")"
    fi
    RESOLVED_ADD_DIRS+=("$abs_path")
    ADD_DIR_NAMES+=("$repo_name")
    USED_REPO_NAMES+=("$repo_name")
done

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
    CURRENT_PID=$(ps -o ppid= -p """""$CURRENT"_"P"I"D" 2>/dev/null | tr -d ' ')
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

# Step 3: Auto-select prompt based on whether extra repos were provided
if [[ "$PROMPT_NAME_EXPLICIT" == false ]]; then
    if [[ ${#RESOLVED_ADD_DIRS[@]} -gt 0 ]]; then
        PROMPT_NAME="multi-repo"
    else
        PROMPT_NAME="${PROMPT_NAME:-prompt}"
    fi
fi

# Validate prompt name contains no path separators
if [[ "$PROMPT_NAME" == */* || "$PROMPT_NAME" == *..* || "$PROMPT_NAME" =~ [[:space:]] ]]; then
    echo "ERROR: prompt name must not contain path separators or spaces" >&2
    exit 1
fi

# Resolve prompt: direct base file takes precedence; otherwise assemble
# base prompt.md + overlay. See plugins/code/prompts/overlays/README.md.
DIRECT_PROMPT="$PLUGIN_ROOT/prompts/$PROMPT_NAME.md"
OVERLAY_PROMPT="$PLUGIN_ROOT/prompts/overlays/$PROMPT_NAME.overlay.md"
BASE_PROMPT="$PLUGIN_ROOT/prompts/prompt.md"

# Ensure WORKDIR/.closedloop exists before writing the assembled file
mkdir -p "$WORKDIR/.closedloop"

if [[ -f "$DIRECT_PROMPT" ]]; then
    CLOSEDLOOP_PROMPT_FILE="$DIRECT_PROMPT"
elif [[ -f "$OVERLAY_PROMPT" ]]; then
    if [[ ! -f "$BASE_PROMPT" ]]; then
        echo "ERROR: base prompt missing: $BASE_PROMPT" >&2
        exit 1
    fi
    ASSEMBLED_PROMPT="$WORKDIR/.closedloop/prompt-assembled.md"
    {
        cat "$BASE_PROMPT"
        printf '\n\n'
        cat "$OVERLAY_PROMPT"
    } > "$ASSEMBLED_PROMPT"
    CLOSEDLOOP_PROMPT_FILE="$ASSEMBLED_PROMPT"
else
    echo "ERROR: Prompt '$PROMPT_NAME' not found (no $DIRECT_PROMPT, no $OVERLAY_PROMPT)" >&2
    echo "Available prompts:" >&2
    shopt -s nullglob
    for f in "$PLUGIN_ROOT/prompts/"*.md; do
        basename "$f" .md >&2
    done
    for f in "$PLUGIN_ROOT/prompts/overlays/"*.overlay.md; do
        name="$(basename "$f" .overlay.md)"
        echo "$name (overlay)" >&2
    done
    shopt -u nullglob
    exit 1
fi

# Write full config to WORKDIR
mkdir -p "$WORKDIR/.closedloop-ai"

cat > "$WORKDIR/.closedloop-ai/config.env" << EOF
CLOSEDLOOP_WORKDIR="$WORKDIR"
CLOSEDLOOP_PRD_FILE="$PRD_FILE"
CLOSEDLOOP_PLAN_FILE="$PLAN_FILE"
CLOSEDLOOP_MAX_ITERATIONS="$MAX_ITERATIONS"
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
CLOSEDLOOP_PROMPT_FILE="$CLOSEDLOOP_PROMPT_FILE"
EOF

# Build pipe-joined multi-repo variables (empty strings when no extra repos)
add_dirs_joined=""
add_dir_names_joined=""
repo_map_joined=""
if [[ ${#RESOLVED_ADD_DIRS[@]} -gt 0 ]]; then
    add_dirs_joined="$(IFS='|'; echo "${RESOLVED_ADD_DIRS[*]}")"
    add_dir_names_joined="$(IFS='|'; echo "${ADD_DIR_NAMES[*]}")"
    repo_map_parts=()
    for i in "${!RESOLVED_ADD_DIRS[@]}"; do
        repo_map_parts+=("${ADD_DIR_NAMES[$i]}=${RESOLVED_ADD_DIRS[$i]}")
    done
    repo_map_joined="$(IFS='|'; echo "${repo_map_parts[*]}")"
fi
cat >> "$WORKDIR/.closedloop/config.env" << EOF
CLOSEDLOOP_ADD_DIRS="$add_dirs_joined"
CLOSEDLOOP_ADD_DIR_NAMES="$add_dir_names_joined"
CLOSEDLOOP_REPO_MAP="$repo_map_joined"
EOF

echo "ClosedLoop config written to $WORKDIR/.closedloop-ai/config.env"
cat "$WORKDIR/.closedloop-ai/config.env"
