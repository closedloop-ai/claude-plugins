#!/usr/bin/env bash
# Tests that pre-tool-use-hook.sh emits a valid "spawn" event to perf.jsonl
# when the tool_name is "Agent".
#
# Validates that when pre-tool-use-hook.sh is invoked with a mock PreToolUse hook
# payload with tool_name "Agent", the resulting perf.jsonl contains a "spawn"
# event with:
#   parent_session_id  -- from session_id in the hook payload
#   parent_agent_id    -- from agent_id in the hook payload
#   planned_subagent_type -- from tool_input.subagent_type in the hook payload
#
# Also verifies that the sentinel file is still written (the hook does both).
#
# Usage:
#   bash plugins/code/hooks/tests/test_spawn_event.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRE_HOOK="$HOOKS_DIR/pre-tool-use-hook.sh"

# ---- Shared helpers ------------------------------------------------------
# pass/fail counters, assert_field_*, setup_temp_env, create_sentinel.
source "$SCRIPT_DIR/test_helpers.sh"

build_mock_agent_input() {
    # Emits a minimal JSON PreToolUse hook payload for an Agent tool call.
    # tool_input.subagent_type is set to the provided subagent_type.
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="$3"
    local subagent_type="$4"
    local agent_id="${5:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg subagent_type "$subagent_type" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Agent",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{subagent_type:$subagent_type}}'
}

# ---- Tests ---------------------------------------------------------------

echo "Running spawn event emission tests for pre-tool-use-hook.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: Agent tool emits a "spawn" event and writes a sentinel file
# ------------------------------------------------------------------
echo "Test 1: Agent tool emits spawn event and writes sentinel file"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-spawn-emit-test"
    subagent_type="code:plan-writer"
    agent_id="agent-spawn-01"
    run_id="run-spawn-abc"
    command="feat"
    iteration=2

    mock_input=$(build_mock_agent_input "$session_id" "$cwd" "$tool_use_id" "$subagent_type" "$agent_id")
    perf_file="$workdir/perf.jsonl"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$PRE_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "pre-tool-use-hook.sh exits 0 for Agent tool"
    else
        fail "pre-tool-use-hook.sh exits 0 for Agent tool" "expected exit 0 but got $actual_exit"
    fi

    # Assert perf.jsonl was created and contains exactly one spawn event line
    if [[ ! -f "$perf_file" ]]; then
        fail "perf.jsonl was created" "perf.jsonl not found at $perf_file"
    else
        pass "perf.jsonl was created"
        line_count=$(wc -l < "$perf_file" | tr -d ' ')
        if [[ "$line_count" -eq 1 ]]; then
            pass "perf.jsonl contains exactly 1 line (spawn event)"
        else
            fail "perf.jsonl contains exactly 1 line (spawn event)" "got $line_count lines"
        fi

        spawn_line=$(sed -n '1p' "$perf_file")

        # Validate spawn event is valid JSON
        if echo "$spawn_line" | jq empty 2>/dev/null; then
            pass "spawn event line is valid JSON"
        else
            fail "spawn event line is valid JSON" "not valid JSON: $spawn_line"
        fi

        # Assert spawn event fields
        assert_field_equals "spawn event" "$spawn_line" "event" "spawn"
        assert_field_equals "spawn event" "$spawn_line" "run_id" "$run_id"
        assert_field_equals "spawn event" "$spawn_line" "command" "$command"
        assert_field_equals "spawn event" "$spawn_line" "iteration" "$iteration"
        assert_field_equals "spawn event" "$spawn_line" "parent_session_id" "$session_id"
        assert_field_equals "spawn event" "$spawn_line" "parent_agent_id" "$agent_id"
        assert_field_equals "spawn event" "$spawn_line" "planned_subagent_type" "$subagent_type"
        assert_field_present "spawn event" "$spawn_line" "started_at"
    fi

    # Assert sentinel file was also written
    if [[ -f "$sentinel_file" ]]; then
        pass "sentinel file written for Agent tool call"

        # Validate sentinel is valid JSON
        sentinel_json=$(cat "$sentinel_file")
        if echo "$sentinel_json" | jq empty 2>/dev/null; then
            pass "sentinel file is valid JSON"
        else
            fail "sentinel file is valid JSON" "not valid JSON: $sentinel_json"
        fi

        assert_field_equals "sentinel" "$sentinel_json" "tool_name" "Agent"
        assert_field_equals "sentinel" "$sentinel_json" "agent_id" "$agent_id"
        assert_field_equals "sentinel" "$sentinel_json" "run_id" "$run_id"
        assert_field_equals "sentinel" "$sentinel_json" "command" "$command"
        assert_field_equals "sentinel" "$sentinel_json" "iteration" "$iteration"
        assert_field_present "sentinel" "$sentinel_json" "started_at"
    else
        fail "sentinel file written for Agent tool call" "sentinel not found at $sentinel_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: parent_session_id and parent_agent_id come from hook payload
