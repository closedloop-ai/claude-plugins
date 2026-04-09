
"""Tests for discover-repos.sh path handling."""

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent.parent / "scripts" / "discover-repos.sh"


def run_discover(project_root: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
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
    env.pop("CLAUDE_WORKSPACE_REPOS", None)
    env.update(extra_env)
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
    (current / ".closedloop-ai").mkdir()
    (current / ".closedloop-ai" / ".repo-identity.json").write_text(
        '{"name":"current","type":"service"}'
    )

    sibling = parent / "peer-repo"
    sibling.mkdir()
    (sibling / ".closedloop-ai").mkdir()
    (sibling / ".closedloop-ai" / ".repo-identity.json").write_text(
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
        (repo / ".closedloop-ai").mkdir(exist_ok=True)
        (repo / ".closedloop-ai" / ".repo-identity.json").write_text(
            json.dumps(identity)
        )
    return repo


# ---------------------------------------------------------------------------
# Tier 0 harness: scenarios are declarative — one test drives them all.
#
# Each Tier0Scenario builds a set of repos under a temp dir, runs
# discover-repos.sh with CLOSEDLOOP_ADD_DIRS derived from scenario keys, and
# validates the peer list against declarative PeerExpect entries.
# ---------------------------------------------------------------------------


# Sentinel used in `add_dir_keys` to reference the current repo's own path.
_CURRENT = "__current__"


@dataclass(frozen=True)
class RepoSpec:
    """Declarative description of a repo to create on disk for a scenario."""

    key: str                         # identifier used to reference the repo within the scenario
    dirname: str                     # directory name under the scenario root
    identity: dict | None = None     # contents of .closedloop-ai/.repo-identity.json, or None to skip
    is_current: bool = False         # exactly one RepoSpec per scenario must set this


@dataclass(frozen=True)
class PeerExpect:
    """Declarative assertion over a peer entry in the discover-repos.sh output."""

    key: str                         # references a RepoSpec.key in the same scenario
    count: int = 1                   # expected number of peer entries with this repo's path
    discovery_method: str | None = None
    name: str | None = None
    type: str | None = None


@dataclass(frozen=True)
class Tier0Scenario:
    id: str
    repos: tuple[RepoSpec, ...]
    add_dir_keys: tuple[str, ...]    # repo keys (or _CURRENT) to join into CLOSEDLOOP_ADD_DIRS
    workspace_subdir: bool = False   # place repos under tmp_path/workspace/ (enables Tier 2 sibling scan)
    expect_peers: tuple[PeerExpect, ...] = field(default_factory=tuple)
    forbidden_keys: tuple[str, ...] = field(default_factory=tuple)  # repo keys that must NOT appear as peers


TIER0_SCENARIOS: tuple[Tier0Scenario, ...] = (
    Tier0Scenario(
        id="add_dir_appears_in_peers",
        repos=(
            RepoSpec("current", "current", is_current=True),
            RepoSpec("extra", "extra", identity={"name": "extra-svc", "type": "service"}),
        ),
        add_dir_keys=("extra",),
        expect_peers=(
            PeerExpect("extra", discovery_method="add_dir", name="extra-svc", type="service"),
        ),
    ),
    Tier0Scenario(
        id="basename_fallback_without_identity",
        repos=(
            RepoSpec("current", "current", is_current=True),
            RepoSpec("anon", "my-anon-repo"),  # no identity → name falls back to basename
        ),
        add_dir_keys=("anon",),
        expect_peers=(PeerExpect("anon", name="my-anon-repo"),),
    ),
    Tier0Scenario(
        id="multiple_add_dirs_pipe_separated",
        repos=(
            RepoSpec("current", "current", is_current=True),
            RepoSpec("a", "repo-a"),
            RepoSpec("b", "repo-b"),
        ),
        add_dir_keys=("a", "b"),
        expect_peers=(PeerExpect("a"), PeerExpect("b")),
    ),
    Tier0Scenario(
        id="skips_current_repo",
        repos=(RepoSpec("current", "current", is_current=True),),
        add_dir_keys=(_CURRENT,),
        forbidden_keys=("current",),
    ),
    # A sibling that is ALSO listed in CLOSEDLOOP_ADD_DIRS must appear exactly
    # once AND be marked `add_dir` (Tier 0 wins over Tier 2 sibling scan).
    Tier0Scenario(
        id="add_dir_wins_over_sibling_scan",
        workspace_subdir=True,
        repos=(
            RepoSpec("current", "current", identity={"name": "current", "type": "service"}, is_current=True),
            RepoSpec(
                "sibling",
                "sibling-svc",
                identity={"name": "sibling-svc", "type": "library", "discoverable": True},
            ),
        ),
        add_dir_keys=("sibling",),
        expect_peers=(PeerExpect("sibling", count=1, discovery_method="add_dir"),),
    ),
)


@pytest.mark.parametrize("scenario", TIER0_SCENARIOS, ids=lambda s: s.id)
def test_tier0_add_dirs(tmp_path: Path, scenario: Tier0Scenario) -> None:
    """Drives every Tier 0 scenario through a single harness.

    Build repos, invoke discover-repos.sh with the scenario's CLOSEDLOOP_ADD_DIRS,
    then validate peer count and per-field attributes declaratively.
    """
    # 1. Materialize repos on disk
    root = tmp_path / "workspace" if scenario.workspace_subdir else tmp_path
    paths: dict[str, Path] = {
        spec.key: _make_repo(root, spec.dirname, spec.identity) for spec in scenario.repos
    }
    current_specs = [s for s in scenario.repos if s.is_current]
    assert len(current_specs) == 1, f"Scenario {scenario.id!r} must declare exactly one current repo"
    current_path = paths[current_specs[0].key]

    # 2. Build CLOSEDLOOP_ADD_DIRS, resolving _CURRENT sentinel against the current repo
    def _resolve(key: str) -> Path:
        return current_path if key == _CURRENT else paths[key]

    add_dirs = "|".join(str(_resolve(k)) for k in scenario.add_dir_keys)

    # 3. Invoke the script
    result = _run_discover_with_env(current_path, {"CLOSEDLOOP_ADD_DIRS": add_dirs})
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    peers = payload["peers"]

    # 4. Forbidden paths must not appear at all
    peer_paths = [p["path"] for p in peers]
    for key in scenario.forbidden_keys:
        forbidden = str(paths[key])
        assert forbidden not in peer_paths, (
            f"[{scenario.id}] {key!r} should not appear in peers; got: {peer_paths}"
        )

    # 5. Each expectation: check occurrence count and per-field attributes
    for exp in scenario.expect_peers:
        target = str(paths[exp.key])
        matches = [p for p in peers if p["path"] == target]
        assert len(matches) == exp.count, (
            f"[{scenario.id}] expected {exp.count} peer(s) for {exp.key!r}, "
            f"got {len(matches)}; peers={peers}"
        )
        if exp.count == 0:
            continue
        peer = matches[0]
        for attr, field_name in (
            (exp.discovery_method, "discoveryMethod"),
            (exp.name, "name"),
            (exp.type, "type"),
        ):
            if attr is not None:
                assert peer.get(field_name) == attr, (
                    f"[{scenario.id}] peer {exp.key!r} {field_name}: "
                    f"expected {attr!r}, got {peer.get(field_name)!r}"
                )
