#!/usr/bin/env bash
# Tests that post-tool-use-hook.sh emits a valid "tool" event to perf.jsonl.
#
# Validates that when post-tool-use-hook.sh is invoked with CLOSEDLOOP_PERF_V2=1,
# a pre-created sentinel file, and a mock PostToolUse hook payload, the resulting
# perf.jsonl line contains all required fields for a "tool" event:
#   event, run_id, command, iteration, agent_id, tool_name,
#   started_at, ended_at, duration_s, ok
#
# Usage:
#   bash plugins/code/hooks/tests/test_tool_event.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -euo pipefail

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POST_HOOK="$HOOKS_DIR/post-tool-use-hook.sh"

# ---- Test helpers --------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0

pass() {
    local name="$1"
    echo "  PASS: $name"
    PASS_COUNT=$(( PASS_COUNT + 1 ))
}

fail() {
    local name="$1"
    local reason="$2"
    echo "  FAIL: $name -- $reason"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
}

assert_field_present() {
    # Asserts that a JSON field exists and is non-empty in a given JSON string.
    local test_name="$1"
    local json="$2"
    local field="$3"
    local value
    value=$(echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null || echo "")
    if [[ -n "$value" ]] && [[ "$value" != "null" ]]; then
        pass "$test_name: field '$field' present (value: $value)"
    else
        fail "$test_name: field '$field' missing or null in: $json"
    fi
}

assert_field_equals() {
    # Asserts that a JSON field has a specific expected value.
    local test_name="$1"
    local json="$2"
    local field="$3"
    local expected="$4"
    local actual
    actual=$(echo "$json" | jq -r --arg f "$field" '.[$f] | tostring' 2>/dev/null || echo "")
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name: field '$field' = '$expected'"
    else
        fail "$test_name: field '$field' expected '$expected' but got '$actual'"
    fi
}

# ---- Setup / teardown helpers --------------------------------------------
setup_temp_env() {
    # Creates an isolated temp directory with:
    #   $TMPDIR/cwd/                          -- fake CWD
    #   $TMPDIR/cwd/.closedloop-ai/           -- state dir
    #   $TMPDIR/workdir/                      -- CLOSEDLOOP_WORKDIR
    #   $TMPDIR/workdir/.tool-calls/          -- sentinel dir
    #   Session mapping: $TMPDIR/cwd/.closedloop-ai/session-$SESSION_ID.workdir -> $TMPDIR/workdir
    local tmpdir
    tmpdir=$(mktemp -d)
    local cwd="$tmpdir/cwd"
    local workdir="$tmpdir/workdir"
    local session_id="test-tool-event-$$"
    local state_dir="$cwd/.closedloop-ai"

    mkdir -p "$state_dir"
    mkdir -p "$workdir/.tool-calls"

    # Write session mapping so hooks can discover CLOSEDLOOP_WORKDIR
    echo "$workdir" > "$state_dir/session-$session_id.workdir"

    # Export for callers
    echo "$tmpdir $cwd $workdir $session_id"
}

build_mock_input() {
    # Emits a minimal JSON PostToolUse hook payload to stdout.
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="${3:-toolusetest123}"
    local tool_name="${4:-Bash}"
    local agent_id="${5:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_name "$tool_name" \
        --arg agent_id "$agent_id" \
        --arg tool_use_id "$tool_use_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:$tool_name,agent_id:$agent_id,tool_use_id:$tool_use_id,tool_response:{}}'
}

create_sentinel() {
    # Writes a sentinel JSON file (as pre-tool-use-hook.sh would) to the given path.
    local sentinel_path="$1"
    local started_at="$2"
    local tool_name="$3"
    local agent_id="$4"
    local run_id="$5"
    local command="$6"
    local iteration="$7"
    jq -n -c \
        --arg started_at "$started_at" \
        --arg tool_name "$tool_name" \
        --arg agent_id "$agent_id" \
        --arg run_id "$run_id" \
        --arg command "$command" \
        --argjson iteration "$iteration" \
        '{started_at:$started_at,tool_name:$tool_name,agent_id:$agent_id,run_id:$run_id,command:$command,iteration:$iteration}' \
        > "$sentinel_path"
}

# ---- Tests ---------------------------------------------------------------

