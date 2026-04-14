#!/usr/bin/env bash
# run_codex_review.sh - Call Codex to review a plan file and return structured results.
#
# Usage:
#   run_codex_review.sh --plan-file <path> --feedback-file <path> --round <N> \
#                       --codex-model <model> [--session-id <thread_id>] \
#                       [--log-id <uuid>]
#
# Stdout tokens (machine-parseable):
#   VERDICT:APPROVED         Plan accepted
#   VERDICT:NEEDS_CHANGES    Revisions requested
#   CODEX_SESSION:<id>       Thread ID for session resume
#   LOG_ID:<uuid>            Log file identifier
#   CODEX_FAILED:<reason>    Codex error with no usable output
#   CODEX_EMPTY              Empty response after all attempts
#
# Full feedback text is written to --feedback-file.
# Raw codex JSON stream is appended to ~/.closedloop-ai/plan-with-codex/<log-id>.jsonl
# Diagnostics go to stderr only.

set -euo pipefail

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

# ── Argument parsing ──────────────────────────────────────────────────────────

PLAN_FILE=""
FEEDBACK_FILE=""
REVISIONS_FILE=""
ROUND=1
CODEX_MODEL="gpt-5.3-codex"
SESSION_ID=""
LOG_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan-file)      PLAN_FILE="$2"; shift 2 ;;
    --feedback-file)  FEEDBACK_FILE="$2"; shift 2 ;;
    --revisions-file) REVISIONS_FILE="$2"; shift 2 ;;
    --round)          ROUND="$2"; shift 2 ;;
    --codex-model)    CODEX_MODEL="$2"; shift 2 ;;
    --session-id)     SESSION_ID="$2"; shift 2 ;;
    --log-id)         LOG_ID="$2"; shift 2 ;;
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

# ── Dependency checks ─────────────────────────────────────────────────────────

for cmd in codex python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "CODEX_FAILED:$cmd command not found"
    echo "CODEX_SESSION:none"
    echo "LOG_ID:none"
    exit 0
  fi
done

# ── Log file setup ────────────────────────────────────────────────────────────

if [[ -z "$LOG_ID" ]]; then
  LOG_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
fi

LOG_DIR="$HOME/$CLOSEDLOOP_STATE_DIR/plan-with-codex"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$LOG_ID.jsonl"

# ── Temp directory with cleanup ───────────────────────────────────────────────

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

codex_json="$tmp_dir/codex_output.json"
prompt_file="$tmp_dir/prompt.txt"

# ── Build the review prompt ──────────────────────────────────────────────────

REVISIONS_BLOCK=""
SEVERITY_GATE=""
if [[ "$ROUND" -eq 1 ]]; then
  REVIEW_INTRO="Claude has created an implementation plan. Review it and provide feedback."
elif [[ "$ROUND" -le 4 ]]; then
  REVIEW_INTRO="Claude has addressed your previous feedback and updated the plan. Re-review the plan for remaining issues."
  if [[ -n "$REVISIONS_FILE" ]] && [[ -s "$REVISIONS_FILE" ]]; then
    REVISIONS_BLOCK="

Claude's revision summary (including any findings that were rejected with evidence) is at: ${REVISIONS_FILE}
Read it before reviewing the plan -- if Claude rejected a finding with valid evidence, do not re-raise it."
  fi
else
  # Round 5+: raise the bar -- only flag things that would cause wrong behavior
  REVIEW_INTRO="Claude has addressed your previous feedback and updated the plan. This is round ${ROUND}. Re-review for any remaining critical issues."
  if [[ -n "$REVISIONS_FILE" ]] && [[ -s "$REVISIONS_FILE" ]]; then
    REVISIONS_BLOCK="

Claude's revision summary (including any findings that were rejected with evidence) is at: ${REVISIONS_FILE}
Read it before reviewing the plan -- if Claude rejected a finding with valid evidence, do not re-raise it."
  fi
  SEVERITY_GATE="
IMPORTANT -- Severity threshold for round ${ROUND}:
At this stage of the debate, only flag findings where a competent engineer following the plan would produce functionally wrong behavior -- incorrect output, data loss, crashes, security holes, or silently broken features. Do NOT flag:
- Wording ambiguities that a reasonable implementer would resolve correctly
- Missing prose for behavior that is already obvious from context
- Hypothetical misimplementations that require actively misreading the plan
- Test coverage gaps for edge cases that are unlikely in practice
- Style or naming suggestions

If you find no issues meeting this bar, respond with VERDICT: APPROVED."
fi

cat > "$prompt_file" <<PROMPT_EOF
${REVIEW_INTRO}
${REVISIONS_BLOCK}

Read the plan at: ${PLAN_FILE}

Review for implementability, not just conceptual correctness. Ask: if a different engineer executed this plan literally, could they still produce behavior that contradicts the plan's intent while believing they followed it? If yes, flag the plan as underspecified and propose exact wording that removes the ambiguity.

