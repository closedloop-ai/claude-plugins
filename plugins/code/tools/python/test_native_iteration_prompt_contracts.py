"""Prompt contract checks for terminal native iteration telemetry."""

from __future__ import annotations

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HELPER = "record_native_iteration_once.sh"


def read_plugin_file(relative_path: str) -> str:
    return (PLUGIN_ROOT / relative_path).read_text()


def test_shared_hard_stop_sequence_records_native_iteration_before_promise() -> None:
    text = read_plugin_file("skills/orchestrator-sequences/SKILL.md")
    helper_index = text.index(HELPER)
    promise_index = text.index("Output your command's completion promise")

    assert helper_index < promise_index


def test_single_shot_plan_terminal_paths_use_idempotent_helper() -> None:
    text = read_plugin_file("prompts/plan-prompt.md")

    assert text.count(HELPER) >= 2
    assert "Stop here; I'll continue later." in text
    assert "record_iteration.sh" not in text


def test_execute_terminal_completion_uses_idempotent_helper() -> None:
    text = read_plugin_file("prompts/execute-prompt.md")

    assert HELPER in text
    assert "If all clear" in text


def test_full_loop_terminal_completion_uses_idempotent_helper() -> None:
    text = read_plugin_file("prompts/prompt.md")

    assert HELPER in text
    assert "If all clear" in text
