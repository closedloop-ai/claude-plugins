"""Tests for stream_formatter.py."""

import shlex
import subprocess
import sys
from pathlib import Path

# Add tools directory to path to import stream_formatter module
sys.path.insert(0, str(Path(__file__).parent))

from stream_formatter import (
    _accumulate_usage,
    format_event,
)


class TestImportSmoke:
    """Smoke test: verify stream_formatter imports cleanly under system python3."""

    def test_import_under_system_python3(self) -> None:
        """Import stream_formatter using subprocess to catch Python 3.9 syntax errors."""
        result = subprocess.run(
            ["python3", "-c", "import stream_formatter"],
            cwd=Path(__file__).parent,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (
            f"stream_formatter failed to import:\n{result.stderr}"
        )
        assert result.stderr == ""


class TestFormatEvent:
    """Unit tests for format_event."""

    def test_assistant_text_event(self) -> None:
        """Assistant event with text content returns the text."""
        event = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Hello, world!"}],
            },
        }
        result = format_event(event)
        assert result == "Hello, world!"

    def test_assistant_tool_use_event(self) -> None:
        """Assistant event with tool_use content returns tool name."""
        event = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {"command": "echo hello"},
                    }
                ],
            },
        }
        result = format_event(event)
        assert result is not None
        assert "Bash" in result
        assert "echo hello" in result

    def test_user_tool_result_event(self) -> None:
        """User event with tool_result content returns preview."""
        event = {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "content": "output line 1\noutput line 2",
                        "is_error": False,
                    }
                ]
            },
        }
        result = format_event(event)
        assert result is not None
        assert "output line 1" in result

    def test_system_event(self) -> None:
        """System event returns magenta-colored label."""
        event: dict[str, object] = {"type": "system", "subtype": "init"}
        result = format_event(event)
        assert result is not None
        assert "system" in result
        assert "init" in result

    def test_result_event(self) -> None:
        """Result event with result text returns formatted result."""
        event: dict[str, object] = {"type": "result", "result": "Task completed successfully"}
        result = format_event(event)
        assert result is not None
        assert "Result:" in result
        assert "Task completed successfully" in result

    def test_unknown_event_type_returns_none(self) -> None:
        """Unknown event type returns None."""
        event: dict[str, object] = {"type": "unknown_event_xyz"}
        assert format_event(event) is None

    def test_assistant_empty_content_returns_none(self) -> None:
        """Assistant event with empty content list returns None."""
        event = {
            "type": "assistant",
            "message": {"role": "assistant", "content": []},
        }
        assert format_event(event) is None

    def test_result_event_empty_result_returns_none(self) -> None:
        """Result event with empty result returns None."""
        event: dict[str, object] = {"type": "result", "result": ""}
        assert format_event(event) is None

    def test_user_event_no_tool_results_returns_none(self) -> None:
        """User event with no tool_result blocks returns None."""
        event = {
            "type": "user",
            "message": {"content": [{"type": "text", "text": "hello"}]},
        }
        assert format_event(event) is None

    def test_result_event_long_text_truncated(self) -> None:
        """Result event with text longer than RESULT_TEXT_CHARS is truncated."""
        long_text = "x" * 300
        event: dict[str, object] = {"type": "result", "result": long_text}
        result = format_event(event)
        assert result is not None
        assert "..." in result
        # Should not contain the full text
        assert long_text not in result


