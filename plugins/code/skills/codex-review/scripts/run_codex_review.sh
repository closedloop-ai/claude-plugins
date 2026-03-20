#!/usr/bin/env bash
# run_codex_review.sh - Call Codex to review a plan file and return structured results.
#
# Usage:
#   run_codex_review.sh --plan-file <path> --feedback-file <path> --round <N> \
#                       --codex-model <model> [--session-id <thread_id>]
#
# Stdout tokens (machine-parseable):
#   VERDICT:APPROVED         Plan accepted
#   VERDICT:NEEDS_CHANGES    Revisions requested
#   CODEX_SESSION:<id>       Thread ID for session resume
#   CODEX_FAILED:<reason>    Codex error with no usable output
#   CODEX_EMPTY              Empty response after all attempts
#
# Full feedback text is written to --feedback-file.
# Diagnostics go to stderr only.

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

PLAN_FILE=""
FEEDBACK_FILE=""
ROUND=1
CODEX_MODEL="gpt-5.4"
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan-file)    PLAN_FILE="$2"; shift 2 ;;
    --feedback-file) FEEDBACK_FILE="$2"; shift 2 ;;
    --round)        ROUND="$2"; shift 2 ;;
    --codex-model)  CODEX_MODEL="$2"; shift 2 ;;
    --session-id)   SESSION_ID="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PLAN_FILE" ]] || [[ -z "$FEEDBACK_FILE" ]]; then
  echo "Error: --plan-file and --feedback-file are required" >&2
  exit 1
fi

for cmd in codex python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "CODEX_FAILED:$cmd command not found"
    echo "CODEX_SESSION:none"
    exit 0
  fi
done

# ── Temp directory with cleanup ───────────────────────────────────────────────

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

codex_json="$tmp_dir/codex_output.json"
prompt_file="$tmp_dir/prompt.txt"

# ── Build the review prompt ──────────────────────────────────────────────────

if [[ "$ROUND" -eq 1 ]]; then
  REVIEW_INTRO="Claude has created an implementation plan. Review it and provide feedback."
else
  REVIEW_INTRO="Claude has addressed your previous feedback and updated the plan. Re-review the plan for remaining issues."
fi

cat > "$prompt_file" <<PROMPT_EOF
${REVIEW_INTRO}

Read the plan at: ${PLAN_FILE}

Analyze for:
1. Goal alignment -- does the plan actually accomplish what was requested? Would executing it fully deliver the feature, fix the bug, or achieve the stated objective? Flag if the plan misses the core intent or only partially addresses it.
2. Over-engineering -- is the plan more complex than necessary? Flag unnecessary abstractions, helper utilities, configuration layers, or indirection that a simpler approach would avoid.
3. Scope creep -- does the plan add work that was not requested? Flag "while we're at it" improvements, refactors, or features beyond what the original request requires.
4. Reinventing existing code -- does the plan propose creating something that likely already exists in the codebase? Flag new utilities, helpers, or patterns when existing implementations should be reused instead.
5. Technical soundness and feasibility
6. Missing steps or edge cases not addressed
7. Architectural concerns or flawed assumptions
8. Security or performance risks
9. Test coverage -- does the plan include unit and/or integration tests for the changes? Flag if new logic, endpoints, or behaviors lack corresponding test tasks.
10. Unclear or ambiguous task descriptions

For each issue found, provide:
- The specific problem
- A concrete proposed fix or revised text that Claude can adopt directly

Be direct and specific. Only flag genuine, significant issues. Propose solutions, not just problems.

The LAST line of your response MUST be exactly one of these two lines (nothing after it):
VERDICT: APPROVED
VERDICT: NEEDS_CHANGES
PROMPT_EOF

# ── JSON parsing helpers ─────────────────────────────────────────────────────

# Extract thread_id from thread.started event in JSON stream.
# Prints the thread_id or empty string.
parse_thread_id() {
  python3 -c "
import json, sys
for line in open(sys.argv[1]):
    try:
        e = json.loads(line.strip())
        if e.get('type') == 'thread.started' and e.get('thread_id'):
            print(e['thread_id']); break
    except Exception:
        pass
" "$1" 2>/dev/null || true
}