echo "Running tool event emission tests for post-tool-use-hook.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: post-tool-use-hook.sh emits a "tool" event with all required fields
# ------------------------------------------------------------------
echo "Test 1: post-tool-use-hook.sh emits tool event with all required fields"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-emit-test"
    tool_name="Bash"
    agent_id="agent-impl-01"
    run_id="run-abc123"
    command="fix"
    iteration=3
    started_at="2024-01-15T10:00:00Z"

    # Create sentinel file (as pre-tool-use-hook.sh would)
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "$started_at" "$tool_name" "$agent_id" "$run_id" "$command" "$iteration"

    mock_input=$(build_mock_input "$session_id" "$cwd" "$tool_use_id" "$tool_name" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$POST_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "post-tool-use-hook.sh exits 0 on success"
    else
        fail "post-tool-use-hook.sh exits 0 on success" "expected exit 0 but got $actual_exit"
    fi

    if [[ ! -f "$perf_file" ]]; then
        fail "perf.jsonl was created" "perf.jsonl not found at $perf_file"
    else
        pass "perf.jsonl was created"
        # Read the last (and only) line
        event_line=$(tail -1 "$perf_file")

        # Validate event is valid JSON
        if echo "$event_line" | jq empty 2>/dev/null; then
            pass "perf.jsonl line is valid JSON"
        else
            fail "perf.jsonl line is valid JSON" "not valid JSON: $event_line"
        fi

        # Assert all required fields are present and correct
        assert_field_equals "tool event" "$event_line" "event" "tool"
        assert_field_equals "tool event" "$event_line" "run_id" "$run_id"
        assert_field_equals "tool event" "$event_line" "command" "$command"
        assert_field_equals "tool event" "$event_line" "iteration" "$iteration"
        assert_field_equals "tool event" "$event_line" "agent_id" "$agent_id"
        assert_field_equals "tool event" "$event_line" "tool_name" "$tool_name"
        assert_field_equals "tool event" "$event_line" "started_at" "$started_at"
        assert_field_present "tool event" "$event_line" "ended_at"
        assert_field_present "tool event" "$event_line" "duration_s"
        # ok should be a boolean (true when no error in tool_response)
        ok_val=$(echo "$event_line" | jq -r '.ok // empty' 2>/dev/null || echo "")
        if [[ "$ok_val" == "true" ]]; then
            pass "tool event: field 'ok' = true"
        else
            fail "tool event: field 'ok' = true" "expected 'true' but got '$ok_val'"
        fi
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: sentinel file is removed after successful emission
# ------------------------------------------------------------------
echo "Test 2: sentinel file is deleted after successful tool event emission"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-sentinel-delete"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Read" "agent-02" "run-xyz" "feat" 1

    mock_input=$(build_mock_input "$session_id" "$cwd" "$tool_use_id" "Read" "agent-02")

    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="run-xyz" \
        CLOSEDLOOP_COMMAND="feat" \
        CLOSEDLOOP_ITERATION=1 \
        bash "$POST_HOOK"

    if [[ ! -f "$sentinel_file" ]]; then
        pass "sentinel file deleted after emission"
    else
        fail "sentinel file deleted after emission" "sentinel still exists: $sentinel_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: ok=false when tool_response contains an error field
# ------------------------------------------------------------------
echo "Test 3: ok=false when tool_response contains error field"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-error-test"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Bash" "agent-03" "run-err" "test" 0

    # Build mock input with an error in tool_response
    error_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:"agent-03",tool_use_id:$tool_use_id,tool_response:{error:"command not found"}}')

    perf_file="$workdir/perf.jsonl"

    echo "$error_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="run-err" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        event_line=$(tail -1 "$perf_file")
        ok_val=$(echo "$event_line" | jq -r '.ok | tostring' 2>/dev/null || echo "")
        if [[ "$ok_val" == "false" ]]; then
            pass "ok=false when tool_response has error field"
        else
            fail "ok=false when tool_response has error field" "expected 'false' but got '$ok_val'"
        fi
    else
        fail "ok=false when tool_response has error field" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: sentinel values override hook input for tool_name and agent_id
# ------------------------------------------------------------------
echo "Test 4: sentinel tool_name and agent_id override hook input values"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-override-test"
    sentinel_tool_name="Write"
    sentinel_agent_id="sentinel-agent"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "$sentinel_tool_name" "$sentinel_agent_id" "run-ov" "feat" 2

    # Hook input has different tool_name and agent_id — sentinel values should win
    override_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:"hook-agent",tool_use_id:$tool_use_id,tool_response:{}}')

    perf_file="$workdir/perf.jsonl"

    echo "$override_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="run-ov" \
        CLOSEDLOOP_COMMAND="feat" \
        CLOSEDLOOP_ITERATION=2 \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        event_line=$(tail -1 "$perf_file")
        assert_field_equals "sentinel override" "$event_line" "tool_name" "$sentinel_tool_name"
        assert_field_equals "sentinel override" "$event_line" "agent_id" "$sentinel_agent_id"
    else
        fail "sentinel override" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: no-op when CLOSEDLOOP_PERF_V2 is unset
# ------------------------------------------------------------------
echo "Test 5: post-tool-use-hook.sh no-ops when CLOSEDLOOP_PERF_V2 is unset"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-gate-test"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Bash" "agent-gate" "run-gate" "test" 0

    mock_input=$(build_mock_input "$session_id" "$cwd" "$tool_use_id")
    perf_file="$workdir/perf.jsonl"

    actual_exit=0
    echo "$mock_input" | bash "$POST_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "post-tool-use-hook.sh exits 0 when gate is off"
    else
        fail "post-tool-use-hook.sh exits 0 when gate is off" "expected exit 0 but got $actual_exit"
    fi

    if [[ ! -f "$perf_file" ]]; then
        pass "no perf.jsonl created when gate is off"
    else
        fail "no perf.jsonl created when gate is off" "perf.jsonl was unexpectedly created"
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
