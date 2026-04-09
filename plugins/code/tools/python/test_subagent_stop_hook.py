"""Tests for subagent-stop-hook.sh self-learning guard (T-6.3)."""

import json
import subprocess
from pathlib import Path

import pytest

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / "hooks" / "subagent-stop-hook.sh"


@pytest.fixture()
def session_env(tmp_path: Path) -> tuple[Path, Path, str]:
    """Create temp CWD with session mapping and workdir with config.env.

    Returns (cwd, workdir, session_id).
    """
    session_id = "test-stop-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"

    # Create session mapping
    session_dir = cwd / ".closedloop-ai"
    session_dir.mkdir(parents=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    # Create workdir structure
    closedloop_dir = workdir / ".closedloop-ai"
    closedloop_dir.mkdir(parents=True)

    learnings_dir = workdir / ".learnings"
    learnings_dir.mkdir(parents=True)
    (learnings_dir / "pending").mkdir()

    # Create agent-types dir and write agent-type file
    agent_types_dir = workdir / ".agent-types"
    agent_types_dir.mkdir(parents=True)
    (agent_types_dir / "agent-123").write_text(
        "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
    )

    return cwd, workdir, session_id


def run_stop_hook(
    cwd: str,
    session_id: str,
    agent_id: str = "agent-123",
    self_learning: bool = False,
    config_env_extra: str = "",
) -> subprocess.CompletedProcess:
    """Invoke subagent-stop-hook.sh with crafted JSON input."""
    # Write config.env
    workdir_file = Path(cwd) / ".closedloop-ai" / f"session-{session_id}.workdir"
    workdir = workdir_file.read_text().strip()
    config_path = Path(workdir) / ".closedloop-ai" / "config.env"
    sl_value = "true" if self_learning else "false"
    config_path.write_text(
        f"CLOSEDLOOP_SELF_LEARNING={sl_value}\n{config_env_extra}"
    )

    payload = json.dumps(
        {
            "agent_id": agent_id,
            "cwd": cwd,
            "stop_hook_active": True,
            "session_id": session_id,
            "agent_transcript_path": "",
        }
    )
    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
    )


class TestSelfLearningOff:
    """Tests that subagent-stop-hook.sh skips learning region when disabled."""

    def test_exits_zero_outputs_empty_json(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Hook exits 0 and outputs {} when CLOSEDLOOP_SELF_LEARNING=false."""
        cwd, _workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0, f"Hook failed: {result.stderr}"
        stdout = result.stdout.strip()
        # Should output {} (empty JSON, no modifications)
        assert stdout == "{}", f"Expected '{{}}' but got: {stdout}"

    def test_no_acknowledgments_log_written(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When disabled, acknowledgments.log should NOT be written."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        ack_log = workdir / ".learnings" / "acknowledgments.log"
        assert not ack_log.exists(), "acknowledgments.log should not exist when self-learning is off"

    def test_no_outcomes_log_written(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When disabled, outcomes.log should NOT be written."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        outcomes_log = workdir / ".learnings" / "outcomes.log"
        assert not outcomes_log.exists(), "outcomes.log should not exist when self-learning is off"

    def test_agent_type_file_cleaned_up(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Agent-type file is cleaned up even when self-learning is off."""
        cwd, workdir, session_id = session_env
        agent_type_file = workdir / ".agent-types" / "agent-123"
        assert agent_type_file.exists(), "Precondition: agent-type file should exist"

        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        assert not agent_type_file.exists(), "Agent-type file should be cleaned up"


class TestSelfLearningOn:
    """Tests that subagent-stop-hook.sh enters the learning region when enabled."""

    def test_acknowledgment_enforcement_reachable(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When enabled, the hook writes acknowledgments.log (missing-ack path)."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=True)
        assert result.returncode == 0

        # With no transcript and no LEARNINGS_ACKNOWLEDGED, the hook should write
        # a missing-acknowledgment entry to acknowledgments.log
        ack_log = workdir / ".learnings" / "acknowledgments.log"
        assert ack_log.exists(), "acknowledgments.log should exist when self-learning is on"
        content = ack_log.read_text()
        assert "false" in content, "Should log false acknowledgment"
        assert "implementation-subagent" in content
