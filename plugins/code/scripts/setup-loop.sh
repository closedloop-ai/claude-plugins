#!/bin/bash

# Loop Setup Script
# Creates state file for agent iteration loops
# Reads config from loop-agents.json

set -euo pipefail

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_CONFIG="$SCRIPT_DIR/loop-agents.json"

# Parse arguments
PRD_FILE=""
MAX_ITERATIONS=""
WORKDIR="."
AGENT_TYPE="code:plan-writer"  # Default for backwards compatibility

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Loop Setup - Initialize agent iteration loop

USAGE:
  setup-loop.sh --workdir <dir> --prd <file> [OPTIONS]

OPTIONS:
  --workdir <dir>           Working directory (default: .)
  --prd <file>              PRD/requirements file (required)
  --agent-type <type>       Agent type from loop-agents.json (default: code:plan-writer)
  --max-iterations <n>      Override max iterations from config
  -h, --help                Show this help message

DESCRIPTION:
  Initializes a loop for the specified agent type. The agent will:
  1. Execute its task
  2. Run validation (if configured)
  3. Iterate until validation passes (or max iterations)

  This script is idempotent - it skips setup if:
  - The loop's output file already exists
  - A loop is already active for this agent

EXAMPLES:
  setup-loop.sh --workdir /path/to/project --prd prd.pdf
  setup-loop.sh --prd requirements.md --agent-type code:plan-writer
HELP_EOF
      exit 0
      ;;
    --workdir)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --workdir requires a directory path" >&2
        exit 1
      fi
      WORKDIR="$2"
      shift 2
      ;;
    --prd)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --prd requires a file path" >&2
        exit 1
      fi
      PRD_FILE="$2"
      shift 2
      ;;
    --agent-type)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --agent-type requires an agent type" >&2
        exit 1
      fi
      AGENT_TYPE="$2"
      shift 2
      ;;
    --max-iterations)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --max-iterations requires a positive number" >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Validate PRD file
if [[ -z "$PRD_FILE" ]]; then
  echo "Error: --prd is required" >&2
  echo "Usage: setup-loop.sh --prd <file>" >&2
  exit 1
fi

if [[ ! -f "$PRD_FILE" ]]; then
  echo "Error: PRD file not found: $PRD_FILE" >&2
  exit 1
fi

# Read agent config
if [[ ! -f "$LOOP_CONFIG" ]]; then
  echo "Error: Loop config not found: $LOOP_CONFIG" >&2
  exit 1
fi

AGENT_CONFIG=$(jq -r --arg type "$AGENT_TYPE" '.loop_agents[$type] // empty' "$LOOP_CONFIG")
if [[ -z "$AGENT_CONFIG" ]] || [[ "$AGENT_CONFIG" == "null" ]]; then
  echo "Error: Agent type '$AGENT_TYPE' not found in loop-agents.json" >&2
  exit 1
fi

# Parse config
STATE_FILE_SUFFIX=$(echo "$AGENT_CONFIG" | jq -r '.state_file_suffix // "loop.local.md"')
PROMISE=$(echo "$AGENT_CONFIG" | jq -r '.promise // "COMPLETE"')
CONFIG_MAX_ITERATIONS=$(echo "$AGENT_CONFIG" | jq -r '.max_iterations // 10')

# Use command line override or config default
MAX_ITERATIONS="${MAX_ITERATIONS:-$CONFIG_MAX_ITERATIONS}"

STATE_FILE="$WORKDIR/$CLOSEDLOOP_STATE_DIR/$STATE_FILE_SUFFIX"

# Idempotency checks
if [[ -f "$WORKDIR/plan.json" ]]; then
  echo "Plan already exists at $WORKDIR/plan.json - skipping loop setup"
  exit 0
fi

if [[ -f "$STATE_FILE" ]]; then
  echo "Loop already active ($STATE_FILE) - skipping setup"
  exit 0
fi

# Create state file
mkdir -p "$WORKDIR/$CLOSEDLOOP_STATE_DIR"

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

cat > "$STATE_FILE" <<EOF
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
EOF

# Export CLOSEDLOOP_WORKDIR for hooks
export CLOSEDLOOP_WORKDIR="$WORKDIR"

# Output setup message
cat <<EOF
Plan Writer activated!

Working directory: $WORKDIR
PRD File: $PRD_FILE
Agent Type: $AGENT_TYPE
Max iterations: $MAX_ITERATIONS
State file: $STATE_FILE

The loop will iterate until:
- All validation checks pass, OR
- Max iterations ($MAX_ITERATIONS) reached

To cancel: rm $STATE_FILE

Starting plan generation...
EOF

echo ""
echo "$PROMPT"
