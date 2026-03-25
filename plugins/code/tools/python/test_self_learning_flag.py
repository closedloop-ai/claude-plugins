"""Tests for --self-learning flag behavior in run-loop.sh (T-6.1)."""

import subprocess
import textwrap
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
RUN_LOOP_SH = SCRIPTS_DIR / "run-loop.sh"


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    """Create a minimal workdir with .closedloop/ directory."""
    (tmp_path / ".closedloop").mkdir()
    (tmp_path / ".learnings").mkdir()
    return tmp_path


def _awk_extract_script() -> str:
    """Return awk script to extract needed functions from run-loop.sh."""
    targets = [
        "emit_skipped_step",
        "log_progress",
        "create_state_file",
        "parse_frontmatter",
        "get_field",
        "get_prompt",
        "bootstrap_learnings",
        "run_background_pruning",
        "post_iteration_processing",
    ]
    func_pattern = "|".join(targets)
    return (
        f"/^readonly / {{ print; next }}\n"
        f"/^({func_pattern})[[:space:]]*\\(\\)/ {{ in_func=1; brace_depth=0 }}\n"
        f"in_func {{\n"
        f"    print\n"
        f"    for (i=1; i<=length($0); i++) {{\n"
        f"        c = substr($0, i, 1)\n"
        f'        if (c == "{{") brace_depth++\n'
        f'        else if (c == "}}") {{\n'
        f"            brace_depth--\n"
        f"            if (brace_depth == 0) {{ in_func=0; break }}\n"
        f"        }}\n"
        f"    }}\n"
        f"}}\n"
    )


def _base_env(
    workdir: Path, self_learning: str = "false", run_id: str = "test-run"
) -> str:
    """Return bash variable declarations common to create_state_file tests."""
    return textwrap.dedent(f"""\
        #!/bin/bash
        set -euo pipefail
        SELF_LEARNING={self_learning}
        SCRIPTS_DIR="{SCRIPTS_DIR}"
        BLUE='\\033[0;34m'
        GREEN='\\033[0;32m'
        NC='\\033[0m'
        PROGRESS_LOG="/dev/null"
        STATE_FILE="{workdir}/.closedloop/state.local.md"
        WORKDIR="{workdir}"
        MAX_ITERATIONS=5
        COMPLETION_PROMISE="COMPLETE"
        PROMPT_NAME=""
        PRD_FILE=""
        RUN_ID="{run_id}"
        START_SHA="abc123"
        run_timed_step() {{ :; }}
    """)


def _run_script(script: str, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        timeout=10,
        cwd=cwd,
    )


class TestCreateStateFilePersistsSelfLearning:
    """Verify self_learning field is written to state frontmatter."""

    def _build_script(self, workdir: Path, self_learning: str) -> str:
        awk = _awk_extract_script()
        return (
            _base_env(workdir, self_learning=self_learning)
            + f'eval "$(awk \'{awk}\' "{RUN_LOOP_SH}")"\n'
            + 'create_state_file "test prompt"\n'
        )

    def test_state_file_contains_self_learning_true(self, workdir: Path) -> None:
        """When SELF_LEARNING=true, state frontmatter includes self_learning: true."""
        result = _run_script(self._build_script(workdir, "true"), cwd=str(workdir))
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        content = (workdir / ".closedloop" / "state.local.md").read_text()
        assert 'self_learning: "true"' in content

    def test_state_file_contains_self_learning_false(self, workdir: Path) -> None:
        """When SELF_LEARNING=false (default), state frontmatter includes self_learning: false."""
        result = _run_script(self._build_script(workdir, "false"), cwd=str(workdir))
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        content = (workdir / ".closedloop" / "state.local.md").read_text()
        assert 'self_learning: "false"' in content

    def test_config_env_written_with_self_learning(self, workdir: Path) -> None:
        """create_state_file writes CLOSEDLOOP_SELF_LEARNING to config.env."""
        config_env = workdir / ".closedloop" / "config.env"
        config_env.write_text("CLOSEDLOOP_WORKDIR=/tmp/test\n")

        result = _run_script(self._build_script(workdir, "true"), cwd=str(workdir))
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        content = config_env.read_text()
        assert "CLOSEDLOOP_SELF_LEARNING=true" in content
        assert "CLOSEDLOOP_WORKDIR=/tmp/test" in content


