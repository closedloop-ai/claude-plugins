#!/usr/bin/env bash
# Tests that post-tool-use-hook.sh emits a valid "skill" event to perf.jsonl
# when the tool_name is "Skill".
#
# Validates that when post-tool-use-hook.sh is invoked with CLOSEDLOOP_PERF_V2=1,
# a pre-created sentinel file, and a mock PostToolUse hook payload with tool_name
# "Skill", the resulting perf.jsonl contains both a "tool" event and a "skill" event
# with the correct skill_name field extracted from tool_input.skill (or falling back
# to tool_input.command when tool_input.skill is absent).
#
# Usage:
#   bash plugins/code/hooks/tests/test_skill_event.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POST_HOOK="$HOOKS_DIR/post-tool-use-hook.sh"

# ---- Shared helpers ------------------------------------------------------
# pass/fail counters, assert_field_*, setup_temp_env, create_sentinel.
source "$SCRIPT_DIR/test_helpers.sh"

build_mock_skill_input() {
    # Emits a minimal JSON PostToolUse hook payload for a Skill tool call.
    # tool_input.skill is set to the provided skill_name.
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="$3"
    local skill_name="$4"
    local agent_id="${5:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg skill_name "$skill_name" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Skill",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{skill:$skill_name},tool_response:{}}'
}

build_mock_skill_input_command_fallback() {
    # Emits a PostToolUse payload for a Skill tool call where tool_input.skill
    # is absent but tool_input.command is set (tests the fallback path).
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="$3"
    local command_name="$4"
    local agent_id="${5:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg command_name "$command_name" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Skill",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{command:$command_name},tool_response:{}}'
}

build_mock_skill_input_both() {
    # Emits a PostToolUse payload where BOTH tool_input.skill and tool_input.command
    # are set — tests that `skill` wins (the documented priority).
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="$3"
    local skill_name="$4"
    local command_name="$5"
    local agent_id="${6:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg skill_name "$skill_name" \
        --arg command_name "$command_name" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Skill",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{skill:$skill_name,command:$command_name},tool_response:{}}'
}

build_mock_skill_input_neither() {
    # Emits a PostToolUse payload where neither tool_input.skill nor tool_input.command
    # is set — tests that skill_name is empty (no crash, just empty extraction).
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="$3"
    local agent_id="${4:-agent-test}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Skill",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{},tool_response:{}}'
}

# ---- Tests ---------------------------------------------------------------