Before raising or dismissing any finding, verify the plan's claims against the current codebase by reading the referenced files and searching for adjacent callsites or related logic. Do not rely on plan text alone.

For large or multi-area plans, use subagents in parallel to audit separate file clusters or subsystems, then synthesize their results into a single review.

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
10. Unclear, ambiguous, or easy-to-misimplement task descriptions -- flag tasks that are technically correct in intent but leave room for materially wrong implementations. Focus on missing algorithms, missing ordering constraints, unspecified overwrite behavior, unspecified canonical-write targets, and vague "apply this pattern everywhere" instructions.
11. Canonical state and invariant preservation -- for any plan that migrates, renames, caches, mirrors, or falls back between multiple representations/locations, verify that it explicitly defines: the canonical source of truth after the change; read behavior when old and new state both exist; write behavior when old and new state both exist; whether legacy state must be migrated, ignored, or cleaned up. Flag plans that permit split-brain state, continued mutation of legacy state, or mixed-state behavior that never converges.
12. Task specificity and omission resistance -- check whether each task is concrete enough that an implementer cannot accidentally skip part of it. Flag tasks that rely on shorthand like "apply the same pattern," "update all handlers," or "mirror the above change" without naming exact functions, branches, side effects, and cleanup paths. Prefer plans that enumerate the concrete callsites or require a verification sweep proving none were missed.
13. Behavioral precision and algorithmic ambiguity -- check whether key behavioral words are operationalized into exact steps. Flag terms like "merge," "prefer," "preserve," "reuse," "best effort," "safe," "destination-precedence," "fallback," or "migrate" when the plan does not specify the exact algorithm, overwrite semantics, and non-goals. If two reasonable engineers could implement the sentence in opposite ways, the task is too ambiguous.
14. Order-of-operations and sequencing constraints -- check whether the plan specifies the required order between validation, reads, migration, locking, PID checks, writes, cleanup, and response generation. Flag tasks where doing the right steps in the wrong order would change behavior, create races, or violate invariants. Require explicit sequencing whenever earlier steps affect what later steps are allowed to read or write.
15. Lifecycle symmetry and cleanup completeness -- for every create/read/write/start path in the plan, verify the corresponding stop/delete/reset/cleanup path is also updated. Flag one-sided migrations where the plan updates creation or reads but not teardown, cancellation, cleanup, backfill, or legacy-path removal. This includes "clear both locations," "stop both process types," and "remove stale artifacts from all relevant stores."
16. Test fidelity to real execution paths -- evaluate not just whether tests exist, but whether they exercise the real behavior boundary that enforces the contract. Flag test tasks that: reimplement production logic inside mocks; only test helpers when the risk lives in route/handler orchestration; mock away ordering, filesystem, or state-transition behavior that is the actual source of risk; do not cover mixed-state, partial-migration, or contradiction scenarios. Require the plan to specify the test level where needed: unit, integration, route/handler, or end-to-end.

Format each finding as:

### Finding N: [short title]

**Problem:** What is wrong and where (reference specific plan sections or code files).

**Fix:** A concrete proposed fix or revised text that Claude can adopt directly.

---

Be direct and specific. Only flag genuine, significant issues. Propose solutions, not just problems.
${SEVERITY_GATE}

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
  # Log round header
  printf '\n--- Round %s | %s ---\n' "$ROUND" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"
  # Tee raw JSON stream to both the capture file and the persistent log
  codex "$@" 2>/dev/null | tee -a "$LOG_FILE" > "$json_out"
}

effective_session_id="$SESSION_ID"
codex_exit=0

base_args=(--full-auto --json -m "$CODEX_MODEL" -c model_reasoning_effort=high)
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
  echo "LOG_ID:$LOG_ID"
  exit 0
fi

# Handle empty response
if [[ -z "$feedback_content" ]]; then
  echo "CODEX_EMPTY"
  echo "CODEX_SESSION:${effective_session_id:-none}"
  echo "LOG_ID:$LOG_ID"
  exit 0
fi

# Extract verdict from feedback text
if echo "$feedback_content" | grep -q "VERDICT: APPROVED"; then
  echo "VERDICT:APPROVED"
elif echo "$feedback_content" | grep -q "VERDICT: NEEDS_CHANGES"; then
  echo "VERDICT:NEEDS_CHANGES"
elif echo "$feedback_content" | grep -q "^### Finding"; then
  # Has findings but no explicit verdict -- treat as needs changes
  echo "VERDICT:NEEDS_CHANGES"
else
  # No verdict AND no findings -- likely truncated response, not a real review
  echo "CODEX_EMPTY"
fi

# Always emit session token and log ID for round-to-round continuity
echo "CODEX_SESSION:${effective_session_id:-none}"
echo "LOG_ID:$LOG_ID"
