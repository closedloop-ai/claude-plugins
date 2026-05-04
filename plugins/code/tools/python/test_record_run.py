"""Tests for record_run.sh — appends a 'run' event to perf.jsonl."""

import json
import subprocess
from datetime import datetime
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "record_run.sh"


def run_record_run(
    args: list[str],
    tmp_path: Path,
) -> subprocess.CompletedProcess[str]:
    """Invoke record_run.sh with the given positional arguments."""
    return subprocess.run(
        ["bash", str(SCRIPT_PATH)] + args,
        capture_output=True,
        text=True,
        check=False,
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_creates_perf_jsonl(tmp_path: Path) -> None:
    """Valid args must produce a perf.jsonl file in the workdir."""
    result = run_record_run(
        ["run-20240101-abcd", "/code:code", "false", str(tmp_path)],
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    perf_file = tmp_path / "perf.jsonl"
    assert perf_file.exists(), "perf.jsonl was not created"


def test_happy_path_json_contains_correct_fields(tmp_path: Path) -> None:
    """The JSON line must contain all expected fields with correct values."""
    run_id = "run-20240101-abcd"
    command = "/code:code"
    resume = "false"

    run_record_run([run_id, command, resume, str(tmp_path)], tmp_path)

    perf_file = tmp_path / "perf.jsonl"
    record = json.loads(perf_file.read_text().strip())

    assert record["event"] == "run"
    assert record["run_id"] == run_id
    assert record["command"] == command
    assert record["workdir"] == str(tmp_path)


def test_happy_path_resume_false_is_json_boolean(tmp_path: Path) -> None:
    """resume='false' must be serialised as JSON boolean false, not a string."""
    run_record_run(["run-id", "/code:code", "false", str(tmp_path)], tmp_path)

    record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    assert record["resume"] is False
    assert not isinstance(record["resume"], str)


def test_happy_path_resume_true_is_json_boolean(tmp_path: Path) -> None:
    """resume='true' must be serialised as JSON boolean true, not a string."""
    run_record_run(["run-id", "/code:code", "true", str(tmp_path)], tmp_path)

    record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    assert record["resume"] is True
    assert not isinstance(record["resume"], str)


# ---------------------------------------------------------------------------
# Missing / partial args (fail-open)
# ---------------------------------------------------------------------------


def test_no_args_exits_zero(tmp_path: Path) -> None:
    """Calling with no args must exit 0 (fail-open)."""
    result = run_record_run([], tmp_path)
    assert result.returncode == 0


def test_no_args_does_not_create_perf_file(tmp_path: Path) -> None:
    """Calling with no args must not write perf.jsonl."""
    run_record_run([], tmp_path)
    assert not (tmp_path / "perf.jsonl").exists()


def test_missing_workdir_exits_zero(tmp_path: Path) -> None:
    """Calling with run_id only (no workdir) must exit 0 (fail-open)."""
    result = run_record_run(["run-id"], tmp_path)
    assert result.returncode == 0


def test_missing_workdir_does_not_create_perf_file(tmp_path: Path) -> None:
    """Calling with run_id only must not write perf.jsonl anywhere."""
    run_record_run(["run-id"], tmp_path)
    assert not (tmp_path / "perf.jsonl").exists()


def test_missing_run_id_exits_zero(tmp_path: Path) -> None:
    """Calling with empty run_id must exit 0 (fail-open)."""
    # Pass an empty string as run_id — the script treats it as missing.
    result = run_record_run(["", "/code:code", "false", str(tmp_path)], tmp_path)
    assert result.returncode == 0


def test_missing_run_id_does_not_create_perf_file(tmp_path: Path) -> None:
    """Calling with empty run_id must not write perf.jsonl."""
    run_record_run(["", "/code:code", "false", str(tmp_path)], tmp_path)
    assert not (tmp_path / "perf.jsonl").exists()


# ---------------------------------------------------------------------------
# Output format validation
# ---------------------------------------------------------------------------


def test_output_has_exactly_expected_keys(tmp_path: Path) -> None:
    """The JSON line must have exactly the six expected keys, no extras."""
    run_record_run(["run-id", "/code:code", "false", str(tmp_path)], tmp_path)

    record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    assert set(record.keys()) == {"event", "run_id", "command", "resume", "timestamp", "workdir"}


def test_timestamp_is_valid_iso8601(tmp_path: Path) -> None:
    """The timestamp field must be a parseable ISO 8601 UTC string."""
    run_record_run(["run-id", "/code:code", "false", str(tmp_path)], tmp_path)

    record = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    ts = record["timestamp"]

    # Expect format: YYYY-MM-DDTHH:MM:SSZ
    try:
        parsed = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise AssertionError(f"timestamp {ts!r} is not valid ISO 8601: {exc}") from exc

    # Must be treated as UTC (strptime without tz gives naive — just check format)
    assert parsed.year >= 2024, f"Suspiciously old timestamp: {ts}"


def test_output_is_single_json_line(tmp_path: Path) -> None:
    """perf.jsonl must contain exactly one line after a single invocation."""
    run_record_run(["run-id", "/code:code", "false", str(tmp_path)], tmp_path)

    lines = (tmp_path / "perf.jsonl").read_text().splitlines()
    non_empty = [ln for ln in lines if ln.strip()]
    assert len(non_empty) == 1


def test_multiple_invocations_append_lines(tmp_path: Path) -> None:
    """Repeated invocations must append to perf.jsonl, not overwrite it."""
    run_record_run(["run-1", "/code:code", "false", str(tmp_path)], tmp_path)
    run_record_run(["run-2", "/code:code", "true", str(tmp_path)], tmp_path)

    lines = [
        ln for ln in (tmp_path / "perf.jsonl").read_text().splitlines() if ln.strip()
    ]
    assert len(lines) == 2
    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert first["run_id"] == "run-1"
    assert second["run_id"] == "run-2"
