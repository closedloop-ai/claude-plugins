#!/usr/bin/env bash
# End-to-end pre→post correlation tests for the perf hooks.
#
# Unlike test_tool_event.sh / test_skill_event.sh / test_spawn_event.sh, which
# pre-create sentinel files and exercise only the post-hook, this file runs the
# pre-hook FIRST, lets it write the real sentinel, then runs the post-hook with
# matching payload — the path that actually fires in production. It also covers
# regression cases for findings on PR #70:
#   - sentinel attribution wins: post-hook must use run_id/command/iteration
#     captured by pre-hook, not whatever's in the env at post time
#   - corrupt-sentinel guard: empty/garbage started_at must NOT emit a tool
#     event with `started_at: ""` and `duration_s: 0`
#   - missing-correlation-id: when both tool_use_id and tool_call_id are absent,
#     pre and post must skip silently (no counter race)
#
# Usage:
#   bash plugins/code/hooks/tests/test_correlation.sh
# Exit code: 0 if all pass, 1 if any fail.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRE_HOOK="$HOOKS_DIR/pre-tool-use-hook.sh"
POST_HOOK="$HOOKS_DIR/post-tool-use-hook.sh"

# ---- Shared helpers ------------------------------------------------------
# pass/fail counters, assert_field_*, setup_temp_env, create_sentinel.
source "$SCRIPT_DIR/test_helpers.sh"

mock_pre_input() {
    # Args: session_id cwd tool_use_id tool_name agent_id [planned_subagent_type]
    jq -n -c \
        --arg session_id "$1" \
        --arg cwd "$2" \
        --arg tool_use_id "$3" \
        --arg tool_name "$4" \
        --arg agent_id "$5" \
        --arg planned_subagent_type "${6:-}" \
        '{session_id:$session_id,cwd:$cwd,tool_use_id:$tool_use_id,tool_name:$tool_name,agent_id:$agent_id,tool_input:{subagent_type:$planned_subagent_type}}'
}

mock_post_input() {
    # Args: session_id cwd tool_use_id tool_name agent_id
    jq -n -c \
        --arg session_id "$1" \
        --arg cwd "$2" \
        --arg tool_use_id "$3" \
        --arg tool_name "$4" \
        --arg agent_id "$5" \
        '{session_id:$session_id,cwd:$cwd,tool_use_id:$tool_use_id,tool_name:$tool_name,agent_id:$agent_id,tool_response:{}}'
}

echo "Running end-to-end pre→post correlation tests"
echo ""

# ----------------------------------------------------------------------------
# Test 1: full pre→post flow produces a tool event whose timing comes from the
# real sentinel that pre-hook wrote (not from a pre-created fixture).
# ----------------------------------------------------------------------------
echo "Test 1: pre-hook writes sentinel, post-hook reads it and emits tool event"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"
    tool_use_id="real-correlation-id-1"

    # Run pre-hook
    mock_pre_input "$session_id" "$cwd" "$tool_use_id" "Read" "agent-real-1" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="run-real-1" \
              CLOSEDLOOP_COMMAND="feat" \
              CLOSEDLOOP_ITERATION=5 \
              bash "$PRE_HOOK"

    if [[ -f "$workdir/.tool-calls/$tool_use_id" ]]; then
        pass "pre-hook wrote sentinel"
    else
        fail "pre-hook wrote sentinel" "no sentinel at $workdir/.tool-calls/$tool_use_id"
    fi

    # Sleep at least one second so duration_s is non-zero (epoch granularity is whole seconds)
    sleep 1

    # Run post-hook with same tool_use_id
    mock_post_input "$session_id" "$cwd" "$tool_use_id" "Read" "agent-real-1" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="run-real-1" \
              CLOSEDLOOP_COMMAND="feat" \
              CLOSEDLOOP_ITERATION=5 \
              bash "$POST_HOOK"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(grep '"event":"tool"' "$perf_file" | tail -1)
        assert_field_equals "e2e tool event" "$line" "event" "tool"
        assert_field_equals "e2e tool event" "$line" "tool_name" "Read"
        assert_field_equals "e2e tool event" "$line" "run_id" "run-real-1"
        assert_field_equals "e2e tool event" "$line" "command" "feat"
        assert_field_equals "e2e tool event" "$line" "iteration" "5"
        # duration_s should be >= 1 because we slept 1s between pre and post
        duration=$(echo "$line" | jq -r '.duration_s' 2>/dev/null || echo "0")
        if (( duration >= 1 )); then
            pass "e2e tool event: duration_s >= 1 (got $duration)"
        else
            fail "e2e tool event: duration_s >= 1" "got $duration"
        fi
    else
        fail "post-hook emitted tool event" "no perf.jsonl created"
    fi

    if [[ ! -f "$workdir/.tool-calls/$tool_use_id" ]]; then
        pass "post-hook deleted sentinel after emission"
    else
        fail "post-hook deleted sentinel after emission" "sentinel still exists"
    fi

    rm -rf "$tmpdir"
}

