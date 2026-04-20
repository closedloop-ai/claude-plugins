#!/bin/bash

# debate-loop.sh - Iterative plan refinement via Claude + Codex debate
#
# Creates a plan with Claude, has Codex review it, and iterates until
# Codex approves or max rounds are reached.
#
# Usage:
#   debate-loop.sh "Build a REST API for user management" [options]
#
# Options:
#   --max-rounds N        Maximum debate rounds (default: 15)
#   --plan-file PATH      Output plan file path (default: ./debate-plan.md)
#   --codex-model MODEL   Codex model to use (default: gpt-5.3-codex)
#   -h, --help            Show this help
#
# Claude sessions are resumed across rounds for context continuity.
# Falls back to fresh context if session resume fails.

set -euo pipefail

# Claude binary path. When spawned by the closedloop-electron desktop app,
# CLAUDE_BIN is set to the absolute path that the desktop validated in its
# pre-flight check. Falls back to bare `claude` for manual/interactive runs
# where PATH is trusted. See run-loop.sh for the same pattern.
CLAUDE="${CLAUDE_BIN:-claude}"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORMATTER="$SCRIPTS_DIR/../tools/python/stream_formatter.py"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
MAX_ROUNDS=15
PLAN_FILE=""
CODEX_MODEL="gpt-5.3-codex"
CLAUDE_MODEL="opus[1m]"
PROMPT=""
VERBOSE=false
ADD_DIRS=()

# Temp files tracked for cleanup
TMPFILES=()
# PID of the currently-running child process (claude or codex); 0 = none
CURRENT_CHILD_PID=0

