#!/usr/bin/env bash
# run_codex_review.sh - Call Codex to review a plan file and return structured results.
#
# Usage:
#   run_codex_review.sh --plan-file <path> --feedback-file <path> \
#                       [--request-file <path>] --round <N> \
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
REQUEST_FILE=""
REVISIONS_FILE=""
ROUND=1
CODEX_MODEL="gpt-5.3-codex"
SESSION_ID=""
LOG_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan-file)      PLAN_FILE="$2"; shift 2 ;;
    --feedback-file)  FEEDBACK_FILE="$2"; shift 2 ;;
    --request-file)   REQUEST_FILE="$2"; shift 2 ;;
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

REQUEST_BLOCK=""
REVISIONS_BLOCK=""
ROUND_GUIDANCE=""
REVIEW_AREAS=""
if [[ -n "$REQUEST_FILE" ]] && [[ -s "$REQUEST_FILE" ]]; then
  REQUEST_BLOCK="

Original user request is at: ${REQUEST_FILE}
Read it before reviewing the plan. Judge the plan against that request, not just against the plan's own framing. If the request file begins with [synthesized], treat it as a weak hint rather than authoritative user intent."
fi

if [[ "$ROUND" -eq 1 ]]; then
  REVIEW_INTRO="Claude has created an implementation plan. This is the first review pass."
  ROUND_GUIDANCE="
Do a broad but material review. Flag issues only if they would likely cause wrong behavior, miss the stated objective, choose the wrong implementation approach, leave important implementation gaps, or add clearly unnecessary complexity or scope. Do not nitpick style, naming, or minor wording improvements."
  REVIEW_AREAS="
Analyze for:
1. Goal alignment against the original request when available, otherwise against the plan's stated context, title, and explicit objectives. If the original request is not stated clearly in the plan, do not invent extra requirements.
2. Approach choice and pragmatism -- is the plan solving the problem in the right layer, with the right abstraction, and with a materially simpler or more local approach where appropriate? Flag plans whose overall approach is wrong, heavier than necessary, or less pragmatic than an obvious simpler alternative.
3. Over-engineering that materially increases complexity without clear benefit.
4. Scope creep that adds work beyond the stated objective. Do not treat a localized enabling refactor as scope creep if it is needed to implement the request safely, clearly, or without making an already bloated file worse.
5. Reinventing existing code when the plan should reuse an existing implementation or pattern.
6. Technical soundness and feasibility.
7. Missing steps, missing callsites, or edge cases that would likely matter in real execution.
8. Security or performance risks that are concrete and relevant.
9. Test coverage and test fidelity for the real behavior boundary being changed.
10. Unclear, ambiguous, or easy-to-misimplement task descriptions.
11. Canonical state and invariant preservation.
12. Task specificity and omission resistance.
13. Behavioral precision and algorithmic ambiguity.
14. Order-of-operations and sequencing constraints.
15. Lifecycle symmetry and cleanup completeness.
16. File-shape pragmatism -- if the touched file is already bloated, fragile, or overly coupled, check whether the plan's approach makes that worse. A small restructuring or extraction can be warranted when it is the most practical way to implement the requested change safely and keep the result maintainable."
elif [[ "$ROUND" -le 4 ]]; then
  REVIEW_INTRO="Claude has addressed your previous feedback and updated the plan. This is round ${ROUND}."
  if [[ -n "$REVISIONS_FILE" ]] && [[ -s "$REVISIONS_FILE" ]]; then
    REVISIONS_BLOCK="

Claude's revision summary (including any findings that were rejected with evidence) is at: ${REVISIONS_FILE}
Read it before reviewing the plan, but treat it as a claim to verify against the updated plan and the current codebase. Do not automatically trust or reject it."
  fi
  ROUND_GUIDANCE="
This is a delta review, not a fresh blank-slate audit.
1. First check whether prior findings are actually resolved in the updated plan.
2. Verify Claude's rebuttals and claimed fixes against the updated plan and the codebase before accepting them.
3. Only raise net-new findings if they are clearly material, high-confidence, and not just rephrasings of earlier points.
4. Do not churn on explicit design choices already spelled out in the plan unless they remain incorrect, incomplete, or dangerous.
5. Do not accept an 'out of scope' rebuttal unless the work is truly optional. Required work and localized enabling refactors are in scope if they are the most pragmatic way to deliver the request safely."
  REVIEW_AREAS="
