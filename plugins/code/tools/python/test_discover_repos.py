"""Tests for discover-repos.sh path handling."""

import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import CLOSEDLOOP_STATE_DIR

SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent.parent / "scripts" / "discover-repos.sh"
)


def run_discover(
    project_root: Path, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    """Invoke discover-repos.sh for the given project root."""
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(project_root)],
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


def _run_discover_with_env(
    project_root: Path, extra_env: dict[str, str]
) -> subprocess.CompletedProcess:
    """Invoke discover-repos.sh with extra environment variables merged in."""
    env = {**os.environ, **extra_env}
    # Remove Tier 1 env var unless explicitly set by caller, to avoid test interference
    if "CLAUDE_WORKSPACE_REPOS" not in extra_env:
        env.pop("CLAUDE_WORKSPACE_REPOS", None)
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(project_root)],
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


def test_sibling_scan_uses_closedloop_repo_identity(tmp_path: Path) -> None:
    """Should discover siblings from `.closedloop-ai/.repo-identity.json` only."""
    parent = tmp_path / "workspace"
    current = parent / "current-repo"
    current.mkdir(parents=True)
    (current / CLOSEDLOOP_STATE_DIR).mkdir()
    (current / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
        '{"name":"current","type":"service"}'
    )

    sibling = parent / "peer-repo"
    sibling.mkdir()
    (sibling / CLOSEDLOOP_STATE_DIR).mkdir()
    (sibling / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
        '{"name":"peer","type":"library","discoverable":true}'
    )

    legacy = parent / "legacy-peer"
    (legacy / ".claude").mkdir(parents=True)
    (legacy / ".claude" / ".repo-identity.json").write_text(
        '{"name":"legacy","type":"library","discoverable":true}'
    )

    result = run_discover(current)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["currentRepo"]["name"] == "current"
    assert payload["discoveryMethod"] == "sibling_scan"
    assert payload["peers"] == [
        {"name": "peer", "type": "library", "path": str(sibling)}
    ]


# ---------------------------------------------------------------------------
# Tier 0: CLOSEDLOOP_ADD_DIRS tests
# ---------------------------------------------------------------------------


def _make_repo(parent: Path, name: str, identity: dict | None = None) -> Path:
    """Create a minimal repo directory, optionally with a .repo-identity.json."""
    repo = parent / name
    repo.mkdir(parents=True, exist_ok=True)
    if identity is not None:
        (repo / CLOSEDLOOP_STATE_DIR).mkdir(exist_ok=True)
        (repo / CLOSEDLOOP_STATE_DIR / ".repo-identity.json").write_text(
            json.dumps(identity)
        )
    return repo


# ---------------------------------------------------------------------------
# Tier 0 harness: each scenario is a plain dict. One parametrized test runs them.
#
#   repos:     {dirname: identity_or_None}  — first entry is the current repo
#   add_dirs:  list of dirnames to join into CLOSEDLOOP_ADD_DIRS (current repo allowed)
#   expect:    {dirname: {field: expected_value, ...}}  — peer must exist exactly once
#   forbidden: list of dirnames that must NOT appear as peers
#   workspace: True to nest repos under tmp_path/workspace/ (enables Tier 2 sibling scan)
# ---------------------------------------------------------------------------


TIER0_SCENARIOS: list[dict] = [
    {
        "id": "add_dir_appears_in_peers",
        "repos": {"current": None, "extra": {"name": "extra-svc", "type": "service"}},
        "add_dirs": ["extra"],
        "expect": {
            "extra": {
                "discoveryMethod": "add_dir",
                "name": "extra-svc",
                "type": "service",
            }
        },
    },
    {
        "id": "basename_fallback_without_identity",
        "repos": {"current": None, "my-anon-repo": None},
        "add_dirs": ["my-anon-repo"],
        "expect": {"my-anon-repo": {"name": "my-anon-repo"}},
    },
    {
        "id": "multiple_add_dirs_pipe_separated",
        "repos": {"current": None, "repo-a": None, "repo-b": None},
        "add_dirs": ["repo-a", "repo-b"],
        "expect": {"repo-a": {}, "repo-b": {}},
    },
    {
        "id": "skips_current_repo",
        "repos": {"current": None},
        "add_dirs": ["current"],
        "forbidden": ["current"],
    },
    # Sibling also listed in CLOSEDLOOP_ADD_DIRS must appear exactly once
    # and be marked `add_dir` (Tier 0 wins over Tier 2 sibling scan).
    {
        "id": "add_dir_wins_over_sibling_scan",
        "workspace": True,
        "repos": {
            "current": {"name": "current", "type": "service"},
            "sibling-svc": {
                "name": "sibling-svc",
                "type": "library",
                "discoverable": True,
            },
        },
        "add_dirs": ["sibling-svc"],
        "expect": {"sibling-svc": {"discoveryMethod": "add_dir"}},
    },
]


@pytest.mark.parametrize("scenario", TIER0_SCENARIOS, ids=lambda s: s["id"])
def test_tier0_add_dirs(tmp_path: Path, scenario: dict) -> None:
    """Build repos, run discover-repos.sh, assert peer list matches expectations."""
    root = tmp_path / "workspace" if scenario.get("workspace") else tmp_path
    paths = {
        name: _make_repo(root, name, ident) for name, ident in scenario["repos"].items()
    }
    current = next(
        iter(paths.values())
    )  # first entry is the current repo by convention

    add_dirs = "|".join(str(paths[d]) for d in scenario["add_dirs"])
    result = _run_discover_with_env(current, {"CLOSEDLOOP_ADD_DIRS": add_dirs})
    assert result.returncode == 0, result.stderr
    peers = json.loads(result.stdout)["peers"]
    by_path = {p["path"]: p for p in peers}

    for dirname in scenario.get("forbidden", []):
        assert str(paths[dirname]) not in by_path, (
            f"{dirname!r} must not appear in peers: {peers}"
        )

    peer_paths = [p["path"] for p in peers]
    for dirname, expected_fields in scenario.get("expect", {}).items():
        target = str(paths[dirname])
        assert peer_paths.count(target) == 1, (
            f"expected exactly one peer for {dirname!r}; peers={peers}"
        )
        peer = by_path[target]
        for field_name, value in expected_fields.items():
            assert peer.get(field_name) == value, (
                f"peer {dirname!r} {field_name}: expected {value!r}, got {peer.get(field_name)!r}"
            )
