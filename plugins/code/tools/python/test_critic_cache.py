"""Tests for critic-cache script path resolution."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parent.parent.parent
    / "skills"
    / "critic-cache"
    / "scripts"
    / "check_critic_cache.sh"
)


def _run(workdir: Path, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), str(workdir)],
        capture_output=True,
        text=True,
        cwd=str(cwd),
        timeout=10,
    )


def _hash(plan: str, gates: str | None = None) -> str:
    h = hashlib.sha256()
    h.update(plan.encode())
    if gates is not None:
        h.update(gates.encode())
    return h.hexdigest()


def test_uses_closedloop_ai_critic_gates_in_hash(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    workdir = project_root / ".closedloop-ai" / "work"
    reviews_dir = workdir / "reviews"
    settings_dir = project_root / ".closedloop-ai" / "settings"
    reviews_dir.mkdir(parents=True)
    settings_dir.mkdir(parents=True)

    plan = '{"tasks":["T-1"]}'
    gates = '{"defaults":{"baseCritics":["security-privacy"]}}'
    (workdir / "plan.json").write_text(plan)
    (settings_dir / "critic-gates.json").write_text(gates)
    (reviews_dir / "security-privacy.review.json").write_text('{}')
    (reviews_dir / ".plan-hash").write_text(_hash(plan, gates) + "\n")

    result = _run(workdir, project_root)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == "CRITIC_CACHE_HIT"


def test_misses_when_closedloop_ai_critic_gates_change(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    workdir = project_root / ".closedloop-ai" / "work"
    reviews_dir = workdir / "reviews"
    settings_dir = project_root / ".closedloop-ai" / "settings"
    reviews_dir.mkdir(parents=True)
    settings_dir.mkdir(parents=True)

    plan = '{"tasks":["T-1"]}'
    old_gates = '{"defaults":{"baseCritics":["security-privacy"]}}'
    new_gates = '{"defaults":{"baseCritics":["security-privacy","test-strategist"]}}'
    (workdir / "plan.json").write_text(plan)
    (settings_dir / "critic-gates.json").write_text(new_gates)
    (reviews_dir / "security-privacy.review.json").write_text('{}')
    (reviews_dir / ".plan-hash").write_text(_hash(plan, old_gates) + "\n")

    result = _run(workdir, project_root)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == "CRITIC_CACHE_MISS"
    assert "critic-gates.json changed" in result.stdout