echo "Running skill event emission tests for post-tool-use-hook.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: Skill tool emits both a "tool" event and a "skill" event
# ------------------------------------------------------------------
echo "Test 1: Skill tool emits both tool event and skill event"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-skill-emit-test"
    skill_name="code:plan-validate"
    agent_id="agent-skill-01"
    run_id="run-skill-abc"
    command="fix"
    iteration=2
    started_at="2024-01-15T10:00:00Z"

    # Create sentinel file (as pre-tool-use-hook.sh would)
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "$started_at" "Skill" "$agent_id" "$run_id" "$command" "$iteration"

    mock_input=$(build_mock_skill_input "$session_id" "$cwd" "$tool_use_id" "$skill_name" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$POST_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "post-tool-use-hook.sh exits 0 for Skill tool"
    else
        fail "post-tool-use-hook.sh exits 0 for Skill tool" "expected exit 0 but got $actual_exit"
    fi

    if [[ ! -f "$perf_file" ]]; then
        fail "perf.jsonl was created" "perf.jsonl not found at $perf_file"
    else
        pass "perf.jsonl was created"
        line_count=$(wc -l < "$perf_file" | tr -d ' ')
        if [[ "$line_count" -eq 2 ]]; then
            pass "perf.jsonl contains exactly 2 lines (tool + skill events)"
        else
            fail "perf.jsonl contains exactly 2 lines (tool + skill events)" "got $line_count lines"
        fi

        tool_line=$(sed -n '1p' "$perf_file")
        skill_line=$(sed -n '2p' "$perf_file")

        # Validate both lines are valid JSON
        if echo "$tool_line" | jq empty 2>/dev/null; then
            pass "tool event line is valid JSON"
        else
            fail "tool event line is valid JSON" "not valid JSON: $tool_line"
        fi

        if echo "$skill_line" | jq empty 2>/dev/null; then
            pass "skill event line is valid JSON"
        else
            fail "skill event line is valid JSON" "not valid JSON: $skill_line"
        fi

        # Assert tool event fields
        assert_field_equals "tool event" "$tool_line" "event" "tool"
        assert_field_equals "tool event" "$tool_line" "tool_name" "Skill"

        # Assert skill event fields
        assert_field_equals "skill event" "$skill_line" "event" "skill"
        assert_field_equals "skill event" "$skill_line" "run_id" "$run_id"
        assert_field_equals "skill event" "$skill_line" "command" "$command"
        assert_field_equals "skill event" "$skill_line" "iteration" "$iteration"
        assert_field_equals "skill event" "$skill_line" "agent_id" "$agent_id"
        assert_field_equals "skill event" "$skill_line" "tool_name" "Skill"
        assert_field_equals "skill event" "$skill_line" "skill_name" "$skill_name"
        assert_field_equals "skill event" "$skill_line" "started_at" "$started_at"
        assert_field_present "skill event" "$skill_line" "ended_at"
        assert_field_present "skill event" "$skill_line" "duration_s"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: skill_name extracted from tool_input.skill
# ------------------------------------------------------------------
echo "Test 2: skill_name is correctly extracted from tool_input.skill"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-skill-field-test"
    skill_name="code:plan-validate"
    agent_id="agent-skill-02"
    run_id="run-skill-field"
    command="feat"
    iteration=1

    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Skill" "$agent_id" "$run_id" "$command" "$iteration"

    mock_input=$(build_mock_skill_input "$session_id" "$cwd" "$tool_use_id" "$skill_name" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        skill_line=$(tail -1 "$perf_file")
        assert_field_equals "skill_name from tool_input.skill" "$skill_line" "skill_name" "$skill_name"
    else
        fail "skill_name from tool_input.skill" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: skill_name falls back to tool_input.command when tool_input.skill is absent
# ------------------------------------------------------------------
echo "Test 3: skill_name falls back to tool_input.command when tool_input.skill is absent"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-skill-fallback-test"
    command_name="self-learning:pattern-extract"
    agent_id="agent-skill-03"
    run_id="run-skill-fallback"
    command="test"
    iteration=0

    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Skill" "$agent_id" "$run_id" "$command" "$iteration"

    # Use the command fallback payload (no tool_input.skill field)
    mock_input=$(build_mock_skill_input_command_fallback "$session_id" "$cwd" "$tool_use_id" "$command_name" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        skill_line=$(tail -1 "$perf_file")
        assert_field_equals "skill event" "$skill_line" "event" "skill"
        assert_field_equals "skill_name fallback to tool_input.command" "$skill_line" "skill_name" "$command_name"
    else
        fail "skill_name fallback to tool_input.command" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: non-Skill tool does NOT emit a skill event
# ------------------------------------------------------------------
echo "Test 4: non-Skill tool does not emit a skill event"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-non-skill-test"
    agent_id="agent-skill-04"
    run_id="run-non-skill"
    command="fix"
    iteration=1

    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Bash" "$agent_id" "$run_id" "$command" "$iteration"

    mock_input=$(jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_use_id "$tool_use_id" \
        --arg agent_id "$agent_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:"Bash",agent_id:$agent_id,tool_use_id:$tool_use_id,tool_input:{command:"echo hello"},tool_response:{}}')

    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="$run_id" \
        CLOSEDLOOP_COMMAND="$command" \
        CLOSEDLOOP_ITERATION="$iteration" \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        line_count=$(wc -l < "$perf_file" | tr -d ' ')
        if [[ "$line_count" -eq 1 ]]; then
            pass "only one event emitted for non-Skill tool (no skill event)"
        else
            fail "only one event emitted for non-Skill tool (no skill event)" "got $line_count lines"
        fi

        tool_line=$(tail -1 "$perf_file")
        assert_field_equals "non-Skill tool event" "$tool_line" "event" "tool"

        # Confirm no skill event exists in the file
        if grep -q '"event":"skill"' "$perf_file" 2>/dev/null; then
            fail "no skill event for non-Skill tool" "found skill event in perf.jsonl"
        else
            pass "no skill event present for non-Skill tool"
        fi
    else
        fail "non-Skill tool emits tool event" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: priority — when BOTH tool_input.skill and tool_input.command are
# present, the implementation uses `skill` (documented priority order). Locks
# in the contract so a future refactor can't silently flip the precedence.
# ------------------------------------------------------------------
echo "Test 5: tool_input.skill wins over tool_input.command when both are present"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-skill-priority"
    skill_name="actual-skill"
    command_name="ignored-command"
    agent_id="agent-pri"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Skill" "$agent_id" "run-pri" "feat" 0

    mock_input=$(build_mock_skill_input_both "$session_id" "$cwd" "$tool_use_id" "$skill_name" "$command_name" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="run-pri" \
        CLOSEDLOOP_COMMAND="feat" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK"

    if [[ -f "$perf_file" ]]; then
        skill_line=$(grep '"event":"skill"' "$perf_file" | tail -1)
        if [[ -n "$skill_line" ]]; then
            assert_field_equals "skill > command priority" "$skill_line" "skill_name" "$skill_name"
        else
            fail "skill > command priority" "no skill event emitted"
        fi
    else
        fail "skill > command priority" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: when neither tool_input.skill NOR tool_input.command is present,
# skill_name is emitted as empty string (and the hook does not crash). Tests
# the floor of the fallback chain — defends against undocumented Skill tool
# input shapes.
# ------------------------------------------------------------------
echo "Test 6: skill_name is empty when tool_input has neither skill nor command"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-skill-neither"
    agent_id="agent-neither"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    create_sentinel "$sentinel_file" "2024-01-15T10:00:00Z" "Skill" "$agent_id" "run-n" "feat" 0

    mock_input=$(build_mock_skill_input_neither "$session_id" "$cwd" "$tool_use_id" "$agent_id")
    perf_file="$workdir/perf.jsonl"

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_PERF_V2=1 \
        CLOSEDLOOP_RUN_ID="run-n" \
        CLOSEDLOOP_COMMAND="feat" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "post-hook exits 0 when Skill tool_input is empty"
    else
        fail "post-hook exits 0 when Skill tool_input is empty" "got $actual_exit"
    fi

    if [[ -f "$perf_file" ]]; then
        skill_line=$(grep '"event":"skill"' "$perf_file" | tail -1)
        if [[ -n "$skill_line" ]]; then
            assert_field_equals "neither skill nor command" "$skill_line" "skill_name" ""
        else
            fail "skill event still emitted" "no skill event for empty tool_input"
        fi
    else
        fail "skill event still emitted" "perf.jsonl not created"
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
