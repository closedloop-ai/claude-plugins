"""Tests for record_run.sh JSON output (T-4.1 / AC-001) and fail-open behavior (T-4.2 / AC-003)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "record_run.sh"


def run_record_run(
    workdir: Path,
    *,
    perf_v2: str = "1",
    run_id: str = "test-run-001",
    command: str = "test-command",
    extra_env: Optional[dict[str, str]] = None,
) -> subprocess.CompletedProcess[str]:
    """Invoke record_run.sh with the given environment and workdir."""
    env = {
        **os.environ,
        "CLOSEDLOOP_PERF_V2": perf_v2,
        "CLOSEDLOOP_RUN_ID": run_id,
        "CLOSEDLOOP_COMMAND": command,
        "CLOSEDLOOP_WORKDIR": str(workdir),
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


class TestRecordRunGate:
    """Tests that record_run.sh is no-op when CLOSEDLOOP_PERF_V2 is not 1."""

    def test_noop_when_gate_off(self, tmp_path: Path) -> None:
        """Script exits 0 and writes nothing when CLOSEDLOOP_PERF_V2 is unset."""
        result = run_record_run(tmp_path, perf_v2="")
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        perf_file = tmp_path / "perf.jsonl"
        assert not perf_file.exists(), "perf.jsonl should not be created when gate is off"

    def test_noop_when_gate_zero(self, tmp_path: Path) -> None:
        """Script exits 0 and writes nothing when CLOSEDLOOP_PERF_V2=0."""
        result = run_record_run(tmp_path, perf_v2="0")
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        perf_file = tmp_path / "perf.jsonl"
        assert not perf_file.exists(), "perf.jsonl should not be created when gate is 0"


class TestRecordRunOutput:
    """Tests that record_run.sh produces correct JSON when CLOSEDLOOP_PERF_V2=1."""

    def test_exits_zero(self, tmp_path: Path) -> None:
        """Script exits 0 when CLOSEDLOOP_PERF_V2=1."""
        result = run_record_run(tmp_path)
        assert result.returncode == 0, f"Script failed: {result.stderr}"

    def test_creates_perf_jsonl(self, tmp_path: Path) -> None:
        """Script creates perf.jsonl in the given workdir."""
        run_record_run(tmp_path)
        perf_file = tmp_path / "perf.jsonl"
        assert perf_file.exists(), "perf.jsonl should be created when CLOSEDLOOP_PERF_V2=1"

    def test_output_is_valid_json(self, tmp_path: Path) -> None:
        """The appended line is valid JSON."""
        run_record_run(tmp_path)
        perf_file = tmp_path / "perf.jsonl"
        line = perf_file.read_text().strip()
        assert line, "perf.jsonl should contain at least one line"
        record = json.loads(line)  # raises if not valid JSON
        assert isinstance(record, dict)

    def test_event_field_is_run(self, tmp_path: Path) -> None:
        """The `event` field must equal 'run'."""
        run_record_run(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record.get("event") == "run", f"Expected event='run', got: {record.get('event')}"

    def test_run_id_field_present(self, tmp_path: Path) -> None:
        """The `run_id` field must be present and match CLOSEDLOOP_RUN_ID."""
        run_record_run(tmp_path, run_id="my-run-42")
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "run_id" in record, "run_id field missing from output"
        assert record["run_id"] == "my-run-42", f"run_id mismatch: {record['run_id']}"

    def test_command_field_present(self, tmp_path: Path) -> None:
        """The `command` field must be present and match CLOSEDLOOP_COMMAND."""
        run_record_run(tmp_path, command="feature")
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "command" in record, "command field missing from output"
        assert record["command"] == "feature", f"command mismatch: {record['command']}"

    def test_started_at_field_present(self, tmp_path: Path) -> None:
        """The `started_at` field must be present and non-empty."""
        run_record_run(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "started_at" in record, "started_at field missing from output"
        assert record["started_at"], "started_at should be non-empty"

    def test_repo_field_present(self, tmp_path: Path) -> None:
        """The `repo` field must be present (value may be empty string for non-git dirs)."""
        run_record_run(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "repo" in record, "repo field missing from output"

    def test_branch_field_present(self, tmp_path: Path) -> None:
        """The `branch` field must be present (value may be empty string for non-git dirs)."""
        run_record_run(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert "branch" in record, "branch field missing from output"

    def test_all_required_fields_present(self, tmp_path: Path) -> None:
        """All six required fields must be present: event, run_id, command, started_at, repo, branch."""
        run_record_run(tmp_path)
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        required_fields = {"event", "run_id", "command", "started_at", "repo", "branch"}
        missing = required_fields - set(record.keys())
        assert not missing, f"Missing required fields: {missing}"

    def test_exactly_one_line_written(self, tmp_path: Path) -> None:
        """Script appends exactly one JSON line per invocation."""
        run_record_run(tmp_path)
        lines = [line for line in (tmp_path / "perf.jsonl").read_text().splitlines() if line.strip()]
        assert len(lines) == 1, f"Expected 1 line, got {len(lines)}"

    def test_run_id_defaults_to_unknown_when_unset(self, tmp_path: Path) -> None:
        """When CLOSEDLOOP_RUN_ID is unset, run_id defaults to 'unknown'."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
        }
        # Remove CLOSEDLOOP_RUN_ID if set in current environment
        env.pop("CLOSEDLOOP_RUN_ID", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record["run_id"] == "unknown", f"Expected 'unknown', got: {record['run_id']}"

    def test_command_defaults_to_interactive_when_unset(self, tmp_path: Path) -> None:
        """When CLOSEDLOOP_COMMAND is unset, command defaults to 'interactive'."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
        }
        env.pop("CLOSEDLOOP_COMMAND", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0
        record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
        assert record["command"] == "interactive", f"Expected 'interactive', got: {record['command']}"

    def test_appends_on_subsequent_invocations(self, tmp_path: Path) -> None:
        """Calling the script twice appends two lines to perf.jsonl."""
        run_record_run(tmp_path, run_id="run-1")
        run_record_run(tmp_path, run_id="run-2")
        lines = [line for line in (tmp_path / "perf.jsonl").read_text().splitlines() if line.strip()]
        assert len(lines) == 2, f"Expected 2 lines after two runs, got {len(lines)}"
        first = json.loads(lines[0])
        second = json.loads(lines[1])
        assert first["run_id"] == "run-1"
        assert second["run_id"] == "run-2"

    def test_noop_when_no_workdir(self) -> None:
        """Script exits 0 when WORKDIR arg and CLOSEDLOOP_WORKDIR are both absent."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
        }
        env.pop("CLOSEDLOOP_WORKDIR", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH)],  # no workdir arg
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, f"Script failed: {result.stderr}"

    def test_repo_captured_when_timeout_unavailable(self, tmp_path: Path) -> None:
        """When `timeout` is not in PATH, repo is still captured via bare git.

        Regression for the macOS-default case where GNU `timeout` is not installed:
        without the `command -v timeout` guard, `timeout 5 git ...` would hit
        "command not found", and the `|| echo ""` fallback would silently emit
        empty repo/branch in every run event.

        On Linux CI, `bash`, `git`, `timeout`, etc. are colocated in `/usr/bin`,
        so we cannot just strip `timeout`'s dir from PATH. Instead, build a
        fake-bin temp dir with symlinks to ONLY the binaries the script needs
        (NOT `timeout`), and point the child's PATH there.
        """
        workdir = tmp_path / "work"
        workdir.mkdir()
        subprocess.run(
            ["git", "init"], cwd=workdir, check=True, capture_output=True
        )
        subprocess.run(
            ["git", "remote", "add", "origin", "https://example.test/repo.git"],
            cwd=workdir,
            check=True,
            capture_output=True,
        )

        # Resolve absolute path to bash before sanitizing PATH. The child sees
        # the sanitized PATH; the parent invokes bash by absolute path so it
        # doesn't matter what the parent's PATH contains.
        bash_path = shutil.which("bash")
        assert bash_path, "bash must be on PATH for this test"

        # Build a fake-bin with symlinks to every external binary record_run.sh
        # invokes -- but NOT `timeout`. The script's `command -v timeout` will
        # return empty under this PATH, exercising the bare-git fallback.
        fake_bin = tmp_path / "fake_bin"
        fake_bin.mkdir()
        required_tools = ["bash", "jq", "git", "date", "mkdir", "dirname"]
        for tool in required_tools:
            src = shutil.which(tool)
            if src is None:
                import pytest
                pytest.skip(f"required tool {tool!r} not on PATH; cannot isolate timeout")
            os.symlink(src, fake_bin / tool)

        # Sanity check: timeout must NOT be reachable via fake_bin.
        assert shutil.which("timeout", path=str(fake_bin)) is None, (
            "fake_bin unexpectedly resolves `timeout`"
        )

        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_RUN_ID": "test-no-timeout",
            "CLOSEDLOOP_COMMAND": "feature",
            "CLOSEDLOOP_WORKDIR": str(workdir),
            "PATH": str(fake_bin),
        }
        result = subprocess.run(
            [bash_path, str(SCRIPT_PATH), str(workdir)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, f"Script failed: {result.stderr!r}"
        record = json.loads((workdir / "perf.jsonl").read_text().strip())
        assert record["repo"] == "https://example.test/repo.git", (
            f"repo should be captured when timeout unavailable, got: {record['repo']!r}"
        )


class TestRecordRunFailOpen:
    """Tests that record_run.sh fails open (exits 0, no stderr) on error conditions (T-4.2 / AC-003)."""

    def test_exits_zero_when_git_fails(self, tmp_path: Path) -> None:
        """Script exits 0 and produces no stderr when git commands exit non-zero.

        A fake git binary that always exits 1 is prepended to PATH so both
        `git remote get-url origin` and `git rev-parse --abbrev-ref HEAD` fail.
        The script must still write a valid perf.jsonl and exit 0.
        """
        # Create a fake git that always exits 1 with no output
        fake_bin = tmp_path / "fake_bin"
        fake_bin.mkdir()
        fake_git = fake_bin / "git"
        fake_git.write_text("#!/bin/bash\nexit 1\n")
        fake_git.chmod(0o755)

        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_RUN_ID": "test-run-git-fail",
            "CLOSEDLOOP_COMMAND": "feature",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
        }
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, (
            f"Script should exit 0 even when git fails, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )
        assert result.stderr == "", (
            f"Script should produce no stderr when git fails, got: {result.stderr!r}"
        )

    def test_git_fail_still_writes_perf_jsonl(self, tmp_path: Path) -> None:
        """Script still writes perf.jsonl with valid JSON when git commands fail."""
        fake_bin = tmp_path / "fake_bin"
        fake_bin.mkdir()
        fake_git = fake_bin / "git"
        fake_git.write_text("#!/bin/bash\nexit 1\n")
        fake_git.chmod(0o755)

        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_RUN_ID": "test-run-git-fail",
            "CLOSEDLOOP_COMMAND": "feature",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
        }
        subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        perf_file = tmp_path / "perf.jsonl"
        assert perf_file.exists(), "perf.jsonl should still be written when git fails"
        record = json.loads(perf_file.read_text().strip())
        assert record.get("event") == "run"
        assert record.get("repo") == "", "repo should be empty string when git fails"
        assert record.get("branch") == "", "branch should be empty string when git fails"

    def test_exits_zero_with_missing_run_id_no_stderr(self, tmp_path: Path) -> None:
        """Script exits 0 and produces no stderr when CLOSEDLOOP_RUN_ID is unset."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
        }
        env.pop("CLOSEDLOOP_RUN_ID", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, (
            f"Script should exit 0 when CLOSEDLOOP_RUN_ID is missing, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )
        assert result.stderr == "", (
            f"Script should produce no stderr when CLOSEDLOOP_RUN_ID is missing, got: {result.stderr!r}"
        )

    def test_exits_zero_with_missing_command_no_stderr(self, tmp_path: Path) -> None:
        """Script exits 0 and produces no stderr when CLOSEDLOOP_COMMAND is unset."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
        }
        env.pop("CLOSEDLOOP_COMMAND", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, (
            f"Script should exit 0 when CLOSEDLOOP_COMMAND is missing, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )
        assert result.stderr == "", (
            f"Script should produce no stderr when CLOSEDLOOP_COMMAND is missing, got: {result.stderr!r}"
        )

    def test_exits_zero_with_all_env_vars_missing_no_stderr(self, tmp_path: Path) -> None:
        """Script exits 0 and produces no stderr when all optional env vars are unset."""
        env = {
            **os.environ,
            "CLOSEDLOOP_PERF_V2": "1",
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
        }
        env.pop("CLOSEDLOOP_RUN_ID", None)
        env.pop("CLOSEDLOOP_COMMAND", None)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        assert result.returncode == 0, (
            f"Script should exit 0 with all optional env vars missing, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )
        assert result.stderr == "", (
            f"Script should produce no stderr with all optional env vars missing, got: {result.stderr!r}"
        )
