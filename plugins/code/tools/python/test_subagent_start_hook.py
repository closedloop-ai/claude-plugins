"""Tests for subagent-start-hook.sh self-learning guard (T-6.4)."""

import json
import subprocess
from pathlib import Path

import pytest

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / "hooks" / "subagent-start-hook.sh"


@pytest.fixture()
def session_env(tmp_path: Path) -> tuple[Path, Path, str]:
    """Create temp CWD with session mapping and workdir with config.env.

    Returns (cwd, workdir, session_id).
    """
    session_id = "test-start-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"

    # Create session mapping
    session_dir = cwd / ".closedloop-ai"
    session_dir.mkdir(parents=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    # Create workdir structure
    closedloop_dir = workdir / ".closedloop"
    closedloop_dir.mkdir(parents=True)

    learnings_dir = workdir / ".learnings"
    learnings_dir.mkdir(parents=True)

    return cwd, workdir, session_id


def run_start_hook(
    cwd: str,
    session_id: str,
    agent_type: str = "code:implementation-subagent",
    agent_id: str = "agent-456",
    self_learning: bool = False,
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Invoke subagent-start-hook.sh with crafted JSON input."""
    # Write config.env
    workdir_file = Path(cwd) / ".closedloop-ai" / f"session-{session_id}.workdir"
    workdir = workdir_file.read_text().strip()
    config_path = Path(workdir) / ".closedloop" / "config.env"
    sl_value = "true" if self_learning else "false"
    config_path.write_text(f"CLOSEDLOOP_SELF_LEARNING={sl_value}\n")

    payload = json.dumps(
        {
            "agent_id": agent_id,
            "agent_type": agent_type,
            "cwd": cwd,
            "session_id": session_id,
        }
    )
    env = dict(env_overrides) if env_overrides else {}
    # Ensure PATH is inherited so jq, awk, etc. are available
    import os

    env.setdefault("PATH", os.environ.get("PATH", "/usr/bin:/bin"))
    if "HOME" not in env:
        env["HOME"] = os.environ.get("HOME", "/tmp")

    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


class TestSelfLearningOff:
    """Tests that subagent-start-hook.sh skips learning injection when disabled."""

    def test_exits_zero_with_additional_context(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Hook exits 0 and outputs additionalContext with env-info when disabled."""
        cwd, _workdir, session_id = session_env
        result = run_start_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        stdout = result.stdout.strip()
        assert stdout, "Expected JSON output but got empty stdout"
        output = json.loads(stdout)
        assert "hookSpecificOutput" in output
        ctx = output["hookSpecificOutput"]["additionalContext"]
        # Should contain CLOSEDLOOP_WORKDIR env-info
        assert "CLOSEDLOOP_WORKDIR=" in ctx

    def test_no_toon_patterns_when_disabled(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When disabled, output should NOT contain TOON/patterns content."""
        cwd, workdir, session_id = session_env

        # Create a patterns file in HOME to verify it's NOT read
        home_dir = workdir / "fake_home"
        patterns_dir = home_dir / ".closedloop-ai" / "learnings"
        patterns_dir.mkdir(parents=True)
        (patterns_dir / "org-patterns.toon").write_text(
            '# TOON\npatterns[\n  p1,testing,"Test pattern",high,5,0.8,"",*,"test context"\n]\n'
        )

        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=False,
            env_overrides={"HOME": str(home_dir)},
        )
        assert result.returncode == 0

        stdout = result.stdout.strip()
        output = json.loads(stdout)
        ctx = output["hookSpecificOutput"]["additionalContext"]
        # Should NOT contain pattern content
        assert "Test pattern" not in ctx
        assert "org-patterns" not in ctx.lower()

    def test_agent_type_file_still_written(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Agent-type tracking is unconditional -- file should be written even when disabled."""
        cwd, workdir, session_id = session_env
        agent_id = "agent-track-test"
        result = run_start_hook(
            str(cwd), session_id, agent_id=agent_id, self_learning=False
        )
        assert result.returncode == 0

        agent_type_file = workdir / ".agent-types" / agent_id
        assert agent_type_file.exists(), "Agent-type file should be written regardless of self-learning"
        content = agent_type_file.read_text()
        assert "code:implementation-subagent" in content


class TestSelfLearningOn:
    """Tests that subagent-start-hook.sh proceeds to patterns injection when enabled."""

    def test_proceeds_to_patterns_path(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When enabled, hook reaches the patterns/TOON injection path.

        With a patterns file present, the hook should inject pattern content.
        We set HOME to a temp dir with org-patterns.toon.
        """
        cwd, workdir, session_id = session_env

        # Create patterns file under fake HOME
        home_dir = workdir / "fake_home"
        patterns_dir = home_dir / ".closedloop-ai" / "learnings"
        patterns_dir.mkdir(parents=True)
        (patterns_dir / "org-patterns.toon").write_text(
            '# TOON org-patterns\npatterns[\n'
            '  p1,testing,"Always validate inputs before processing",high,5,0.8,"",'
            '"implementation-subagent","validation context"\n'
            "]\n"
        )

        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=True,
            env_overrides={"HOME": str(home_dir)},
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        stdout = result.stdout.strip()
        assert stdout, "Expected output when self-learning is enabled"
        output = json.loads(stdout)
        # Should have hookSpecificOutput with additionalContext
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "CLOSEDLOOP_WORKDIR=" in ctx

    def test_env_info_no_patterns_file(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When enabled but no patterns file exists, still outputs env-info."""
        cwd, workdir, session_id = session_env

        # HOME points to empty dir -- no org-patterns.toon
        home_dir = workdir / "empty_home"
        home_dir.mkdir(parents=True)

        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=True,
            env_overrides={"HOME": str(home_dir)},
        )
        assert result.returncode == 0

        stdout = result.stdout.strip()
        output = json.loads(stdout)
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "CLOSEDLOOP_WORKDIR=" in ctx



def test_ignores_legacy_session_mapping(tmp_path: Path) -> None:
    """Should not resolve workdir mappings from legacy `.claude/.closedloop`."""
    session_id = "legacy-start-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"
    legacy_dir = cwd / ".claude" / ".closedloop"
    legacy_dir.mkdir(parents=True)
    workdir.mkdir(parents=True)
    (workdir / ".closedloop").mkdir(parents=True)
    (legacy_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    payload = json.dumps(
        {
            "agent_id": "agent-legacy",
            "agent_type": "code:implementation-subagent",
            "cwd": str(cwd),
            "session_id": session_id,
        }
    )

    import os

    result = subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp"),
        },
    )

    assert result.returncode == 0
    assert result.stdout.strip() == ""
    assert not (workdir / ".agent-types").exists()






def test_ignores_legacy_home_patterns(session_env: tuple[Path, Path, str]) -> None:
    """Should not inject patterns from legacy `~/.claude/.learnings`."""
    cwd, workdir, session_id = session_env
    home_dir = workdir / "legacy_home"
    legacy_dir = home_dir / ".claude" / ".learnings"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "org-patterns.toon").write_text(
        "# TOON org-patterns\npatterns[\n"
        "  p1,testing,\"Legacy pattern\",high,5,0.8,\"\","
        "\"implementation-subagent\",\"validation context\"\n"
        "]\n"
    )

    result = run_start_hook(
        str(cwd),
        session_id,
        self_learning=True,
        env_overrides={"HOME": str(home_dir)},
    )

    assert result.returncode == 0, f"Hook failed: {result.stderr}"
    output = json.loads(result.stdout.strip())
    ctx = output["hookSpecificOutput"]["additionalContext"]
    assert "Legacy pattern" not in ctx

def test_injects_when_only_plain_awk_is_available(session_env: tuple[Path, Path, str]) -> None:
    """Should continue injecting learnings when only plain awk is available."""
    cwd, workdir, session_id = session_env

    home_dir = workdir / "plain-awk-home"
    patterns_dir = home_dir / ".closedloop-ai" / "learnings"
    patterns_dir.mkdir(parents=True)
    (patterns_dir / "org-patterns.toon").write_text(
        "# TOON org-patterns\npatterns[\n"
        "  p1,testing,\"Always validate inputs before processing\",high,5,0.8,\"\",\"implementation-subagent\",\"validation context\"\n"
        "]\n"
    )

    result = run_start_hook(
        str(cwd),
        session_id,
        self_learning=True,
        env_overrides={"HOME": str(home_dir), "PATH": "/usr/bin:/bin"},
    )

    assert result.returncode == 0, f"Hook failed: {result.stderr}"
    output = json.loads(result.stdout.strip())
    ctx = output["hookSpecificOutput"]["additionalContext"]
    assert "CLOSEDLOOP_WORKDIR=" in ctx
    assert "Always validate inputs before processing" in ctx
