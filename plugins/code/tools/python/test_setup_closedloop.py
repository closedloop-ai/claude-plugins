"""Tests for setup-closedloop.sh script."""

import subprocess
from pathlib import Path

import pytest

SETUP_SCRIPT = Path(__file__).parent.parent.parent / "scripts" / "setup-closedloop.sh"


@pytest.fixture
def tmp_workdir(tmp_path: Path) -> Path:
    """Write a plan.md file to tmp_path and return it."""
    (tmp_path / "plan.md").write_text("# Plan\n\nTask T-1.1: Do something\n")
    return tmp_path


def run_setup(*extra_args: str, cwd: str | None = None) -> subprocess.CompletedProcess:
    """Run setup-closedloop.sh with the given extra arguments."""
    workdir = cwd or str(extra_args[0]) if extra_args else "."
    return subprocess.run(
        ["bash", str(SETUP_SCRIPT), workdir, *extra_args],
        capture_output=True,
        text=True,
        cwd=cwd or workdir,
    )


def _run_setup_in_workdir(
    workdir: Path, *extra_args: str, cwd: str | None = None
) -> subprocess.CompletedProcess:
    """Run setup-closedloop.sh with workdir as first arg plus extra args."""
    return subprocess.run(
        ["bash", str(SETUP_SCRIPT), str(workdir), *extra_args],
        capture_output=True,
        text=True,
        cwd=cwd or str(workdir),
    )


def test_plan_arg_valid_file(tmp_workdir: Path) -> None:
    """Should succeed when --plan points to an existing file."""
    plan_file = tmp_workdir / "plan.md"
    result = _run_setup_in_workdir(tmp_workdir, "--plan", str(plan_file))

    assert result.returncode == 0
    assert f"CLOSEDLOOP_PLAN_FILE={str(plan_file)!r}" in result.stdout or \
        f'CLOSEDLOOP_PLAN_FILE="{plan_file}"' in result.stdout


def test_plan_arg_nonexistent_file(tmp_workdir: Path) -> None:
    """Should fail when --plan points to a nonexistent file."""
    result = _run_setup_in_workdir(tmp_workdir, "--plan", "/nonexistent/plan.md")

    assert result.returncode != 0
    assert "not found" in result.stderr.lower()


def test_plan_and_prd_mutually_exclusive(tmp_workdir: Path) -> None:
    """Should fail when both --plan and --prd are specified."""
    plan = tmp_workdir / "plan.md"
    prd = tmp_workdir / "prd.md"
    prd.write_text("# PRD\n\nRequirements here\n")

    result = _run_setup_in_workdir(tmp_workdir, "--plan", str(plan), "--prd", str(prd))

    assert result.returncode != 0
    assert "mutually exclusive" in result.stderr


def test_plan_relative_path_resolves_to_absolute(tmp_workdir: Path) -> None:
    """Should resolve a relative --plan path to an absolute path in config output."""
    result = _run_setup_in_workdir(tmp_workdir, "--plan", "plan.md", cwd=str(tmp_workdir))

    assert result.returncode == 0
    # Extract the CLOSEDLOOP_PLAN_FILE value from stdout
    for line in result.stdout.splitlines():
        if line.startswith("CLOSEDLOOP_PLAN_FILE="):
            value = line.split("=", 1)[1].strip('"')
            assert value.startswith("/"), (
                f"Expected absolute path, got: {value!r}"
            )
            break
    else:
        pytest.fail("CLOSEDLOOP_PLAN_FILE not found in stdout")


def test_plan_missing_value_exits_error(tmp_workdir: Path) -> None:
    """Should fail when --plan flag is given with no following value."""
    result = _run_setup_in_workdir(tmp_workdir, "--plan")

    assert result.returncode != 0


def test_plan_skips_prd_autodiscovery(tmp_workdir: Path) -> None:
    """Should not auto-discover prd.md when --plan is specified."""
    # Write a prd.md that would normally be auto-discovered
    (tmp_workdir / "prd.md").write_text("# PRD\n\nRequirements here\n")
    plan_file = tmp_workdir / "plan.md"

    result = _run_setup_in_workdir(tmp_workdir, "--plan", str(plan_file))

    assert result.returncode == 0
    # PLAN_FILE should be non-empty
    assert "CLOSEDLOOP_PLAN_FILE=" in result.stdout
    plan_line = next(
        (line for line in result.stdout.splitlines() if line.startswith("CLOSEDLOOP_PLAN_FILE=")),
        None,
    )
    assert plan_line is not None
    plan_value = plan_line.split("=", 1)[1].strip('"')
    assert plan_value != "", "CLOSEDLOOP_PLAN_FILE should be non-empty"

    # PRD_FILE should be empty (not auto-discovered)
    assert 'CLOSEDLOOP_PRD_FILE=""' in result.stdout