# ----------------------------------------------------------------------------
# Test 2: post-hook prefers SENTINEL run_id/command/iteration over env vars.
# Regression for the "post-hook must use sentinel attribution, not env" finding.
# ----------------------------------------------------------------------------
echo "Test 2: sentinel attribution wins over post-time env vars"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"
    tool_use_id="sentinel-attr-id"

    # Pre-hook with a particular env
    mock_pre_input "$session_id" "$cwd" "$tool_use_id" "Bash" "agent-attr" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="ORIGINAL_RUN" \
              CLOSEDLOOP_COMMAND="ORIGINAL_CMD" \
              CLOSEDLOOP_ITERATION=7 \
              bash "$PRE_HOOK"

    # Post-hook with a DIFFERENT env (simulating mid-call iteration advance, etc.)
    mock_post_input "$session_id" "$cwd" "$tool_use_id" "Bash" "agent-attr" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="DRIFTED_RUN" \
              CLOSEDLOOP_COMMAND="DRIFTED_CMD" \
              CLOSEDLOOP_ITERATION=99 \
              bash "$POST_HOOK"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(grep '"event":"tool"' "$perf_file" | tail -1)
        # All three attribution fields must come from the sentinel (pre-hook env),
        # NOT the post-hook env that "drifted".
        assert_field_equals "sentinel-wins" "$line" "run_id" "ORIGINAL_RUN"
        assert_field_equals "sentinel-wins" "$line" "command" "ORIGINAL_CMD"
        assert_field_equals "sentinel-wins" "$line" "iteration" "7"
    else
        fail "sentinel-wins" "no perf.jsonl created"
    fi

    rm -rf "$tmpdir"
}

# ----------------------------------------------------------------------------
# Test 3: corrupt sentinel must NOT emit a tool event. Without the guard,
# post-hook would emit started_at:"" with duration_s:0 — silently polluting
# downstream Datadog records with a row that looks valid but carries no timing.
# ----------------------------------------------------------------------------
echo "Test 3: corrupt sentinel does not emit a tool event"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"
    tool_use_id="corrupt-sentinel-id"

    # Write garbage to the sentinel file directly (skip the pre-hook)
    echo "this is not valid json {[}" > "$workdir/.tool-calls/$tool_use_id"

    mock_post_input "$session_id" "$cwd" "$tool_use_id" "Bash" "agent-corrupt" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="run-corrupt" \
              CLOSEDLOOP_COMMAND="test" \
              CLOSEDLOOP_ITERATION=0 \
              bash "$POST_HOOK"

    perf_file="$workdir/perf.jsonl"
    if [[ ! -f "$perf_file" ]]; then
        pass "corrupt sentinel: no perf.jsonl created (event suppressed)"
    else
        if grep -q '"event":"tool"' "$perf_file"; then
            fail "corrupt sentinel: no tool event" "tool event was emitted: $(cat "$perf_file")"
        else
            pass "corrupt sentinel: perf.jsonl exists but no tool event"
        fi
    fi

    if [[ ! -f "$workdir/.tool-calls/$tool_use_id" ]]; then
        pass "corrupt sentinel: corrupt sentinel removed"
    else
        fail "corrupt sentinel: corrupt sentinel removed" "still present"
    fi

    rm -rf "$tmpdir"
}

# ----------------------------------------------------------------------------
# Test 4: when both tool_use_id and tool_call_id are absent, both hooks must
# skip silently (no counter race, no orphaned sentinels). Regression guard for
# the BLOCKING counter-fallback findings.
# ----------------------------------------------------------------------------
echo "Test 4: missing correlation id skips silently in both hooks"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"

    pre_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:"a",tool_input:{}}')
    post_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:"a",tool_response:{}}')

    pre_exit=0
    echo "$pre_input" | env CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="r" CLOSEDLOOP_COMMAND="c" CLOSEDLOOP_ITERATION=0 \
        bash "$PRE_HOOK" || pre_exit=$?

    post_exit=0
    echo "$post_input" | env CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="r" CLOSEDLOOP_COMMAND="c" CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" || post_exit=$?

    [[ "$pre_exit" -eq 0 ]] && pass "pre-hook exits 0 when no correlation id" \
        || fail "pre-hook exits 0 when no correlation id" "exit $pre_exit"
    [[ "$post_exit" -eq 0 ]] && pass "post-hook exits 0 when no correlation id" \
        || fail "post-hook exits 0 when no correlation id" "exit $post_exit"

    # No sentinels should have been created (no counter file either)
    sentinel_count=$(find "$workdir/.tool-calls" -type f 2>/dev/null | wc -l | tr -d ' ')
    [[ "$sentinel_count" == "0" ]] && pass "no sentinels created (no counter race)" \
        || fail "no sentinels created" "$sentinel_count files in .tool-calls/"

    if [[ ! -f "$cwd/.closedloop-ai/.tool-call-counter" ]]; then
        pass "no .tool-call-counter file written"
    else
        fail "no .tool-call-counter file written" "counter file exists — race-prone fallback still in place"
    fi

    rm -rf "$tmpdir"
}