class TestBootstrapLearningsGuard:
    """Verify bootstrap_learnings skips when self-learning is off."""

    def test_bootstrap_skips_when_disabled(self, workdir: Path) -> None:
        """bootstrap_learnings does not create .learnings/pending when SELF_LEARNING=false."""
        learnings = workdir / ".learnings"
        if learnings.exists():
            learnings.rmdir()

        awk = _awk_extract_script()
        script = (
            _base_env(workdir, self_learning="false")
            + f'eval "$(awk \'{awk}\' "{RUN_LOOP_SH}")"\n'
            + f'bootstrap_learnings "{workdir}"\n'
        )

        result = _run_script(script)
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        assert not (workdir / ".learnings" / "pending").exists()


class TestSelfLearningResume:
    """Verify SELF_LEARNING is restored from state file on resume."""

    def test_get_field_reads_self_learning(self, workdir: Path) -> None:
        """get_field can extract self_learning from state frontmatter."""
        state_file = workdir / ".closedloop" / "state.local.md"
        # Write frontmatter without indentation -- must start at column 0
        state_file.write_text(
            "---\n"
            "active: true\n"
            "iteration: 1\n"
            "max_iterations: 5\n"
            'completion_promise: "COMPLETE"\n'
            'workdir: "/tmp/test"\n'
            'prd_file: ""\n'
            'run_id: "test-run-resume"\n'
            'start_sha: "abc123"\n'
            'self_learning: "true"\n'
            'started_at: "2026-03-25T00:00:00Z"\n'
            "---\n"
            "prompt text\n"
        )

        awk = _awk_extract_script()
        script = (
            f"#!/bin/bash\n"
            f"set -euo pipefail\n"
            f'STATE_FILE="{state_file}"\n'
            f'PROGRESS_LOG="/dev/null"\n'
            f'eval "$(awk \'{awk}\' "{RUN_LOOP_SH}")"\n'
            f'echo "self_learning=$(get_field self_learning)"\n'
        )

        result = _run_script(script)
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        assert "self_learning=true" in result.stdout


class TestPostIterationProcessingWhenDisabled:
    """Verify the disabled path still runs step 1 and judges."""

    def _build_script(self, workdir: Path) -> str:
        awk = _awk_extract_script()
        return (
            _base_env(workdir, self_learning="false")
            + f'eval "$(awk \'{awk}\' "{RUN_LOOP_SH}")"\n'
            + 'emit_skipped_step() { echo "skipped:$1:$2"; }\n'
            + 'run_timed_step() { local step_num="$1"; shift 2; "$@"; }\n'
            + 'run_judges_if_needed() { echo "judges:$1"; }\n'
            + f'post_iteration_processing "{workdir}" 3\n'
        )

    def test_skips_steps_two_through_ten(self, workdir: Path) -> None:
        """Disabled runs emit skipped markers for steps 2-10, including 8.5."""
        result = _run_script(self._build_script(workdir), cwd=str(workdir))
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        expected_skips = [
            "skipped:2:pattern_relevance",
            "skipped:3:merge_relevance",
            "skipped:4:evaluate_goal",
            "skipped:5:merge_goal_outcome",
            "skipped:6:verify_citations",
            "skipped:7:merge_build_result",
            "skipped:8:process_learnings",
            "skipped:8.5:write_merged_patterns",
            "skipped:9:compute_success_rates",
            "skipped:10:export_closedloop_learnings",
        ]
        for marker in expected_skips:
            assert marker in result.stdout, f"Missing skip marker: {marker}"