class TestAccumulateUsage:
    """Unit tests for _accumulate_usage."""

    def test_accumulates_basic_tokens(self) -> None:
        """Accumulates input and output tokens for a model."""
        tokens_by_model: dict = {}
        event: dict[str, object] = {
            "type": "assistant",
            "message": {
                "model": "claude-opus-4-6",
                "usage": {"input_tokens": 100, "output_tokens": 50},
            },
        }
        _accumulate_usage(tokens_by_model, event)
        assert "claude-opus-4-6" in tokens_by_model
        assert tokens_by_model["claude-opus-4-6"]["input"] == 100
        assert tokens_by_model["claude-opus-4-6"]["output"] == 50

    def test_accumulates_across_multiple_events(self) -> None:
        """Multiple events for same model sum up correctly."""
        tokens_by_model: dict = {}
        event1: dict[str, object] = {
            "message": {
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 200, "output_tokens": 80},
            }
        }
        event2: dict[str, object] = {
            "message": {
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 300, "output_tokens": 120},
            }
        }
        _accumulate_usage(tokens_by_model, event1)
        _accumulate_usage(tokens_by_model, event2)
        assert tokens_by_model["claude-sonnet-4-6"]["input"] == 500
        assert tokens_by_model["claude-sonnet-4-6"]["output"] == 200

    def test_accumulates_cache_tokens(self) -> None:
        """Cache creation and read tokens are accumulated."""
        tokens_by_model: dict = {}
        event: dict[str, object] = {
            "message": {
                "model": "claude-haiku-4-5",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_creation_input_tokens": 1000,
                    "cache_read_input_tokens": 500,
                },
            }
        }
        _accumulate_usage(tokens_by_model, event)
        assert tokens_by_model["claude-haiku-4-5"]["cache_creation"] == 1000
        assert tokens_by_model["claude-haiku-4-5"]["cache_read"] == 500

    def test_ignores_event_without_message(self) -> None:
        """Event with no message key does not raise and does nothing."""
        tokens_by_model: dict = {}
        event: dict[str, object] = {"type": "system"}
        _accumulate_usage(tokens_by_model, event)
        assert tokens_by_model == {}

    def test_ignores_event_without_usage(self) -> None:
        """Message with no usage key does not raise and does nothing."""
        tokens_by_model: dict = {}
        event: dict[str, object] = {"message": {"model": "claude-opus-4-6"}}
        _accumulate_usage(tokens_by_model, event)
        assert tokens_by_model == {}

    def test_defaults_model_to_unknown(self) -> None:
        """Message without model key uses 'unknown' as model name."""
        tokens_by_model: dict = {}
        event: dict[str, object] = {
            "message": {
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
        }
        _accumulate_usage(tokens_by_model, event)
        assert "unknown" in tokens_by_model

    def test_multiple_models_tracked_separately(self) -> None:
        """Different models are tracked in separate entries."""
        tokens_by_model: dict = {}
        for model in ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]:
            event: dict[str, object] = {
                "message": {
                    "model": model,
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                }
            }
            _accumulate_usage(tokens_by_model, event)
        assert len(tokens_by_model) == 3


class TestMain:
    """Subprocess tests for main() pipeline behavior."""

    def _run_main(self, input_jsonl: str) -> subprocess.CompletedProcess:
        """Helper to run stream_formatter.py as a subprocess."""
        return subprocess.run(
            ["python3", str(Path(__file__).parent / "stream_formatter.py")],
            input=input_jsonl,
            capture_output=True,
            text=True,
        )

    def test_main_mixed_input_exits_zero(self) -> None:
        """Mixed valid and invalid JSONL lines are processed without error."""
        input_jsonl = "\n".join([
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
            "not valid json",
            "",
            '{"type":"result","result":"done"}',
            "",
        ])
        result = self._run_main(input_jsonl)
        assert result.returncode == 0

    def test_main_outputs_text_for_assistant_events(self) -> None:
        """Assistant text events produce readable output."""
        event = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from assistant"}]}}'
        result = self._run_main(event + "\n")
        assert result.returncode == 0
        assert "Hello from assistant" in result.stdout

    def test_main_outputs_token_summary(self) -> None:
        """Token usage summary is printed after processing assistant events."""
        event = (
            '{"type":"assistant","message":{"role":"assistant",'
            '"model":"claude-opus-4-6",'
            '"content":[{"type":"text","text":"hi"}],'
            '"usage":{"input_tokens":100,"output_tokens":50}}}'
        )
        result = self._run_main(event + "\n")
        assert result.returncode == 0
        assert "Total input tokens: 100" in result.stdout
        assert "Total output tokens: 50" in result.stdout

    def test_main_exits_zero_on_broken_pipe(self) -> None:
        """SIGPIPE / broken pipe from downstream consumer does not cause non-zero exit."""
        input_jsonl = (
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}\n'
            * 10
        )
        result = subprocess.run(
            [
                "bash",
                "-o",
                "pipefail",
                "-lc",
                f"python3 {shlex.quote(str(Path(__file__).parent / 'stream_formatter.py'))} | head -n 1 >/dev/null",
            ],
            cwd=Path(__file__).parent,
            input=input_jsonl,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert result.stderr == ""

    def test_main_empty_input_exits_zero(self) -> None:
        """Empty input produces zero exit code and no output."""
        result = self._run_main("")
        assert result.returncode == 0
        assert result.stdout == ""

    def test_main_ignores_invalid_json_lines(self) -> None:
        """Lines that are not valid JSON are silently skipped."""
        input_jsonl = "not json\nalso not json\n{\"type\":\"result\",\"result\":\"ok\"}\n"
        result = self._run_main(input_jsonl)
        assert result.returncode == 0
        assert result.stderr == ""