# Extract agent_message text from item.completed events.
# Writes concatenated text to the specified output file.
parse_feedback_text() {
  local json_file="$1"
  local output_file="$2"
  python3 -c "
import json, sys
lines = []
for line in open(sys.argv[1]):
    try:
        e = json.loads(line.strip())
        if e.get('type') == 'item.completed':
            item = e.get('item', {})
            if item.get('type') == 'agent_message' and item.get('text'):
                lines.append(item['text'])
    except Exception:
        pass
sys.stdout.write('\n'.join(lines))
" "$json_file" > "$output_file" 2>/dev/null
}

# ── Run codex ────────────────────────────────────────────────────────────────

run_codex_cmd() {
  local json_out="$1"; shift
  codex "$@" > "$json_out" 2>/dev/null
}

effective_session_id="$SESSION_ID"
codex_exit=0

base_args=(--full-auto --json -m "$CODEX_MODEL" -c model_reasoning_effort=xhigh)
prompt_content=$(cat "$prompt_file")

# Attempt session resume if we have a prior session ID
if [[ -n "$SESSION_ID" ]]; then
  echo "Attempting Codex session resume..." >&2
  set +e
  run_codex_cmd "$codex_json" exec resume "$SESSION_ID" "$prompt_content" "${base_args[@]}"
  codex_exit=$?
  set -e

  new_session=$(parse_thread_id "$codex_json")
  if [[ -n "$new_session" ]]; then
    effective_session_id="$new_session"
  fi
  # else: preserve the input SESSION_ID

  parse_feedback_text "$codex_json" "$FEEDBACK_FILE"

  if [[ $codex_exit -eq 0 ]] || [[ -s "$FEEDBACK_FILE" ]]; then
    # Resume succeeded -- skip to verdict extraction
    :
  else
    echo "Codex session resume failed, starting fresh session..." >&2
    effective_session_id=""
    rm -f "$codex_json"

    # Fall through to fresh session below
    set +e
    run_codex_cmd "$codex_json" exec "${base_args[@]}" "$prompt_content"
    codex_exit=$?
    set -e

    new_session=$(parse_thread_id "$codex_json")
    if [[ -n "$new_session" ]]; then
      effective_session_id="$new_session"
    fi

    parse_feedback_text "$codex_json" "$FEEDBACK_FILE"
  fi
else
  # No session to resume -- fresh start
  set +e
  run_codex_cmd "$codex_json" exec "${base_args[@]}" "$prompt_content"
  codex_exit=$?
  set -e

  new_session=$(parse_thread_id "$codex_json")
  if [[ -n "$new_session" ]]; then
    effective_session_id="$new_session"
  fi

  parse_feedback_text "$codex_json" "$FEEDBACK_FILE"
fi

# ── Emit structured tokens ───────────────────────────────────────────────────

feedback_content=$(cat "$FEEDBACK_FILE" 2>/dev/null || echo "")

# Handle failures
if [[ $codex_exit -ne 0 ]] && [[ -z "$feedback_content" ]]; then
  echo "CODEX_FAILED:codex exited with code $codex_exit"
  echo "CODEX_SESSION:${effective_session_id:-none}"
  exit 0
fi

# Handle empty response
if [[ -z "$feedback_content" ]]; then
  echo "CODEX_EMPTY"
  echo "CODEX_SESSION:${effective_session_id:-none}"
  exit 0
fi

# Extract verdict from feedback text
if echo "$feedback_content" | grep -q "VERDICT: APPROVED"; then
  echo "VERDICT:APPROVED"
elif echo "$feedback_content" | grep -q "VERDICT: NEEDS_CHANGES"; then
  echo "VERDICT:NEEDS_CHANGES"
else
  # No explicit verdict found -- treat as needs changes
  echo "VERDICT:NEEDS_CHANGES"
fi

# Always emit session token for round-to-round continuity
echo "CODEX_SESSION:${effective_session_id:-none}"