# ------------------------------------------------------------------
echo "Test 2: parent_session_id and parent_agent_id are correctly extracted from hook payload"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-spawn-fields-test"
    subagent_type="code:impl-writer"
    agent_id="agent-spawn-parent-02"
    run_id="run-spawn-fields"
    command="fix"
    iteration=1

    mock_input=$(build_mock_agent_input "$session_id" "$cwd" "$tool_use_id" "$subagent_type" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$PRE_HOOK"

    if [[ -f "$perf_file" ]]; then
        spawn_line=$(tail -1 "$perf_file")
        assert_field_equals "parent_session_id from payload" "$spawn_line" "parent_session_id" "$session_id"
        assert_field_equals "parent_agent_id from payload" "$spawn_line" "parent_agent_id" "$agent_id"
    else
        fail "parent_session_id from payload" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: planned_subagent_type is correctly extracted from tool_input.subagent_type
# ------------------------------------------------------------------
echo "Test 3: planned_subagent_type is correctly extracted from tool_input.subagent_type"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-spawn-subagent-test"
    subagent_type="judges:code-review"
    agent_id="agent-spawn-03"
    run_id="run-spawn-subagent"
    command="code-review"
    iteration=0

    mock_input=$(build_mock_agent_input "$session_id" "$cwd" "$tool_use_id" "$subagent_type" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$PRE_HOOK"

    if [[ -f "$perf_file" ]]; then
        spawn_line=$(tail -1 "$perf_file")
        assert_field_equals "planned_subagent_type from tool_input" "$spawn_line" "planned_subagent_type" "$subagent_type"
    else
        fail "planned_subagent_type from tool_input" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: non-Agent tool does NOT emit a spawn event
# ------------------------------------------------------------------
echo "Test 4: non-Agent tool does not emit a spawn event"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-non-agent-test"
    agent_id="agent-spawn-04"
    run_id="run-non-agent"
    command="fix"
    iteration=1

    mock_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{command:"echo hello"}}')

    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$PRE_HOOK"

    if [[ ! -f "$perf_file" ]]; then
        pass "no spawn event emitted for non-Agent tool (perf.jsonl not created)"
    else
        if grep -q '"event":"spawn"' "$perf_file" 2>/dev/null; then
            fail "no spawn event for non-Agent tool" "found spawn event in perf.jsonl"
        else
            pass "no spawn event present for non-Agent tool"
        fi
    fi

    # Sentinel file should still be written
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    if [[ -f "$sentinel_file" ]]; then
        pass "sentinel file written for non-Agent tool call"
    else
        fail "sentinel file written for non-Agent tool call" "sentinel not found at $sentinel_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: spawn event emits unconditionally — no env-var gate
#
# The earlier draft was gated behind CLOSEDLOOP_PERF_V2=1; closedloop-electron
# ships claude-plugins bundled and end users cannot set runtime env vars, so
# the gate was removed. With CLOSEDLOOP_PERF_V2 explicitly unset, the Agent
# tool must still produce a spawn event and a sentinel.
# ------------------------------------------------------------------
echo "Test 5: pre-tool-use-hook.sh emits spawn event with CLOSEDLOOP_PERF_V2 unset"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-no-gate-spawn"
    subagent_type="code:plan-writer"
    agent_id="agent-no-gate"
    run_id="run-no-gate"
    command="test"
    iteration=0

    mock_input=$(build_mock_agent_input "$session_id" "$cwd" "$tool_use_id" "$subagent_type" "$agent_id")
    perf_file="$workdir/perf.jsonl"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"

    actual_exit=0
    echo "$mock_input" | env -u CLOSEDLOOP_PERF_V2 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$PRE_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "pre-tool-use-hook.sh exits 0 with CLOSEDLOOP_PERF_V2 unset"
    else
        fail "pre-tool-use-hook.sh exits 0 with CLOSEDLOOP_PERF_V2 unset" \
             "expected exit 0 but got $actual_exit"
    fi

    if [[ -f "$perf_file" ]] && grep -q '"event":"spawn"' "$perf_file" 2>/dev/null; then
        pass "spawn event emitted with CLOSEDLOOP_PERF_V2 unset (gate removed)"
    else
        fail "spawn event emitted with CLOSEDLOOP_PERF_V2 unset (gate removed)" \
             "no spawn event in perf.jsonl"
    fi

    if [[ -f "$sentinel_file" ]]; then
        pass "sentinel written with CLOSEDLOOP_PERF_V2 unset (gate removed)"
    else
        fail "sentinel written with CLOSEDLOOP_PERF_V2 unset (gate removed)" \
             "sentinel not found at $sentinel_file"
    fi

    rm -rf "$tmpdir"
}

# ---- Summary -------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
