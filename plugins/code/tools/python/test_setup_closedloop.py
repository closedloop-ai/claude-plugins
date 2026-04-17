"""Tests for setup-closedloop.sh script."""

import os
import subprocess
from pathlib import Path

import pytest
from conftest import CLOSEDLOOP_STATE_DIR

SETUP_SCRIPT = Path(__file__).parent.parent.parent / "scripts" / "setup-closedloop.sh"


@pytest.fixture
def tmp_workdir(tmp_path: Path) -> Path:
    """Create a workdir subdirectory inside tmp_path and return it.

    Using a subdirectory (not tmp_path itself) keeps sibling directories like
    extra-repo outside the workdir tree, which matters for the subdirectory
    containment check in setup-closedloop.sh.
    """
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "plan.md").write_text("# Plan\n\nTask T-1.1: Do something\n")
    return workdir


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
    assert (
        f"CLOSEDLOOP_PLAN_FILE={str(plan_file)!r}" in result.stdout
        or f'CLOSEDLOOP_PLAN_FILE="{plan_file}"' in result.stdout
    )


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
    result = _run_setup_in_workdir(
        tmp_workdir, "--plan", "plan.md", cwd=str(tmp_workdir)
    )

    assert result.returncode == 0
    # Extract the CLOSEDLOOP_PLAN_FILE value from stdout
    for line in result.stdout.splitlines():
        if line.startswith("CLOSEDLOOP_PLAN_FILE="):
            value = line.split("=", 1)[1].strip('"')
            assert value.startswith("/"), f"Expected absolute path, got: {value!r}"
            break
    else:
        pytest.fail("CLOSEDLOOP_PLAN_FILE not found in stdout")


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
        (
            line
            for line in result.stdout.splitlines()
            if line.startswith("CLOSEDLOOP_PLAN_FILE=")
        ),
        None,
    )
    assert plan_line is not None
    plan_value = plan_line.split("=", 1)[1].strip('"')
    assert plan_value != "", "CLOSEDLOOP_PLAN_FILE should be non-empty"

    # PRD_FILE should be empty (not auto-discovered)
    assert 'CLOSEDLOOP_PRD_FILE=""' in result.stdout


def test_writes_session_mapping_from_closedloop_pid_file(tmp_workdir: Path) -> None:
    """Should create a workdir mapping when a `.closedloop-ai` PID mapping exists."""
    session_dir = tmp_workdir / CLOSEDLOOP_STATE_DIR
    session_dir.mkdir(parents=True)
    session_id = "session-from-closedloop"
    result = subprocess.run(
        [
            "bash",
            "-c",
            f'echo "{session_id}" > "{session_dir}/pid-$$.session"; '
            f'exec bash "{SETUP_SCRIPT}" "{tmp_workdir}"',
        ],
        capture_output=True,
        text=True,
        cwd=str(tmp_workdir),
    )

    assert result.returncode == 0
    assert (session_dir / f"session-{session_id}.workdir").read_text().strip() == str(tmp_workdir.resolve())


def test_ignores_legacy_pid_mapping(tmp_workdir: Path) -> None:
    """Should not use legacy `.claude/.closedloop` PID mappings."""
    legacy_dir = tmp_workdir / ".claude" / ".closedloop"
    legacy_dir.mkdir(parents=True)
    session_id = "legacy-session"
    (legacy_dir / f"pid-{os.getpid()}.session").write_text(session_id)

    result = _run_setup_in_workdir(tmp_workdir)

    assert result.returncode == 0
    assert not (
        tmp_workdir / CLOSEDLOOP_STATE_DIR / f"session-{session_id}.workdir"
    ).exists()


# ---------------------------------------------------------------------------
# --add-dir tests
# ---------------------------------------------------------------------------


@pytest.fixture
def extra_repo(tmp_path: Path) -> Path:
    """Create a minimal extra repo directory for --add-dir tests."""
    repo = tmp_path / "extra-repo"
    repo.mkdir()
    return repo


def _config_env(workdir: Path) -> str:
    """Return the contents of .closedloop-ai/config.env written by the script."""
    return (workdir / CLOSEDLOOP_STATE_DIR / "config.env").read_text()


def _config_value(config: str, key: str) -> str:
    """Extract a quoted config.env value by key."""
    prefix = f"{key}="
    for line in config.splitlines():
        if line.startswith(prefix):
            return line.split("=", 1)[1].strip('"')
    pytest.fail(f"{key} not found in config")


def test_add_dir_nonexistent_path_fails(tmp_workdir: Path) -> None:
    """Should exit non-zero when --add-dir path does not exist."""
    result = _run_setup_in_workdir(
        tmp_workdir, "--add-dir", "/nonexistent/path/does/not/exist"
    )

    assert result.returncode != 0
    assert "does not exist" in result.stderr or "not a directory" in result.stderr