Analyze for:
1. Previously raised issues that are still unresolved or only partially fixed.
2. Remaining goal-alignment gaps that would cause the plan to miss its stated objective.
3. Material missing steps, missing callsites, or missing cleanup paths.
4. Canonical state, migration, fallback, caching, or invariant problems that could leave the system in the wrong state.
5. Ambiguous algorithms, overwrite semantics, sequencing, or lifecycle rules where two reasonable engineers could implement opposite behaviors.
6. Test gaps only when they would allow a real behavioral regression or incorrect implementation to ship unnoticed.
7. Over-engineering, wrong-layer approach, or scope creep only if it is substantial enough to distort delivery or conflict with the stated plan.
8. Cases where Claude dismissed a necessary or strongly justified enabling refactor as out of scope, even though the codebase shape makes the narrower plan materially less pragmatic or more error-prone."
else
  REVIEW_INTRO="Claude has addressed your previous feedback and updated the plan. This is round ${ROUND}."
  if [[ -n "$REVISIONS_FILE" ]] && [[ -s "$REVISIONS_FILE" ]]; then
    REVISIONS_BLOCK="

Claude's revision summary (including any findings that were rejected with evidence) is at: ${REVISIONS_FILE}
Read it before reviewing the plan, but treat it as a claim to verify against the updated plan and the current codebase. Do not automatically trust or reject it."
  fi
  ROUND_GUIDANCE="
This is a blocker-only convergence review.
First check whether any previously raised findings are still unresolved. Only flag issues where a competent engineer following the plan would still likely:
- produce functionally wrong behavior
- violate invariants or create split-brain state
- miss required scope, required callsites, or required cleanup paths
- ship tests that would allow broken behavior to pass unnoticed

Do NOT flag:
- Style, naming, or wording improvements
- Minor ambiguity that a reasonable implementer would resolve correctly
- Hypothetical misimplementations that require actively misreading the plan
- Optional refactors, polish, or generic architecture preferences
- Generic test wishlist items not tied to a concrete correctness risk

If you find no blocker-level issues meeting this bar, respond with VERDICT: APPROVED."
  REVIEW_AREAS="
Analyze only for:
1. Remaining unresolved prior findings that still imply broken behavior.
2. Incorrect or missing algorithms, overwrite semantics, or sequencing that would change behavior.
3. Missing required callsites, migrations, state transitions, teardown paths, or cleanup paths.
4. Canonical-state or invariant violations that could leave mixed or contradictory state.
5. Missing tests only when the absence of those tests would plausibly allow a broken implementation to ship."
fi

cat > "$prompt_file" <<PROMPT_EOF
${REVIEW_INTRO}
${REVISIONS_BLOCK}
${REQUEST_BLOCK}

Read the plan at: ${PLAN_FILE}

Review for implementability, not just conceptual correctness. Ask: if a different engineer executed this plan literally, could they still produce behavior that contradicts the plan's intent while believing they followed it? If yes, flag the plan as underspecified and propose exact wording that removes the ambiguity.

Do not only check whether the plan is internally consistent. Also challenge whether it has chosen the right overall approach for the request. If a materially simpler, more local, or more pragmatic solution would satisfy the request with less risk or complexity, flag that and propose the better direction.

A localized refactor within an already bloated, fragile, or overly coupled file can be warranted when it is the most practical way to implement the requested change safely, clearly, or testably. Do not treat every refactor as scope creep; distinguish required enabling refactors from optional cleanup.

Before raising or dismissing any finding, verify the plan's claims against the current codebase by reading the referenced files and searching for adjacent callsites or related logic. Do not rely on plan text alone.

${ROUND_GUIDANCE}

If the plan spans clearly separable subsystems, you may use subagents in parallel to audit distinct file clusters or subsystems, then synthesize the results into a single review. Otherwise, review directly.

${REVIEW_AREAS}

Format each finding as:

### Finding N: [short title]

**Problem:** What is wrong and where (reference specific plan sections or code files).

**Fix:** A concrete proposed fix or revised text that Claude can adopt directly.

---

Be direct and specific. Only flag genuine, significant issues. Propose solutions, not just problems.
If you find no issues worth flagging for this round, write no findings and end with VERDICT: APPROVED.

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