cleanup() {
  if [[ ${#TMPFILES[@]} -gt 0 ]]; then
    rm -f "${TMPFILES[@]}" 2>/dev/null || true
  fi
}

on_interrupt() {
  echo ""
  echo -e "${YELLOW}Interrupted by user${NC}"
  if [[ $CURRENT_CHILD_PID -ne 0 ]]; then
    kill "$CURRENT_CHILD_PID" 2>/dev/null || true
  fi
  if [[ -n "${PLAN_FILE_ABS:-}" ]] && [[ -f "$PLAN_FILE_ABS" ]]; then
    echo -e "${YELLOW}Partial plan available at: $PLAN_FILE_ABS${NC}"
  fi
  exit 130
}

trap cleanup EXIT
trap on_interrupt INT TERM

# Run claude, streaming output only when --verbose is set.
# Writes stderr to $CLAUDE_STDERR. Returns claude's exit code.
# Runs claude in the background so the INT trap fires immediately on Ctrl+C.
run_claude() {
  local -a claude_args=("$@" --model "$CLAUDE_MODEL")
  if [[ ${#ADD_DIR_ARGS[@]} -gt 0 ]]; then
    claude_args+=("${ADD_DIR_ARGS[@]}")
  fi
  local exit_code
  if [[ "$VERBOSE" == "true" ]]; then
    local claude_exit_file
    claude_exit_file=$(mktemp)
    TMPFILES+=("$claude_exit_file")
    { "$CLAUDE" "${claude_args[@]}" --output-format stream-json --verbose 2>"$CLAUDE_STDERR"; echo $? > "$claude_exit_file"; } \
      | python3 "$FORMATTER" &
    CURRENT_CHILD_PID=$!
    wait $CURRENT_CHILD_PID || true
    CURRENT_CHILD_PID=0
    exit_code=$(cat "$claude_exit_file" 2>/dev/null || echo "1")
  else
    "$CLAUDE" "${claude_args[@]}" --output-format text > /dev/null 2>"$CLAUDE_STDERR" &
    CURRENT_CHILD_PID=$!
    wait $CURRENT_CHILD_PID && exit_code=0 || exit_code=$?
    CURRENT_CHILD_PID=0
  fi
  return "$exit_code"
}

save_state() {
  printf 'SESSION_ID=%s\nCODEX_SESSION_ID=%s\nROUND=%s\nPHASE=%s\nLOG_ID=%s\n' \
    "$SESSION_ID" "$CODEX_SESSION_ID" "$round" "$PHASE" "${CODEX_LOG_ID:-}" > "$STATE_FILE"
}

load_state() {
  SESSION_ID=$(grep "^SESSION_ID=" "$STATE_FILE" | cut -d= -f2-) || true
  CODEX_SESSION_ID=$(grep "^CODEX_SESSION_ID=" "$STATE_FILE" | cut -d= -f2-) || true
  round=$(grep "^ROUND=" "$STATE_FILE" | cut -d= -f2-) || true
  round="${round:-1}"
  PHASE=$(grep "^PHASE=" "$STATE_FILE" | cut -d= -f2-) || true
  PHASE="${PHASE:-codex_review}"
  CODEX_LOG_ID=$(grep "^LOG_ID=" "$STATE_FILE" | cut -d= -f2-) || true
}

# Shared Codex review script (extracted to avoid duplication with the native
# debate-loop.md slash command, which uses the same script via the codex-review skill).
CODEX_REVIEW_SCRIPT="$SCRIPTS_DIR/../skills/codex-review/scripts/run_codex_review.sh"

# Run the shared Codex review script in the background so the INT trap fires
# immediately on Ctrl+C. Parses stdout tokens into CODEX_VERDICT and
# CODEX_SESSION_ID. Writes full feedback text to FEEDBACK_FILE.
# Sets CODEX_REVIEW_EXIT in the caller's scope.
run_codex_review() {
  if [[ ! -f "$CODEX_REVIEW_SCRIPT" ]]; then
    echo -e "${RED}Error: Codex review script not found at $CODEX_REVIEW_SCRIPT${NC}" >&2
    exit 1
  fi

  local review_args=(
    --plan-file "$PLAN_FILE_ABS"
    --feedback-file "$FEEDBACK_FILE"
    --round "$round"
    --codex-model "$CODEX_MODEL"
  )
  if [[ -n "$PROMPT" ]]; then
    local request_file
    request_file=$(mktemp)
    TMPFILES+=("$request_file")
    printf '%s' "$PROMPT" > "$request_file"
    review_args+=(--request-file "$request_file")
  fi
  if [[ -n "$CODEX_SESSION_ID" ]]; then
    review_args+=(--session-id "$CODEX_SESSION_ID")
  fi
  if [[ -n "${CODEX_LOG_ID:-}" ]]; then
    review_args+=(--log-id "$CODEX_LOG_ID")
  fi

  local review_output_file review_stderr_file
  review_output_file=$(mktemp)
  review_stderr_file=$(mktemp)
  TMPFILES+=("$review_output_file" "$review_stderr_file")

  bash "$CODEX_REVIEW_SCRIPT" "${review_args[@]}" > "$review_output_file" 2>"$review_stderr_file" &
  CURRENT_CHILD_PID=$!
  wait $CURRENT_CHILD_PID && CODEX_REVIEW_EXIT=0 || CODEX_REVIEW_EXIT=$?
  CURRENT_CHILD_PID=0

  # Fail fast if the script itself crashed (no tokens parsed)
  if [[ $CODEX_REVIEW_EXIT -ne 0 ]] && [[ ! -s "$review_output_file" ]]; then
    echo -e "${RED}Error: Codex review script failed (exit $CODEX_REVIEW_EXIT)${NC}" >&2
    if [[ -s "$review_stderr_file" ]]; then
      cat "$review_stderr_file" >&2
    fi
    exit 1
  fi

  # Parse structured tokens from stdout
  CODEX_VERDICT=""
  local line
  while IFS= read -r line; do
    case "$line" in
      VERDICT:*)       CODEX_VERDICT="${line#VERDICT:}" ;;
      CODEX_SESSION:*) CODEX_SESSION_ID="${line#CODEX_SESSION:}"; [[ "$CODEX_SESSION_ID" == "none" ]] && CODEX_SESSION_ID="" ;;
      LOG_ID:*)        CODEX_LOG_ID="${line#LOG_ID:}"; [[ "$CODEX_LOG_ID" == "none" ]] && CODEX_LOG_ID="" ;;
      CODEX_FAILED:*)  CODEX_VERDICT="FAILED:${line#CODEX_FAILED:}" ;;
      CODEX_EMPTY)     CODEX_VERDICT="EMPTY" ;;
    esac
  done < "$review_output_file"

  # If no token was parsed at all, treat as a script failure
  if [[ -z "$CODEX_VERDICT" ]]; then
    echo -e "${RED}Error: Codex review script produced no verdict token${NC}" >&2
    if [[ -s "$review_stderr_file" ]]; then
      cat "$review_stderr_file" >&2
    fi
    exit 1
  fi
}

show_help() {
  cat <<'EOF'
debate-loop.sh - Iterative plan refinement via Claude + Codex debate

USAGE:
  debate-loop.sh [options] "<prompt>"

OPTIONS:
  --max-rounds N        Maximum debate rounds (default: 15)
  --plan-file PATH      Output plan file path (default: ./debate-plan.md)
  --codex-model MODEL   Codex model to use (default: gpt-5.3-codex)
  --model MODEL         Claude model to use (default: opus[1m])
  --add-dir DIR...      Additional directories to allow Claude tool access to
  --verbose             Stream Claude output in real-time (default: off)
  -h, --help            Show this help

DESCRIPTION:
  1. Claude creates an implementation plan from your prompt
  2. Codex reviews the plan and provides feedback
  3. Claude addresses the feedback and updates the plan
  4. Repeat until Codex approves or max rounds reached

EXAMPLES:
  debate-loop.sh "Build a REST API for user management"
  debate-loop.sh --plan-file auth-plan.md --max-rounds 10 "Refactor the auth system"
  debate-loop.sh --codex-model gpt-5.3-codex "Add caching layer"
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      show_help
      exit 0
      ;;
    --max-rounds)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -eq 0 ]]; then
        echo -e "${RED}Error: --max-rounds requires a positive integer${NC}" >&2
        exit 1
      fi
      MAX_ROUNDS="$2"
      shift 2
      ;;
    --plan-file)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --plan-file requires a path${NC}" >&2
        exit 1
      fi
      PLAN_FILE="$2"
      shift 2
      ;;
    --codex-model)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --codex-model requires a model name${NC}" >&2
        exit 1
      fi
      CODEX_MODEL="$2"
      shift 2
      ;;
    --model)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --model requires a model name${NC}" >&2
        exit 1
      fi
      CLAUDE_MODEL="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --add-dir)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --add-dir requires at least one directory${NC}" >&2
        exit 1
      fi
      shift
      while [[ $# -gt 0 ]] && [[ "${1:0:1}" != "-" ]]; do
        ADD_DIRS+=("$1")
        shift
      done
      ;;
    -*)
      echo -e "${RED}Error: Unknown option: $1${NC}" >&2
      echo "Use --help for usage information" >&2
      exit 1
      ;;
    *)
      if [[ -n "$PROMPT" ]]; then
        echo -e "${RED}Error: Multiple prompts provided. Wrap your prompt in quotes.${NC}" >&2
        exit 1
      fi
      PROMPT="$1"
      shift
      ;;
  esac
