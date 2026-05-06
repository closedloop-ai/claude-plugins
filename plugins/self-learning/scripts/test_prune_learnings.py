import os
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).with_name("prune-learnings.sh")


def test_prune_syncs_runs_log_from_workdir_root(tmp_path: Path) -> None:
    workdir = tmp_path / "workdir"
    (workdir / ".learnings" / "sessions" / "run-keep").mkdir(parents=True)
    (workdir / "runs.log").write_text(
        "keep|2026-05-05T00:00:00Z|reduce-failures|1|completed|plan_execute|session-1\n"
        "drop|2026-05-05T00:00:00Z|reduce-failures|2|error|plan_execute|session-2\n"
    )

    result = subprocess.run(
        ["bash", str(SCRIPT)],
        env={**os.environ, "CLOSEDLOOP_WORKDIR": str(workdir)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (workdir / "runs.log").read_text() == (
        "keep|2026-05-05T00:00:00Z|reduce-failures|1|completed|plan_execute|session-1\n"
    )
    assert not (workdir / ".learnings" / "runs.log").exists()