# ----------------------------------------------------------------------------
# Test 5: non-numeric CLOSEDLOOP_ITERATION does not abort either hook. Regression
# for the --argjson finding — `--argjson iteration "abc"` would fail and silently
# kill the hook via `trap exit 0 ERR`.
# ----------------------------------------------------------------------------
echo "Test 5: non-numeric CLOSEDLOOP_ITERATION is normalized to 0"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"
    tool_use_id="non-numeric-iter-id"

    mock_pre_input "$session_id" "$cwd" "$tool_use_id" "Read" "agent-iter" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="r" \
              CLOSEDLOOP_COMMAND="c" \
              CLOSEDLOOP_ITERATION="abc-not-a-number" \
              bash "$PRE_HOOK"

    if [[ -f "$workdir/.tool-calls/$tool_use_id" ]]; then
        pass "pre-hook handled non-numeric iteration (sentinel written)"
        # iteration in sentinel should be the numeric default 0
        sentinel_iter=$(jq -r '.iteration | tostring' "$workdir/.tool-calls/$tool_use_id")
        [[ "$sentinel_iter" == "0" ]] && pass "sentinel iteration normalized to 0" \
            || fail "sentinel iteration normalized to 0" "got $sentinel_iter"
    else
        fail "pre-hook handled non-numeric iteration" "no sentinel written"
    fi

    mock_post_input "$session_id" "$cwd" "$tool_use_id" "Read" "agent-iter" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="r" \
              CLOSEDLOOP_COMMAND="c" \
              CLOSEDLOOP_ITERATION="zzz" \
              bash "$POST_HOOK"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && grep -q '"event":"tool"' "$perf_file"; then
        line=$(grep '"event":"tool"' "$perf_file" | tail -1)
        assert_field_equals "non-numeric iter" "$line" "iteration" "0"
    else
        fail "post-hook handled non-numeric iteration" "no tool event emitted"
    fi

    rm -rf "$tmpdir"
}

# ----------------------------------------------------------------------------
# Test 6: post-hook independently normalizes non-numeric env iteration when
# the sentinel does not carry an iteration field. Test 5 above exercises the
# pre-hook normalization (and the post-hook reads sentinel.iteration which is
# already 0), so the post-hook's own `^[0-9]+$` guard would be dead code if
# only Test 5 ran. This test forces the env-fallback path by writing a sentinel
# WITHOUT an iteration field — simulating an older sentinel format or a sentinel
# written by a future variant.
# ----------------------------------------------------------------------------
echo "Test 6: post-hook normalizes non-numeric env iteration when sentinel lacks the field"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "correlation")"
    tool_use_id="post-norm-id"
    sentinel_path="$workdir/.tool-calls/$tool_use_id"

    # Hand-craft a sentinel WITHOUT iteration — forces post-hook to fall back to
    # CLOSEDLOOP_ITERATION env var, where we'll inject a non-numeric value.
    jq -n -c \
        --arg started_at "2024-01-15T10:00:00Z" \
        --arg tool_name "Bash" \
        --arg agent_id "agent-x" \
        --arg run_id "run-x" \
        --arg command "feat" \
        '{started_at:$started_at,tool_name:$tool_name,agent_id:$agent_id,run_id:$run_id,command:$command}' \
        > "$sentinel_path"

    mock_post_input "$session_id" "$cwd" "$tool_use_id" "Bash" "agent-x" \
        | env CLOSEDLOOP_PERF_V2=1 \
              CLOSEDLOOP_RUN_ID="r" \
              CLOSEDLOOP_COMMAND="c" \
              CLOSEDLOOP_ITERATION="garbage" \
              bash "$POST_HOOK"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && grep -q '"event":"tool"' "$perf_file"; then
        line=$(grep '"event":"tool"' "$perf_file" | tail -1)
        assert_field_equals "post-hook env-fallback iter" "$line" "iteration" "0"
    else
        fail "post-hook env-fallback normalization" "no tool event emitted"
    fi

    rm -rf "$tmpdir"
}

echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