done

# Validate prompt
if [[ -z "$PROMPT" ]]; then
  echo -e "${RED}Error: No prompt provided${NC}" >&2
  echo "Usage: debate-loop.sh [options] \"<prompt>\"" >&2
  exit 1
fi

# Validate --add-dir paths and build args array
ADD_DIR_ARGS=()
if [[ ${#ADD_DIRS[@]} -gt 0 ]]; then
  for dir in "${ADD_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
      echo -e "${RED}Error: --add-dir path is not a directory: $dir${NC}" >&2
      exit 1
    fi
    ADD_DIR_ARGS+=(--add-dir "$dir")
  done
fi

# Check dependencies
for cmd in "$CLAUDE" codex; do
  if ! command -v "$cmd" &> /dev/null; then
    echo -e "${RED}Error: $cmd is required but not found${NC}" >&2
    exit 1
  fi
done

# Generate session ID (UUID required by --session-id)
generate_session_id() {
  uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' \
    || cat /proc/sys/kernel/random/uuid 2>/dev/null \
    || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null \
    || echo "$(date +%s)-$(head -c 8 /dev/urandom | xxd -p)"
}

# Resolve plan file to absolute path
PLAN_FILE="${PLAN_FILE:-./debate-plan.md}"
PLAN_DIR="$(dirname "$PLAN_FILE")"

# Validate parent directory exists
if [[ ! -d "$PLAN_DIR" ]]; then
  echo -e "${RED}Error: Parent directory does not exist: $PLAN_DIR${NC}" >&2
  echo "Create it first or use a different --plan-file path" >&2
  exit 1
fi

PLAN_DIR="$(cd "$PLAN_DIR" && pwd)"
PLAN_FILE_ABS="${PLAN_DIR}/$(basename "$PLAN_FILE")"

STATE_FILE="${PLAN_FILE_ABS%.md}.state"
FEEDBACK_FILE="${PLAN_FILE_ABS%.md}.feedback"
RESUMING=false
CODEX_SESSION_ID=""
PHASE=codex_review

if [[ -f "$STATE_FILE" ]] && [[ -f "$PLAN_FILE_ABS" ]]; then
  load_state
  RESUMING=true
fi

if [[ "$RESUMING" == "false" ]]; then
  SESSION_ID=$(generate_session_id)
fi

# Warn if plan file already exists (skip when resuming -- file is intentionally kept)
if [[ -f "$PLAN_FILE_ABS" ]] && [[ "$RESUMING" == "false" ]]; then
  echo -e "${YELLOW}Warning: Plan file already exists at $PLAN_FILE_ABS -- it will be overwritten${NC}"
fi

# Create temp files for codex I/O
CLAUDE_STDERR=$(mktemp)
TMPFILES+=("$CLAUDE_STDERR")

echo -e "${BLUE}================================================================${NC}"
echo -e "${BLUE}  Debate Loop -- Claude + Codex Plan Refinement${NC}"
echo -e "${BLUE}================================================================${NC}"
echo ""
echo -e "Prompt:       ${GREEN}${PROMPT}${NC}"
echo -e "Plan file:    ${GREEN}${PLAN_FILE_ABS}${NC}"
echo -e "Max rounds:   ${YELLOW}${MAX_ROUNDS}${NC}"
echo -e "Claude model: ${CYAN}${CLAUDE_MODEL}${NC}"
echo -e "Codex model:  ${CYAN}${CODEX_MODEL}${NC}"
echo -e "Session:      ${CYAN}${SESSION_ID}${NC}"
echo -e "Verbose:      ${CYAN}${VERBOSE}${NC}"
if [[ ${#ADD_DIRS[@]} -gt 0 ]]; then
  echo -e "Extra dirs:   ${CYAN}${ADD_DIRS[*]}${NC}"
fi
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop at any time${NC}"
echo ""

if [[ "$RESUMING" == "true" ]]; then
  echo -e "${YELLOW}Resuming from round ${round} (session: ${SESSION_ID})${NC}"
  echo ""
fi

# ── Phase 1: Claude creates the plan ────────────────────────────────────────

if [[ "$RESUMING" == "false" ]]; then
  round=1
fi
approved=false

if [[ "$RESUMING" == "false" ]]; then
  echo -e "${BLUE}--- Phase 1: Claude creating plan ---${NC}"
  echo ""

  set +e
  run_claude \
    -p "Use the Agent tool to invoke the code:plan-agent with the following task:

'$PROMPT

Write the plan to $PLAN_FILE_ABS.'

Take note of the plan agent's session ID -- you will need to resume it in subsequent rounds to pass it updated feedback." \
    --session-id "$SESSION_ID" \
    --permission-mode acceptEdits \
    --allowed-tools "Read,Write,Glob,Grep,Agent(code:plan-agent)"
  CLAUDE_EXIT=$?
  set -e

  echo ""

  if [[ $CLAUDE_EXIT -ne 0 ]]; then
    echo -e "${RED}Error: Claude exited with code $CLAUDE_EXIT${NC}" >&2
    if [[ -s "$CLAUDE_STDERR" ]]; then
      echo -e "${RED}stderr:${NC}" >&2
      cat "$CLAUDE_STDERR" >&2
    fi
    exit 1
  fi

  # Verify plan was created
  if [[ ! -f "$PLAN_FILE_ABS" ]]; then
    echo -e "${RED}Error: Claude did not create plan file at $PLAN_FILE_ABS${NC}" >&2
    exit 1
  fi

  PLAN_SIZE=$(wc -c < "$PLAN_FILE_ABS" | tr -d ' ')
  echo -e "${GREEN}Plan created (${PLAN_SIZE} bytes)${NC}"
  echo ""
  PHASE=user_review
  save_state
else
  PLAN_SIZE=$(wc -c < "$PLAN_FILE_ABS" | tr -d ' ')
  echo -e "${GREEN}Resuming with existing plan (${PLAN_SIZE} bytes)${NC}"
  echo ""
fi

# ── Phase 1.5: Interactive user review ────────────────────────────────────────

if [[ "$PHASE" == "user_review" ]]; then
  echo -e "${BLUE}================================================================${NC}"
  echo -e "${BLUE}  Plan Review -- Interactive Mode${NC}"
  echo -e "${BLUE}================================================================${NC}"
  echo ""
  echo -e "Plan file: ${GREEN}${PLAN_FILE_ABS}${NC}"
  echo ""
  echo -e "You can now chat with Claude to review and refine the plan."
  echo -e "Type ${CYAN}/exit${NC} when you are done reviewing."
  echo ""

  while true; do
    # Launch interactive Claude session with instruction to proxy through plan-agent
    local_claude_args=(--model "$CLAUDE_MODEL" -r "$SESSION_ID" -p "The user would like to iterate on the plan interactively. Resume the code:plan-agent from your conversation history. For every message the user sends, pass it to the plan agent so it can respond and make edits to the plan at ${PLAN_FILE_ABS}. Act as a transparent proxy -- do not answer plan questions yourself, always delegate to the plan agent." --permission-mode acceptEdits --allowed-tools "Read,Write,Glob,Grep,Agent(code:plan-agent)")
    if [[ ${#ADD_DIR_ARGS[@]} -gt 0 ]]; then
      local_claude_args+=("${ADD_DIR_ARGS[@]}")
    fi
    "$CLAUDE" "${local_claude_args[@]}" 2>/dev/null
    INTERACTIVE_EXIT=$?

    echo ""
    echo -e "${YELLOW}Ready to start the Codex debate loop? (Y/n)${NC}"
    read -r USER_RESPONSE
    case "${USER_RESPONSE,,}" in
      n|no)
        echo -e "${CYAN}Returning to interactive review...${NC}"
        echo ""
        continue
        ;;
      *)
        echo -e "${GREEN}Starting debate loop...${NC}"
        echo ""
        break
        ;;
    esac
  done

  PHASE=codex_review
  save_state
fi

# ── Phase 2: Debate loop ────────────────────────────────────────────────────

while [[ $round -le $MAX_ROUNDS ]]; do

  # ── Codex review (skip if resuming mid-round into Claude's turn) ──────────

  if [[ "$PHASE" != "claude_revision" ]]; then
    echo -e "${BLUE}--- Round ${round}/${MAX_ROUNDS}: Codex reviewing plan ---${NC}"
    echo ""

    # Run the shared Codex review script
    set +e
    run_codex_review
    set -e

    save_state

    # Handle failures and empty responses
    if [[ "$CODEX_VERDICT" == FAILED:* ]]; then
      echo -e "${RED}Error: Codex failed: ${CODEX_VERDICT#FAILED:}${NC}" >&2
      exit 1
    fi

    if [[ "$CODEX_VERDICT" == "EMPTY" ]]; then
      echo -e "${YELLOW}Warning: Codex returned empty response, skipping round${NC}"
      echo ""
      round=$((round + 1))
      continue
    fi

    # Read and display feedback
    FEEDBACK=$(cat "$FEEDBACK_FILE" 2>/dev/null || echo "")

    echo -e "${CYAN}Codex feedback:${NC}"
    echo "────────────────────────────────────────"
    echo "$FEEDBACK"
    echo "────────────────────────────────────────"
    echo ""

    # Check verdict
    if [[ "$CODEX_VERDICT" == "APPROVED" ]]; then
      echo -e "${GREEN}================================================================${NC}"
      echo -e "${GREEN}  Plan approved by Codex after ${round} round(s)${NC}"
      echo -e "${GREEN}================================================================${NC}"
      echo ""
      approved=true
      break
    fi

    # If this was the last round, don't bother with another Claude revision
    if [[ $round -ge $MAX_ROUNDS ]]; then
      echo -e "${YELLOW}================================================================${NC}"
      echo -e "${YELLOW}  Max rounds (${MAX_ROUNDS}) reached without approval${NC}"
      echo -e "${YELLOW}================================================================${NC}"
      echo ""
      break
    fi

    PHASE=claude_revision
    save_state

  else
    # Resuming mid-round: Codex already reviewed, load saved feedback
    echo -e "${GREEN}Resuming at Claude revision (round ${round}, Codex feedback saved)${NC}"
    FEEDBACK=$(cat "$FEEDBACK_FILE" 2>/dev/null || echo "")
    echo -e "${CYAN}Codex feedback (saved):${NC}"
    echo "────────────────────────────────────────"
    echo "$FEEDBACK"
    echo "────────────────────────────────────────"
    echo ""
  fi

  # ── Claude revision ───────────────────────────────────────────────────────

  echo -e "${BLUE}--- Round ${round}/${MAX_ROUNDS}: Claude addressing feedback ---${NC}"
  echo ""

  # Resume the Claude session so it retains full context of previous rounds.
  set +e
  run_claude \
    -p "Resume the plan agent from your conversation history and pass it this task:

'Revise the plan at ${PLAN_FILE_ABS} based on feedback at ${FEEDBACK_FILE}. Verify each finding against the codebase before acting on it. Do not dismiss a finding solely because it looks broader than the request or involves refactoring -- distinguish between required work, justified enabling refactor, and true optional scope creep. Reject only findings that do not hold up or are genuinely optional beyond the minimum needed to deliver the request safely. Write the updated plan back to ${PLAN_FILE_ABS}.'

Do not spawn a new plan agent -- resume the existing session." \
    -r "$SESSION_ID" \
    --permission-mode acceptEdits \
    --allowed-tools "Read,Write,Glob,Grep,Agent(code:plan-agent)"
  RESUME_EXIT=$?
  set -e

  # If resume failed, fall back to a fresh session -- same structure, no prior context
  if [[ $RESUME_EXIT -ne 0 ]]; then
    if grep -qi "session\|not found\|invalid\|resume" "$CLAUDE_STDERR" 2>/dev/null; then
      echo -e "${YELLOW}Session resume failed, falling back to fresh session${NC}"
      set +e
      run_claude \
        -p "Use the Agent tool to invoke the code:plan-agent with the following task:

'Revise the plan at ${PLAN_FILE_ABS} based on feedback at ${FEEDBACK_FILE}. Verify each finding against the codebase before acting on it. Do not dismiss a finding solely because it looks broader than the request or involves refactoring -- distinguish between required work, justified enabling refactor, and true optional scope creep. Reject only findings that do not hold up or are genuinely optional beyond the minimum needed to deliver the request safely. Write the updated plan back to ${PLAN_FILE_ABS}.

The original request was: ${PROMPT}'" \
        --permission-mode acceptEdits \
        --allowed-tools "Read,Write,Glob,Grep,Agent(code:plan-agent)"
      FALLBACK_EXIT=$?
      set -e

      if [[ $FALLBACK_EXIT -ne 0 ]]; then
        echo -e "${RED}Error: Claude failed with code $FALLBACK_EXIT${NC}" >&2
        if [[ -s "$CLAUDE_STDERR" ]]; then
          cat "$CLAUDE_STDERR" >&2
        fi
        exit 1
      fi
    else
      echo -e "${RED}Error: Claude failed with code $RESUME_EXIT${NC}" >&2
      if [[ -s "$CLAUDE_STDERR" ]]; then
        cat "$CLAUDE_STDERR" >&2
      fi
      exit 1
    fi
  fi

  echo ""
  PLAN_SIZE=$(wc -c < "$PLAN_FILE_ABS" | tr -d ' ')
  echo -e "${GREEN}Plan updated (${PLAN_SIZE} bytes)${NC}"
  echo ""

  PHASE=codex_review
  save_state
  round=$((round + 1))
done

# ── Done ─────────────────────────────────────────────────────────────────────

rm -f "$STATE_FILE" "$FEEDBACK_FILE" 2>/dev/null || true

if [[ "$approved" == "true" ]]; then
  echo -e "Plan file: ${GREEN}${PLAN_FILE_ABS}${NC}"
else
  echo -e "Plan file (unapproved): ${YELLOW}${PLAN_FILE_ABS}${NC}"
fi
