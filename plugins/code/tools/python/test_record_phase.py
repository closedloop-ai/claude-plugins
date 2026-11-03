"""Tests for record_phase.sh JSON output (T-4.3 / AC-002, AC-003)."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import write_config_env, write_state

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "record_phase.sh"


def run_record_phase(
    workdir: Path,
    *,
    run_id: str = "test-run-001",
    command: str = "test-command",
    extra_env: dict[str, str] | None = None,
    clear_closedloop_vars: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Invoke record_phase.sh with the given environment and workdir.

    When ``clear_closedloop_vars`` is True, the CLOSEDLOOP_RUN_ID/ITERATION/
    COMMAND vars are popped from the environment (CLOSEDLOOP_WORKDIR is kept) so
    the script must fall back to config.env for that metadata.
    """
    env = {
        **os.environ,
        "CLOSEDLOOP_RUN_ID": run_id,
        "CLOSEDLOOP_COMMAND": command,
        "CLOSEDLOOP_WORKDIR": str(workdir),
        "CLOSEDLOOP_ITERATION": "1",
    }
    if extra_env:
        env.update(extra_env)
    if clear_closedloop_vars:
        env.pop("CLOSEDLOOP_RUN_ID", None)
        env.pop("CLOSEDLOOP_ITERATION", None)
        env.pop("CLOSEDLOOP_COMMAND", None)
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


class TestRecordPhaseCommandField:
    """Tests that the `command:` field is populated correctly on `phase` events."""

    def test_command_field_present(self, tmp_path: Path) -> None:
        """`command:` field is included in every `phase` event."""
        write_state(tmp_path)
        result = run_record_phase(tmp_path, command="feature")
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "command" in record, "command field must be present on phase events"
        assert record["command"] == "feature", (
            f"command value mismatch: expected 'feature', got '{record['command']}'"
        )

    def test_command_value_matches_env_var(self, tmp_path: Path) -> None:
        """command field value matches CLOSEDLOOP_COMMAND."""
        write_state(tmp_path)
        run_record_phase(tmp_path, command="code-review")
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record["command"] == "code-review", (
            f"Expected command='code-review', got: '{record['command']}'"
        )

    def test_command_defaults_to_interactive_when_unset(self, tmp_path: Path) -> None:
        """command defaults to 'interactive' when CLOSEDLOOP_COMMAND is unset."""
        write_state(tmp_path)
        env = {
            **os.environ,
            "CLOSEDLOOP_RUN_ID": "test-run-001",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "CLOSEDLOOP_ITERATION": "1",
        }
        env.pop("CLOSEDLOOP_COMMAND", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record["command"] == "interactive", (
            f"Expected command='interactive', got: '{record['command']}'"
        )

    def test_run_metadata_falls_back_to_config_env(self, tmp_path: Path) -> None:
        """Missing env metadata is recovered from .closedloop-ai/config.env."""
        write_state(tmp_path)
        write_config_env(
            tmp_path, run_id="config-run-123", iteration=5, command="PLAN"
        )

        result = run_record_phase(tmp_path, clear_closedloop_vars=True)

        assert result.returncode == 0, f"Script failed: {result.stderr}"
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record["run_id"] == "config-run-123"
        assert record["run_id"] != "unknown"
        assert record["iteration"] == 5
        assert record["command"] == "PLAN"


class TestRecordPhaseOutput:
    """Tests that record_phase.sh produces correct JSON structure (T-4.3 / AC-002)."""

    def test_event_field_is_phase(self, tmp_path: Path) -> None:
        """The event field must equal 'phase'."""
        write_state(tmp_path, phase="implement")
        run_record_phase(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record.get("event") == "phase", (
            f"Expected event='phase', got: '{record.get('event')}'"
        )

    def test_phase_field_matches_state_json(self, tmp_path: Path) -> None:
        """The phase field in output matches the phase in state.json."""
        write_state(tmp_path, phase="implement")
        run_record_phase(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record.get("phase") == "implement", (
            f"Expected phase='implement', got: '{record.get('phase')}'"
        )

    def test_no_output_when_state_json_missing(self, tmp_path: Path) -> None:
        """Script exits 0 and writes nothing when state.json does not exist."""
        result = run_record_phase(tmp_path)
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        perf_file = tmp_path / "perf.jsonl"
        assert not perf_file.exists(), (
            "perf.jsonl should not be created when state.json is missing"
        )

    def test_no_output_when_phase_empty(self, tmp_path: Path) -> None:
        """Script exits 0 and writes nothing when phase is empty in state.json."""
        (tmp_path / "state.json").write_text(json.dumps({"phase": "", "status": "done"}))
        result = run_record_phase(tmp_path)
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        perf_file = tmp_path / "perf.jsonl"
        assert not perf_file.exists(), (
            "perf.jsonl should not be created when phase is empty"
        )

    def test_output_contains_all_required_fields_including_command(self, tmp_path: Path) -> None:
        """Phase event always carries every required field including `command`."""
        write_state(tmp_path)
        run_record_phase(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        required = {
            "event",
            "run_id",
            "iteration",
            "phase",
            "status",
            "start_sha",
            "started_at",
            "command",
        }
        missing = required - set(record.keys())
        assert not missing, f"Missing required fields: {missing}"


class TestRecordPhaseFailOpen:
    """Tests that record_phase.sh fails open (exits 0) on error conditions (T-4.3 / AC-003)."""

    def test_exits_zero_when_workdir_missing_state(self, tmp_path: Path) -> None:
        """Script exits 0 when state.json is absent (no-op)."""
        result = run_record_phase(tmp_path)
        assert result.returncode == 0, (
            f"Script should exit 0 when state.json is missing, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )

    def test_exits_zero_with_no_stderr_on_missing_state(self, tmp_path: Path) -> None:
        """Script produces no stderr when state.json is absent."""
        result = run_record_phase(tmp_path)
        assert result.stderr == "", (
            f"Script should produce no stderr when state.json is missing, got: {result.stderr!r}"
        )
