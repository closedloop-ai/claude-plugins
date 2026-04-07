
"""Tests for session-end-hook.sh path handling."""

import json
import subprocess
from pathlib import Path

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / "hooks" / "session-end-hook.sh"


def run_session_end(cwd: Path, session_id: str) -> subprocess.CompletedProcess:
    """Invoke session-end-hook.sh with crafted JSON input."""
    payload = json.dumps({"cwd": str(cwd), "session_id": session_id, "reason": "test"})
    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_cleans_closedloop_session_mapping(tmp_path: Path) -> None:
    """Should clean active `.closedloop-ai` session mappings and agent-type state."""
    session_id = "cleanup-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"
    closedloop_dir = cwd / ".closedloop-ai"
    closedloop_dir.mkdir(parents=True)
    workdir.mkdir(parents=True)
    (closedloop_dir / f"session-{session_id}.workdir").write_text(str(workdir))
    agent_types_dir = workdir / ".agent-types"
    agent_types_dir.mkdir(parents=True)
    (agent_types_dir / "agent-1").write_text("code:implementation-subagent|implementation-subagent|2026-04-07T00:00:00Z")

    result = run_session_end(cwd, session_id)

    assert result.returncode == 0, result.stderr
    assert not (closedloop_dir / f"session-{session_id}.workdir").exists()
    assert not agent_types_dir.exists()


def test_ignores_legacy_session_mapping(tmp_path: Path) -> None:
    """Should ignore legacy `.claude/.closedloop` mappings entirely."""
    session_id = "legacy-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"
    legacy_dir = cwd / ".claude" / ".closedloop"
    legacy_dir.mkdir(parents=True)
    workdir.mkdir(parents=True)
    (legacy_dir / f"session-{session_id}.workdir").write_text(str(workdir))
    agent_types_dir = workdir / ".agent-types"
    agent_types_dir.mkdir(parents=True)
    (agent_types_dir / "agent-1").write_text("code:implementation-subagent|implementation-subagent|2026-04-07T00:00:00Z")

    result = run_session_end(cwd, session_id)

    assert result.returncode == 0, result.stderr
    assert (legacy_dir / f"session-{session_id}.workdir").exists()
    assert agent_types_dir.exists()
