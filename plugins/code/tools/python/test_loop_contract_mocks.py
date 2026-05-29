"""Centralized mock suite for run-loop.sh contract tests.

This module is the single source of truth for:
  - Fixture constants loaded from fixtures/loop_contracts/
  - Shared bash invocation helpers (run_bash, run_bash_detect)
  - Shared path helpers (state_dir, state_file_path, session_id_file, runs_log_file)
  - Shared executors and validators (run_write_runs_log_with_fallback,
    validate_runs_log_session_id_field)
  - State-file template builders for YAML-frontmatter state files

All test files in the loop-contract test suite import from this module.
No test file should define inline mocks or inline bash helpers that
duplicate responsibilities covered here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_LOOP = REPO_ROOT / "plugins" / "code" / "scripts" / "run-loop.sh"
FIXTURES_DIR = Path(__file__).parent / "fixtures" / "loop_contracts"

# ---------------------------------------------------------------------------
# Test-wide secret for signed-marker tests
# ---------------------------------------------------------------------------

FAILURE_SECRET = "test-loop-failure-secret"

# ---------------------------------------------------------------------------
# Fixture constants — loaded once, referenced by name from test tables
#
# Each constant holds the raw text of the fixture file so test tables can
# pass it directly to helpers without re-reading from disk.
# ---------------------------------------------------------------------------

#: rate_limit_event with status="rejected" (no overage flags needed)
FIXTURE_RATE_LIMIT_REJECTED_STATUS: str = (
    FIXTURES_DIR / "rate_limit_rejected_status.jsonl"
).read_text()

#: Bare {"error":"rate_limit"} entry — error-string branch
FIXTURE_RATE_LIMIT_ERROR_STRING: str = (
    FIXTURES_DIR / "rate_limit_error_string.jsonl"
).read_text()

#: result entry with api_error_status=429
FIXTURE_RATE_LIMIT_STATUS_429: str = (
    FIXTURES_DIR / "rate_limit_status_429.jsonl"
).read_text()

#: result entry with rate-limit prose in the result field (envelope text match)
FIXTURE_RATE_LIMIT_ENVELOPE_TEXT: str = (
    FIXTURES_DIR / "rate_limit_envelope_text.jsonl"
).read_text()

#: result entry with context-limit prose (JSONL path)
FIXTURE_CONTEXT_LIMIT_JSONL: str = (
    FIXTURES_DIR / "context_limit_jsonl.jsonl"
).read_text()

#: stderr text with context-limit prose
FIXTURE_CONTEXT_LIMIT_STDERR: str = (
    FIXTURES_DIR / "context_limit_stderr.txt"
).read_text()

#: result entry with auth-challenge text (JSONL path)
FIXTURE_AUTH_CHALLENGE_JSONL: str = (
    FIXTURES_DIR / "auth_challenge_jsonl.jsonl"
).read_text()

#: stderr text with auth-challenge error
FIXTURE_AUTH_CHALLENGE_STDERR: str = (
    FIXTURES_DIR / "auth_challenge_stderr.txt"
).read_text()

#: result entry — unknown_skill signalled via the result field
FIXTURE_UNKNOWN_SKILL_RESULT_FIELD: str = (
    FIXTURES_DIR / "unknown_skill_result_field.jsonl"
).read_text()

#: result entry — unknown_skill signalled via the error field
FIXTURE_UNKNOWN_SKILL_ERROR_FIELD: str = (
    FIXTURES_DIR / "unknown_skill_error_field.jsonl"
).read_text()

#: Normal successful stream — no terminal failure signal expected
FIXTURE_SUCCESS_NO_TERMINAL_FAILURE: str = (
    FIXTURES_DIR / "success_no_terminal_failure.jsonl"
).read_text()

# ---------------------------------------------------------------------------
# Golden snapshot constants — state-file mutations (AC-003, T-3.1)
#
# Each YAML constant holds the raw text of the golden state-file fixture.
# Non-deterministic fields (run_id, started_at, workdir) use the placeholder
# tokens GOLDEN_RUN_ID / GOLDEN_TIMESTAMP / GOLDEN_SESSION_ID so callers
# can substitute real values before comparison.
#
# Placeholder tokens used across state-file and runs-log fixtures:
#   GOLDEN_RUN_ID      — substituted with the actual RUN_ID used in the test
#   GOLDEN_TIMESTAMP   — masked or substituted with the real timestamp
#   GOLDEN_SESSION_ID  — masked or substituted with the real session ID
# ---------------------------------------------------------------------------

#: State file after iteration 1 succeeds (in_progress, result non-empty).
#: iteration counter incremented to 2; successful_iterations=1.
GOLDEN_STATE_AFTER_ITER1_SUCCESS: str = (
    FIXTURES_DIR / "state_snap_after_iter1_success.yaml"
).read_text()

#: State file at the point iteration 2 spurious-complete fires — just before
#: handle_spurious_complete() deletes the file.
#: iteration stays at 2 (not yet incremented); successful_iterations=2
#: (incremented because the iteration had a non-empty result before the
#: spurious check ran).
GOLDEN_STATE_AT_ITER2_SPURIOUS_COMPLETE: str = (
    FIXTURES_DIR / "state_snap_at_iter2_spurious_complete.yaml"
).read_text()

#: State file after iteration 3 succeeds (in_progress, result non-empty).
#: iteration counter incremented to 4; successful_iterations=3.
GOLDEN_STATE_AFTER_ITER3_SUCCESS: str = (
    FIXTURES_DIR / "state_snap_after_iter3_success.yaml"
).read_text()

#: State file just before max-iterations terminates the loop.
#: The iteration counter was incremented to 5 at the end of iteration 4's
#: body; the max-iterations check (5 > 4) then fires on the next loop pass.
#: successful_iterations=3 (iterations 1, 2, 3 succeeded; iter 4 is the
#: final in-progress iteration before the budget is exhausted).
GOLDEN_STATE_AT_ITER4_MAX_ITERATIONS: str = (
    FIXTURES_DIR / "state_snap_at_iter4_max_iterations.yaml"
).read_text()

# ---------------------------------------------------------------------------
# Golden snapshot constants — runs.log entries (AC-003, T-3.1)
#
# Each LOG constant holds the expected pipe-delimited entry for one step.
# The full-sequence constant is the append-only accumulation of all four.
# Non-deterministic fields use the GOLDEN_* placeholder tokens (see above).
# ---------------------------------------------------------------------------

#: Single runs.log entry for iteration 1 success (in_progress, no 8th field).
GOLDEN_RUNS_LOG_ITER1_SUCCESS: str = (
    FIXTURES_DIR / "runs_log_iter1_success.log"
).read_text()

#: Single runs.log entry for iteration 2 spurious-complete (no 8th field).
GOLDEN_RUNS_LOG_ITER2_SPURIOUS: str = (
    FIXTURES_DIR / "runs_log_iter2_spurious_complete.log"
).read_text()

#: Single runs.log entry for iteration 3 success (in_progress, no 8th field).
GOLDEN_RUNS_LOG_ITER3_SUCCESS: str = (
    FIXTURES_DIR / "runs_log_iter3_success.log"
).read_text()

#: Single runs.log entry for max-iterations (iteration=5, has 8th field=2).
GOLDEN_RUNS_LOG_ITER4_MAX_ITERATIONS: str = (
    FIXTURES_DIR / "runs_log_iter4_max_iterations.log"
).read_text()

#: Full-sequence runs.log — all four entries accumulated in append order.
GOLDEN_RUNS_LOG_FULL_SEQUENCE: str = (
    FIXTURES_DIR / "runs_log_full_sequence.log"
).read_text()

# ---------------------------------------------------------------------------
# Golden snapshot helper — substitutes placeholder tokens with real values
# ---------------------------------------------------------------------------


def substitute_golden_tokens(
    text: str,
    *,
    run_id: str,
    timestamp: str | None = None,
    session_id: str | None = None,
    workdir: str | None = None,
) -> str:
    """Replace GOLDEN_* placeholder tokens in a golden fixture string.

    Args:
        text: Raw fixture content loaded from a golden snapshot file.
        run_id: The actual run_id to substitute for GOLDEN_RUN_ID.
        timestamp: ISO-8601 timestamp to substitute for GOLDEN_TIMESTAMP.
            When None the placeholder is left as-is (useful when masking
            timestamps before comparison rather than substituting them).
        session_id: Session ID string to substitute for GOLDEN_SESSION_ID.
            When None the placeholder is left as-is.
        workdir: Absolute path to substitute for /test/workdir in state YAML.
            When None the placeholder path is left unchanged.

    Returns:
        The fixture text with all applicable tokens substituted.
    """
    result = text.replace("GOLDEN_RUN_ID", run_id)
    if timestamp is not None:
        result = result.replace("GOLDEN_TIMESTAMP", timestamp)
    if session_id is not None:
        result = result.replace("GOLDEN_SESSION_ID", session_id)
    if workdir is not None:
        result = result.replace("/test/workdir", workdir)
    return result


# ---------------------------------------------------------------------------
# Shared bash invocation helpers
# ---------------------------------------------------------------------------


def _base_env(workdir: Path, failure_secret: str | None) -> dict[str, str]:
    """Build the subprocess environment common to all bash helpers."""
    env: dict[str, str] = {**os.environ, "CLOSEDLOOP_WORKDIR": str(workdir)}
    if failure_secret is not None:
        env["CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET"] = failure_secret
    return env


def run_bash_detect(
    workdir: Path,
    *,
    jsonl_content: str | None = None,
    stderr_content: str | None = None,
) -> dict[str, Any]:
    """Invoke detect_claude_terminal_failure() and return the parsed JSON dict.

    Writes jsonl_content to output.jsonl (or an empty file when None).
    Writes stderr_content to stderr.txt when provided; passes "" otherwise.

    Centralises the bash-source boilerplate so per-case test tables focus on
    fixture data and expected values rather than shell harness mechanics.
    """
    output_file = workdir / "output.jsonl"
    if jsonl_content is not None:
        output_file.write_text(jsonl_content)
    else:
        output_file.write_text("")

    if stderr_content is not None:
        stderr_file = workdir / "stderr.txt"
        stderr_file.write_text(stderr_content)
        stderr_arg = '"$CLOSEDLOOP_WORKDIR/stderr.txt"'
    else:
        stderr_arg = '""'

    script = (
        f"source {RUN_LOOP}\n"
        f'detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" {stderr_arg}'
    )
    result = subprocess.run(
        ["bash", "-c", script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
        env=_base_env(workdir, failure_secret=None),
    )
    assert result.returncode == 0, (
        f"detect_claude_terminal_failure exited {result.returncode}:\n{result.stderr}"
    )
    return json.loads(result.stdout or "{}")


def run_bash(
    workdir: Path,
    *,
    script_body: str,
    failure_secret: str | None = FAILURE_SECRET,
) -> subprocess.CompletedProcess[str]:
    """Source run-loop.sh and run script_body.

    CLOSEDLOOP_WORKDIR is set to workdir. CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET
    is set to failure_secret when provided (None removes it from the env).

    Returns the CompletedProcess so callers can assert returncode, stdout, and
    stderr independently.
    """
    full_script = f"source {RUN_LOOP}\n{script_body}"
    return subprocess.run(
        ["bash", "-c", full_script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
        env=_base_env(workdir, failure_secret),
    )


# Backward-compatible aliases — existing test files reference the domain-specific
# names; these thin aliases avoid a mass rename while the mock suite is the SSOT.
run_bash_session_id = run_bash
run_bash_failure_marker = run_bash
run_bash_state_file = run_bash


# ---------------------------------------------------------------------------
# Shared path helpers (used by state, session, and resume test files)
# ---------------------------------------------------------------------------

_CLOSEDLOOP_DIR_NAME = ".closedloop-ai"
_STATE_FILE_NAME = "closedloop-loop.local.md"

#: Regex for ISO-8601 timestamps as written by run-loop.sh.
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


def state_dir(tmp_path: Path) -> Path:
    """Ensure the .closedloop-ai directory exists under tmp_path and return it."""
    d = tmp_path / _CLOSEDLOOP_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def state_file_path(tmp_path: Path) -> Path:
    """Return the canonical state file path under tmp_path."""
    return state_dir(tmp_path) / _STATE_FILE_NAME


def session_id_file(workdir: Path) -> Path:
    """Return the session-id.txt path under workdir."""
    return workdir / "session-id.txt"


def runs_log_file(workdir: Path) -> Path:
    """Return the runs.log path under workdir."""
    return workdir / "runs.log"


# ---------------------------------------------------------------------------
# Shared executor: write_runs_log_entry with LAST_CLAUDE_SESSION_ID unset
# ---------------------------------------------------------------------------


def run_write_runs_log_with_fallback(
    workdir: Path,
    *,
    run_id: str,
    iteration: int,
    status: str,
) -> None:
    """Call write_runs_log_entry() with LAST_CLAUDE_SESSION_ID unset.

    The fallback chain is: LAST_CLAUDE_SESSION_ID (empty) ->
    session-id.txt (read if present in workdir).
    """
    result = run_bash(
        workdir,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'RUN_ID="{run_id}"; '
            f'CLOSEDLOOP_ACTIVE_GOAL="reduce-failures"; '
            f'LAST_CLAUDE_SESSION_ID=""; '
            f'write_runs_log_entry "{workdir}" {iteration} "{status}" "plan_execute"'
        ),
    )
    assert result.returncode == 0, (
        f"write_runs_log_entry exited {result.returncode}: {result.stderr}"
    )


# ---------------------------------------------------------------------------
# Shared validator: check session_id field in runs.log
# ---------------------------------------------------------------------------


def validate_runs_log_session_id_field(
    expected_session_id: str,
) -> Any:
    """Return a validator checking field[6] (session_id) in runs.log.

    Usable from both session and resume test files as a shared validator.
    """

    def _validate(ctx: dict[str, Any]) -> None:
        # Support both "workdir" and "tmp_path" as the directory key
        workdir = ctx.get("workdir") or ctx.get("tmp_path")
        assert workdir is not None, "workdir or tmp_path must be provided"
        log_path = runs_log_file(workdir)
        assert log_path.exists(), "runs.log was not created"
        lines = [ln for ln in log_path.read_text().splitlines() if ln.strip()]
        assert lines, "runs.log is empty"
        fields = lines[-1].split("|")
        assert len(fields) >= 7, (
            f"Expected at least 7 fields, got {len(fields)}: {lines[-1]!r}"
        )
        assert fields[6] == expected_session_id, (
            f"Field[6] (session_id): expected {expected_session_id!r}, "
            f"got {fields[6]!r}"
        )

    return _validate


# ---------------------------------------------------------------------------
# State-file template builders
# ---------------------------------------------------------------------------


def build_state_file(
    workdir: Path | str,
    *,
    iteration: int = 1,
    successful_iterations: int = 0,
    run_id: str | None = None,
    command: str = "plan_execute",
    max_iterations: int = 5,
    start_sha: str = "abc123",
    self_learning: bool = False,
    completion_promise: str = "COMPLETE",
    started_at: str = "2026-01-01T00:00:00Z",
    extra_fields: dict[str, str] | None = None,
) -> str:
    """Return a YAML-frontmatter state file as a string.

    The format mirrors the state files written by create_state_file() in
    run-loop.sh.  Non-deterministic fields (run_id, started_at) are provided
    with deterministic defaults so callers can pin them for golden-snapshot
    comparisons; pass explicit values to override.

    Args:
        workdir: The working directory path recorded in the state file.
        iteration: Current iteration counter.
        successful_iterations: Number of iterations that succeeded so far.
        run_id: Unique run identifier; defaults to a deterministic UUID built
            from the iteration and command to avoid randomness in tests.
        command: The resolved CLOSEDLOOP_COMMAND string.
        max_iterations: Maximum iteration budget.
        start_sha: Git SHA at loop start.
        self_learning: Whether self-learning is enabled.
        completion_promise: The expected completion promise token.
        started_at: ISO-8601 timestamp string.
        extra_fields: Additional key-value pairs appended to the frontmatter.

    Returns:
        A string in the form ``---\\n<yaml>\\n---\\n``.
    """
    if run_id is None:
        # Derive a deterministic UUID from the inputs so tests never see
        # non-deterministic values by default.
        run_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_DNS,
                f"{command}-{iteration}-{successful_iterations}",
            )
        )

    lines: list[str] = [
        "---",
        f"iteration: {iteration}",
        f"successful_iterations: {successful_iterations}",
        f"max_iterations: {max_iterations}",
        f"run_id: {run_id}",
        f"command: \"{command}\"",
        f"workdir: {workdir}",
        f"start_sha: {start_sha}",
        f"self_learning: {str(self_learning).lower()}",
        f"completion_promise: {completion_promise}",
        f"started_at: {started_at}",
    ]
    if extra_fields:
        for key, value in extra_fields.items():
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def write_state_file(path: Path, **kwargs: Any) -> None:
    """Write a state file produced by build_state_file() to *path*.

    Convenience wrapper so test tables can do::

        write_state_file(tmp_path / "state.local", iteration=3, command="plan_execute")
    """
    path.write_text(build_state_file(path.parent, **kwargs))


# ---------------------------------------------------------------------------
# Signed-marker helper (mirrors signed_marker() in test_run_loop_failure_marker.py)
# ---------------------------------------------------------------------------


def signed_marker(payload: dict[str, Any], *, secret: str = FAILURE_SECRET) -> dict[str, Any]:
    """Return payload with an HMAC-SHA256 signature appended.

    Mirrors the signing logic in write_loop_user_visible_failure() in
    run-loop.sh.  The bash implementation pipes::

        printf '%s\\0%s' "$secret" "$payload"

    into a Python one-liner that splits on the NUL byte and calls
    ``hmac.new(secret, payload, sha256)``.  The HMAC key is therefore the
    secret bytes and the data is the compact-JSON payload bytes — the NUL
    separator is only used for the pipe protocol, not hashed.
    """
    canonical = json.dumps(payload, separators=(",", ":"))
    signature = hmac.new(
        secret.encode(),
        canonical.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {**payload, "signature": f"sha256={signature}"}


# ---------------------------------------------------------------------------
# JSONL helpers (shared across contract test files)
# ---------------------------------------------------------------------------


def write_jsonl(path: Path, entries: list[dict[str, Any] | str]) -> None:
    """Write a sequence of JSONL entries to *path*.

    Dicts are serialised with compact separators; strings are written verbatim
    (useful for injecting deliberately malformed lines).
    """
    lines = [
        entry if isinstance(entry, str) else json.dumps(entry, separators=(",", ":"))
        for entry in entries
    ]
    path.write_text("\n".join(lines) + "\n")