def test_add_dir_writes_closedloop_add_dirs_to_config(
    tmp_workdir: Path, extra_repo: Path
) -> None:
    """config.env must contain CLOSEDLOOP_ADD_DIRS with the resolved absolute path."""
    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", str(extra_repo))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert str(extra_repo) in config
    assert "CLOSEDLOOP_ADD_DIRS=" in config


def test_add_dir_writes_closedloop_repo_map_to_config(
    tmp_workdir: Path, extra_repo: Path
) -> None:
    """config.env must contain CLOSEDLOOP_REPO_MAP in name=path format."""
    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", str(extra_repo))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert "CLOSEDLOOP_REPO_MAP=" in config
    assert f"extra-repo={extra_repo}" in config


def test_add_dir_uses_identity_file_name(tmp_workdir: Path, tmp_path: Path) -> None:
    """Should use .closedloop-ai/.repo-identity.json name field when present."""
    named_repo = tmp_path / "some-dir"
    named_repo.mkdir()
    (named_repo / CLOSEDLOOP_STATE_DIR).mkdir()
    (named_repo / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
        '{"name": "my-custom-name", "type": "service"}'
    )

    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", str(named_repo))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert "my-custom-name" in config


def test_multiple_add_dirs_produces_pipe_joined_values(
    tmp_workdir: Path, tmp_path: Path
) -> None:
    """Multiple --add-dir flags should produce pipe-separated values in config.env."""
    repo_a = tmp_path / "repo-a"
    repo_b = tmp_path / "repo-b"
    repo_a.mkdir()
    repo_b.mkdir()

    result = _run_setup_in_workdir(
        tmp_workdir, "--add-dir", str(repo_a), "--add-dir", str(repo_b)
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    # Both paths should appear; they should be pipe-separated
    assert str(repo_a) in config
    assert str(repo_b) in config
    # Find the CLOSEDLOOP_ADD_DIRS line and verify pipe separator
    add_dirs_line = next(
        line for line in config.splitlines() if line.startswith("CLOSEDLOOP_ADD_DIRS=")
    )
    assert "|" in add_dirs_line, f"Expected pipe separator in: {add_dirs_line!r}"


def test_add_dir_ignores_duplicate_resolved_repo_path(
    tmp_workdir: Path, extra_repo: Path
) -> None:
    """The same resolved repo path should only appear once in config.env."""
    result = _run_setup_in_workdir(
        tmp_workdir, "--add-dir", str(extra_repo), "--add-dir", str(extra_repo)
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIRS") == str(extra_repo)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES") == "extra-repo"
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == f"extra-repo={extra_repo}"


def test_add_dir_ignores_primary_workdir_path(tmp_workdir: Path) -> None:
    """The primary workdir must never be re-published as a secondary repo."""
    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", ".", cwd=str(tmp_workdir))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIRS") == ""
    assert _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES") == ""
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == ""


def test_add_dir_makes_identity_name_collisions_unique(
    tmp_workdir: Path, tmp_path: Path
) -> None:
    """Distinct repos with the same identity name should get different repo keys."""
    repo_a = tmp_path / "repo-a"
    repo_b = tmp_path / "repo-b"
    repo_a.mkdir()
    repo_b.mkdir()
    (repo_a / CLOSEDLOOP_STATE_DIR).mkdir()
    (repo_b / CLOSEDLOOP_STATE_DIR).mkdir()
    (repo_a / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
        '{"name": "service"}'
    )
    (repo_b / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
        '{"name": "service"}'
    )

    result = _run_setup_in_workdir(
        tmp_workdir, "--add-dir", str(repo_a), "--add-dir", str(repo_b)
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    add_dir_names = _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES").split("|")
    assert add_dir_names == ["service", "service-repo-b"]
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == (
        f"service={repo_a}|service-repo-b={repo_b}"
    )


def test_add_dir_makes_basename_collisions_unique(
    tmp_workdir: Path, tmp_path: Path
) -> None:
    """Distinct repos with the same basename should get different repo keys."""
    repo_a = tmp_path / "group-a" / "service"
    repo_b = tmp_path / "group-b" / "service"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)

    result = _run_setup_in_workdir(
        tmp_workdir, "--add-dir", str(repo_a), "--add-dir", str(repo_b)
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    add_dir_names = _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES").split("|")
    assert add_dir_names == ["service", "service-group-b"]
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == (
        f"service={repo_a}|service-group-b={repo_b}"
    )


def test_add_dir_makes_name_collision_with_primary_repo_unique(
    tmp_workdir: Path, tmp_path: Path
) -> None:
    """A secondary repo key must not collide with the primary repo identifier."""
    primary_name = tmp_workdir.name
    repo_with_same_name = tmp_path / "secondary-parent" / primary_name
    repo_with_same_name.mkdir(parents=True)

    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", str(repo_with_same_name))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    add_dir_names = _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES").split("|")
    assert add_dir_names == [f"{primary_name}-secondary-parent"]
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == (
        f"{primary_name}-secondary-parent={repo_with_same_name}"
    )


