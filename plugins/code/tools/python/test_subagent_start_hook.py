"""Tests for subagent-start-hook.sh self-learning guard (T-6.4)."""

import json
import subprocess
from pathlib import Path

import pytest
from conftest import CLOSEDLOOP_STATE_DIR

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
    session_dir = cwd / CLOSEDLOOP_STATE_DIR
    session_dir.mkdir(parents=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    # Create workdir structure
    closedloop_dir = workdir / CLOSEDLOOP_STATE_DIR
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
    config_values: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Invoke subagent-start-hook.sh with crafted JSON input."""
    # Write config.env
    workdir_file = Path(cwd) / CLOSEDLOOP_STATE_DIR / f"session-{session_id}.workdir"
    workdir = workdir_file.read_text().strip()
    config_path = Path(workdir) / CLOSEDLOOP_STATE_DIR / "config.env"
    sl_value = "true" if self_learning else "false"
    config_lines = [f"CLOSEDLOOP_SELF_LEARNING={sl_value}"]
    if config_values:
        config_lines.extend(f"{key}={value}" for key, value in config_values.items())
    config_path.write_text("\n".join(config_lines) + "\n")

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
        patterns_dir = home_dir / CLOSEDLOOP_STATE_DIR / "learnings"
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

    def test_includes_multi_repo_exports_in_additional_context(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Hook includes export commands for multi-repo env vars in additionalContext."""
        cwd, _workdir, session_id = session_env
        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=False,
            config_values={
                "CLOSEDLOOP_ADD_DIRS": '"/tmp/repo-a|/tmp/repo-b"',
                "CLOSEDLOOP_ADD_DIR_NAMES": '"repo-a|repo-b"',
                "CLOSEDLOOP_REPO_MAP": '"repo-a=/tmp/repo-a|repo-b=/tmp/repo-b"',
            },
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        output = json.loads(result.stdout.strip())
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert 'export CLOSEDLOOP_ADD_DIRS="/tmp/repo-a|/tmp/repo-b"' in ctx
        assert 'export CLOSEDLOOP_ADD_DIR_NAMES="repo-a|repo-b"' in ctx
        assert 'export CLOSEDLOOP_REPO_MAP="repo-a=/tmp/repo-a|repo-b=/tmp/repo-b"' in ctx


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
        patterns_dir = home_dir / CLOSEDLOOP_STATE_DIR / "learnings"
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
    patterns_dir = home_dir / CLOSEDLOOP_STATE_DIR / "learnings"
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


def _make_booster_manifest(tmp_path: Path, skills: list[dict]) -> Path:
    """Write a booster.json manifest to tmp_path and return its path."""
    manifest = {
        "name": "GStack",
        "skills": skills,
    }
    manifest_path = tmp_path / "booster.json"
    manifest_path.write_text(json.dumps(manifest))
    return manifest_path


class TestGStackBoosterSkills:
    """Tests for GStack booster skill injection (T-4.2)."""

    def test_gstack_skills_injected_with_prefix(
        self, session_env: tuple[Path, Path, str], tmp_path: Path
    ) -> None:
        """GStack skills appear with 'gstack:' prefix when CLOSEDLOOP_BOOSTER_MANIFEST_PATH is set."""
        import os

        cwd, _workdir, session_id = session_env

        manifest_path = _make_booster_manifest(
            tmp_path,
            [
                {"name": "visual-qa", "description": "Run visual QA checks", "requiresBrowser": False},
                {"name": "perf-audit", "description": "Run performance audit", "requiresBrowser": False},
            ],
        )

        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=False,
            env_overrides={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": os.environ.get("HOME", "/tmp"),
                "CLOSEDLOOP_BOOSTER_MANIFEST_PATH": str(manifest_path),
                "CLOSEDLOOP_BOOSTER": "gstack",
            },
        )

        assert result.returncode == 0, f"Hook failed: {result.stderr}"
        output = json.loads(result.stdout.strip())
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "gstack:visual-qa" in ctx, f"Expected 'gstack:visual-qa' in context; got: {ctx}"
        assert "gstack:perf-audit" in ctx, f"Expected 'gstack:perf-audit' in context; got: {ctx}"
        assert "<booster-skills>" in ctx
        assert "Run visual QA checks" in ctx
        assert "Run performance audit" in ctx

    def test_no_gstack_skills_when_env_var_absent(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """No booster skills are injected when CLOSEDLOOP_BOOSTER_MANIFEST_PATH is not set."""
        import os

        cwd, _workdir, session_id = session_env

        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=False,
            env_overrides={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": os.environ.get("HOME", "/tmp"),
                # CLOSEDLOOP_BOOSTER_MANIFEST_PATH deliberately omitted
            },
        )

        assert result.returncode == 0, f"Hook failed: {result.stderr}"
        output = json.loads(result.stdout.strip())
        ctx = output["hookSpecificOutput"]["additionalContext"]
        assert "<booster-skills>" not in ctx, (
            "Expected no booster-skills block when CLOSEDLOOP_BOOSTER_MANIFEST_PATH is absent"
        )
        assert "gstack:" not in ctx

    def test_browser_dependent_skills_skipped_with_warning_when_playwright_unavailable(
        self, session_env: tuple[Path, Path, str], tmp_path: Path
    ) -> None:
        """Browser-dependent skills are skipped with a stderr warning when Playwright is unavailable.

        Uses a Python wrapper script placed ahead of the real python3 on PATH.
        When invoked with '-' (stdin mode, as the hook does), the wrapper prepends
        a playwright stub and a shutil.which patch so that Playwright is seen as
        unavailable, then executes the hook's inline script.
        """
        import os
        import stat
        import sys as _sys

        cwd, _workdir, session_id = session_env

        # Manifest with one non-browser and one browser-only skill
        manifest_path = _make_booster_manifest(
            tmp_path,
            [
                {"name": "no-browser-skill", "description": "Works without browser", "requiresBrowser": False},
                {"name": "screenshot", "description": "Takes screenshots", "requiresBrowser": True},
            ],
        )

        # Build a Python wrapper that intercepts stdin-mode invocations and
        # makes playwright unavailable. The wrapper is a Python script itself
        # so there are no bash heredoc quoting issues.
        fake_bin_dir = tmp_path / "fake_bin"
        fake_bin_dir.mkdir()
        real_python = _sys.executable  # absolute path to the running interpreter

        # The playwright stub prepended to the hook's inline script
        playwright_stub = (
            "import sys as _sys, types as _types\n"
            "class _NoPW:\n"
            "    def find_module(self, n, p=None):\n"
            "        if n == 'playwright' or n.startswith('playwright.'): return self\n"
            "    def load_module(self, n):\n"
            "        raise ImportError('No module named ' + repr(n) + ' (stubbed)')\n"
            "_sys.meta_path.insert(0, _NoPW())\n"
            "import shutil as _sh; _ow = _sh.which\n"
            "def _pw(name, *a, **kw): return None if name == 'npx' else _ow(name, *a, **kw)\n"
            "_sh.which = _pw\n"
        )

        fake_python_script = fake_bin_dir / "python3"
        # Use the absolute shebang to avoid infinite self-lookup when fake_bin_dir is on PATH
        fake_python_script.write_text(
            "#!" + real_python + "\n"
            "import sys, os\n"
            "\n"
            "# When first arg is '-', we are in stdin-script mode (as called by the hook).\n"
            "# Read the hook's inline Python, prepend the playwright stub, run it.\n"
            "if sys.argv[1:2] == ['-']:\n"
            "    hook_code = sys.stdin.read()\n"
            "    stub = " + repr(playwright_stub) + "\n"
            "    combined = stub + hook_code\n"
            "    # Pass remaining argv items as sys.argv for the hook script\n"
            "    sys.argv = [sys.argv[0]] + sys.argv[2:]\n"
            "    exec(compile(combined, '<booster-hook>', 'exec'))\n"
            "else:\n"
            "    # Forward all other invocations to the real python3\n"
            "    os.execv(" + repr(real_python) + ", [" + repr(real_python) + "] + sys.argv[1:])\n"
        )
        fake_python_script.chmod(
            fake_python_script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
        )

        real_path = os.environ.get("PATH", "/usr/bin:/bin")
        result = run_start_hook(
            str(cwd),
            session_id,
            self_learning=False,
            env_overrides={
                "PATH": f"{fake_bin_dir}:{real_path}",
                "HOME": os.environ.get("HOME", "/tmp"),
                "CLOSEDLOOP_BOOSTER_MANIFEST_PATH": str(manifest_path),
                "CLOSEDLOOP_BOOSTER": "gstack",
            },
        )

        assert result.returncode == 0, f"Hook failed: {result.stderr}"
        output = json.loads(result.stdout.strip())
        ctx = output["hookSpecificOutput"]["additionalContext"]

        # Non-browser skill should be present
        assert "gstack:no-browser-skill" in ctx, (
            f"Expected 'gstack:no-browser-skill' in context; got: {ctx}"
        )
        # Browser-dependent skill should be absent from context
        assert "gstack:screenshot" not in ctx, (
            f"Expected 'gstack:screenshot' to be absent from context; got: {ctx}"
        )
        # Warning should appear in stderr (the hook's Python emits it to stderr)
        assert "Playwright" in result.stderr or "playwright" in result.stderr, (
            f"Expected Playwright warning in stderr; got: {result.stderr}"
        )
