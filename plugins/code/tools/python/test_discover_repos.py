
"""Tests for discover-repos.sh path handling."""

import json
import subprocess
from pathlib import Path

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