def test_add_dir_uses_base_prompt(tmp_workdir: Path, extra_repo: Path) -> None:
    """--add-dir no longer selects a special prompt — the base prompt.md is used
    and the agents consume CLOSEDLOOP_REPO_MAP directly."""
    result = _run_setup_in_workdir(tmp_workdir, "--add-dir", str(extra_repo))

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    prompt_line = next(
        line
        for line in config.splitlines()
        if line.startswith("CLOSEDLOOP_PROMPT_FILE=")
    )
    assert prompt_line.endswith('prompts/prompt.md"'), (
        f"Expected direct base prompt.md but got: {prompt_line!r}"
    )


def test_add_dir_ignores_ancestor_of_workdir(tmp_path: Path) -> None:
    """An --add-dir that is a parent of workdir must be filtered out."""
    parent_repo = tmp_path / "parent-repo"
    parent_repo.mkdir()
    workdir = parent_repo / CLOSEDLOOP_STATE_DIR / "work"
    workdir.mkdir(parents=True)
    (workdir / "prd.md").write_text("# PRD\n")

    result = _run_setup_in_workdir(workdir, "--add-dir", str(parent_repo))

    assert result.returncode == 0, result.stderr
    config = _config_env(workdir)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIRS") == ""
    assert _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES") == ""
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == ""


def test_add_dir_dot_from_repo_root_with_nested_workdir_empty_canonical(
    tmp_path: Path,
) -> None:
    """run-loop style: workdir at repo/.closedloop-ai/work, `--add-dir .` from repo root.

    Canonical secondary repos must be empty: repo root is filtered as ancestor of workdir.
    """
    project = tmp_path / "repo"
    workdir = project / CLOSEDLOOP_STATE_DIR / "work"
    workdir.mkdir(parents=True)
    (workdir / "prd.md").write_text("# PRD\n")

    result = _run_setup_in_workdir(workdir, "--add-dir", ".", cwd=str(project))

    assert result.returncode == 0, result.stderr
    config = _config_env(workdir)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIRS") == ""
    assert _config_value(config, "CLOSEDLOOP_ADD_DIR_NAMES") == ""
    assert _config_value(config, "CLOSEDLOOP_REPO_MAP") == ""


def test_no_add_dir_config_env_has_empty_add_dirs(tmp_workdir: Path) -> None:
    """When no --add-dir is given, config.env must contain empty CLOSEDLOOP_ADD_DIRS."""
    result = _run_setup_in_workdir(tmp_workdir)

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert 'CLOSEDLOOP_ADD_DIRS=""' in config
    assert 'CLOSEDLOOP_ADD_DIR_NAMES=""' in config
    assert 'CLOSEDLOOP_REPO_MAP=""' in config


def test_reconstructs_split_workdir_and_prd_paths_with_spaces(tmp_path: Path) -> None:
    """Handles unquoted split tokens for workdir/--prd paths that contain spaces."""
    project_root = tmp_path / "AI Platform" / "ai-matching-platform-loop-pln-2"
    workdir = project_root / CLOSEDLOOP_STATE_DIR / "work"
    workdir.mkdir(parents=True)
    prd = workdir / "prd.md"
    prd.write_text("# PRD\n\nRequirements here\n")

    result = subprocess.run(
        [
            "bash",
            str(SETUP_SCRIPT),
            *str(workdir).split(" "),
            "--prd",
            *str(prd).split(" "),
        ],
        capture_output=True,
        text=True,
        cwd=str(project_root),
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(workdir)
    assert _config_value(config, "CLOSEDLOOP_WORKDIR") == str(workdir.resolve())
    assert _config_value(config, "CLOSEDLOOP_PRD_FILE") == str(prd.resolve())


def test_reconstructs_split_add_dir_path_with_spaces(
    tmp_workdir: Path, tmp_path: Path
) -> None:
    """Handles unquoted split tokens for --add-dir paths that contain spaces."""
    extra_repo = tmp_path / "peer repo"
    extra_repo.mkdir()

    result = subprocess.run(
        [
            "bash",
            str(SETUP_SCRIPT),
            str(tmp_workdir),
            "--add-dir",
            *str(extra_repo).split(" "),
        ],
        capture_output=True,
        text=True,
        cwd=str(tmp_workdir),
    )

    assert result.returncode == 0, result.stderr
    config = _config_env(tmp_workdir)
    assert _config_value(config, "CLOSEDLOOP_ADD_DIRS") == str(extra_repo.resolve())
