"""Tests for run_judges_if_needed behavior with the imported-plan marker."""

import json
import subprocess
from pathlib import Path

HELPER_SCRIPT = Path(__file__).resolve().parent / "run_judges_test_helper.sh"


def run_helper(workdir: Path) -> subprocess.CompletedProcess:
    """Invoke the test helper with the given workdir."""
    return subprocess.run(
        ["bash", str(HELPER_SCRIPT), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
    )


class TestImportedPlanMarker:
    """Tests for the .closedloop/imported-plan marker behavior in run_judges_if_needed."""

    def test_imported_plan_marker_skips_plan_judges(self, tmp_path: Path) -> None:
        """Imported-plan marker present with no judges.json should skip plan judges."""
        workdir = tmp_path / "workdir"
        workdir.mkdir()

        # Setup: plan.json + imported-plan marker, no judges.json, no prd.md
        (workdir / "plan.json").write_text(json.dumps({"tasks": []}))
        closedloop_dir = workdir / ".closedloop"
        closedloop_dir.mkdir()
        (closedloop_dir / "imported-plan").touch()

        result = run_helper(workdir)

        assert result.returncode == 0, f"Helper exited with {result.returncode}: {result.stderr}"
        assert "imported-plan marker" in result.stdout, (
            f"Expected 'imported-plan marker' in stdout but got: {result.stdout!r}"
        )
        assert not (workdir / "judges.json").exists(), (
            "judges.json should NOT be created when imported-plan marker is present"
        )

    def test_imported_plan_marker_allows_code_judges(self, tmp_path: Path) -> None:
        """Imported-plan marker with existing judges.json and code changes runs code judges."""
        workdir = tmp_path / "workdir"
        workdir.mkdir()

        # Setup: plan.json + imported-plan marker + judges.json + changed-files with run-loop.sh
        (workdir / "plan.json").write_text(json.dumps({"tasks": []}))
        closedloop_dir = workdir / ".closedloop"
        closedloop_dir.mkdir()
        (closedloop_dir / "imported-plan").touch()
        (workdir / "judges.json").write_text(json.dumps({"verdict": "pass"}))
        learnings_dir = workdir / ".learnings"
        learnings_dir.mkdir()
        (learnings_dir / "changed-files.json").write_text(
            json.dumps(["plugins/code/scripts/run-loop.sh"])
        )

        result = run_helper(workdir)

        assert result.returncode == 0, f"Helper exited with {result.returncode}: {result.stderr}"
        assert "code_judges" in result.stdout, (
            f"Expected 'code_judges' in stdout but got: {result.stdout!r}"
        )

    def test_no_marker_no_prd_skips_plan_judges(self, tmp_path: Path) -> None:
        """Without imported-plan marker and without prd.md, plan judges are skipped."""
        workdir = tmp_path / "workdir"
        workdir.mkdir()

        # Setup: plan.json only -- no imported-plan marker, no judges.json, no prd.md
        (workdir / "plan.json").write_text(json.dumps({"tasks": []}))

        result = run_helper(workdir)

        assert result.returncode == 0, f"Helper exited with {result.returncode}: {result.stderr}"
        assert "prd.md missing" in result.stdout, (
            f"Expected 'prd.md missing' in stdout but got: {result.stdout!r}"
        )
        assert not (workdir / "judges.json").exists(), (
            "judges.json should NOT be created when prd.md is missing"
        )
