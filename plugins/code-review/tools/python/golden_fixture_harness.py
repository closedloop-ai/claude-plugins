"""Golden fixture harness for PLN-719 Phase 8.

A fixture is a directory at ``fixtures/<name>/`` containing:

- ``config.yaml``        — fixture metadata (description, mode, intent, etc.)
- ``inputs/`` — canned upstream artifacts that the harness stages into a
  temporary ``cr_dir`` before running the canonical post-collection
  pipeline (``collect-findings`` → ``validate`` → ``finalize-result``).
  Typical inputs: ``setup.json``, ``scope.json``, ``intent.json``,
  ``diff_data.json``, ``hygiene.json``, one or more ``agent_*.json``,
  optionally ``coverage_plan.json``.
- ``expected/`` — the expected post-pipeline artifacts (``review_result.json``)
  diffed byte-by-byte after normalization. ``pytest --update-golden``
  regenerates these in place for human review.

Non-deterministic fields (``review_id`` UUID, ``emitted_at`` ISO timestamps,
the wall-clock telemetry block) are normalized before diff/write so the
expected files stay stable across runs.

Phase 8 ships the post-collection harness only. Phase 4b will extend it to
walk ``run_plan.json`` end-to-end through a declarative stage runner.
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# The canonical placeholder values used to scrub non-deterministic fields
# before diff. Chosen to be obviously-synthetic so they read clearly in
# diffs against fixture expected/ artifacts.
_PLACEHOLDER_REVIEW_ID = "00000000-0000-4000-8000-000000000000"
_PLACEHOLDER_EMITTED_AT = "2026-01-01T00:00:00+00:00"

# The single envelope filename the post-collection pipeline produces and
# the harness diffs against. Used in three places (run, diff, update).
_REVIEW_RESULT_FILENAME = "review_result.json"


@dataclass
class GoldenFixture:
    """A single fixture on disk; constructed from its directory path."""

    name: str
    path: Path
    config: dict[str, Any]

    @classmethod
    def load(cls, path: Path) -> GoldenFixture:
        config_path = path / "config.yaml"
        if not config_path.exists():
            raise FileNotFoundError(f"fixture {path.name} missing config.yaml")
        with config_path.open() as f:
            config = yaml.safe_load(f) or {}
        return cls(name=path.name, path=path, config=config)

    @property
    def inputs_dir(self) -> Path:
        return self.path / "inputs"

    @property
    def expected_dir(self) -> Path:
        return self.path / "expected"

    def stage_inputs(self, cr_dir: Path) -> None:
        """Copy fixture inputs into ``cr_dir``."""
        if not self.inputs_dir.exists():
            return
        for src in self.inputs_dir.iterdir():
            if src.is_file():
                shutil.copy(src, cr_dir / src.name)


def run_with_stdout_capture(
    fn: Any, ns: argparse.Namespace, *, stdout_to: Path | None = None,
) -> str:
    """Invoke ``fn(ns)`` while suppressing stdout.

    When ``stdout_to`` is provided, the suppressed stdout is redirected
    into that file path. Otherwise it is captured to an in-memory buffer
    and returned as a string (empty string when redirected to a file).

    Both the post-collection pipeline and the prepare-run test helpers
    need to invoke an ``argparse.Namespace``-style CLI command while
    diverting its stdout output; centralizing the pattern here keeps the
    two callers from drifting (CLAUDE.md learned pattern about extracting
    test helpers when used by 2+ files).
    """
    old = sys.stdout
    captured = ""
    if stdout_to is not None:
        sys.stdout = stdout_to.open("w")
    else:
        sys.stdout = io.StringIO()
    try:
        fn(ns)
        if stdout_to is None:
            captured = sys.stdout.getvalue()  # type: ignore[union-attr]
    finally:
        if stdout_to is not None:
            sys.stdout.close()
        sys.stdout = old
    return captured


def normalize_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    """Replace non-deterministic fields with fixed placeholders.

    Mutates a deep copy and returns it; the caller's envelope is unchanged.
    """
    normalized = json.loads(json.dumps(envelope))
    if "review_id" in normalized:
        normalized["review_id"] = _PLACEHOLDER_REVIEW_ID
    for bucket in ("verified", "justified", "rejected", "pending_verification", "coverage_gaps"):
        for finding in normalized.get(bucket, []) or []:
            if "emitted_at" in finding:
                finding["emitted_at"] = _PLACEHOLDER_EMITTED_AT
    # The telemetry block contains wall-clock metrics that we don't pin in
    # post-collection fixtures (they're populated by upstream stages or
    # left as zero defaults). Drop it from the diff surface; envelope-level
    # validation already covers its shape elsewhere.
    normalized.pop("telemetry", None)
    return normalized


def run_post_collection_pipeline(cr_dir: Path, fixture: GoldenFixture) -> dict[str, Any]:
    """Run ``collect-findings`` → ``validate`` → ``finalize-result``.

    Stages the fixture's inputs into ``cr_dir``, executes each canonical
    helper, and returns the final ``review_result.json`` as a dict.
    """
    from code_review_helpers import (
        cmd_collect_findings,
        cmd_finalize_result,
        cmd_validate,
    )

    fixture.stage_inputs(cr_dir)

    findings_path = cr_dir / "findings.json"
    validated_path = cr_dir / "findings_validated.json"
    hygiene_path = cr_dir / "hygiene.json"
    diff_data_path = cr_dir / "diff_data.json"

    # collect-findings prints summary to stdout but writes findings.json
    # via the `output` argument. validate writes its JSON envelope to
    # stdout, so we redirect stdout into `validated_path` for that one.
    collect_ns = argparse.Namespace(
        cr_dir=str(cr_dir),
        output="findings.json",
        hygiene=str(hygiene_path) if hygiene_path.exists() else None,
    )
    run_with_stdout_capture(cmd_collect_findings, collect_ns)

    validate_ns = argparse.Namespace(
        findings=str(findings_path),
        diff_data=str(diff_data_path),
    )
    run_with_stdout_capture(cmd_validate, validate_ns, stdout_to=validated_path)

    finalize_ns = argparse.Namespace(
        cr_dir=str(cr_dir),
        validate_output=str(validated_path),
        mode=fixture.config.get("mode", "local"),
        diff_tip=fixture.config.get("diff_tip", "abc1234"),
        pr_number=fixture.config.get("pr_number"),
    )
    run_with_stdout_capture(cmd_finalize_result, finalize_ns)

    with (cr_dir / _REVIEW_RESULT_FILENAME).open() as f:
        envelope: dict[str, Any] = json.load(f)

    # Every golden fixture doubles as a schema round-trip check (PLN-719
    # Section 10 / Phase 1 acceptance criterion): "every fixture round-trips
    # emit → write → read → validate". A clean envelope at this point also
    # pins the upstream contract — collect, validate, finalize must all
    # produce schema-conformant output.
    from code_review_schema import validate_result_envelope
    errors = validate_result_envelope(envelope)
    if errors:
        raise AssertionError(
            f"fixture {fixture.name!r} envelope failed schema validation: {errors}",
        )
    return envelope


def diff_envelope_against_expected(
    fixture: GoldenFixture, actual: dict[str, Any],
) -> list[str]:
    """Return a list of mismatch lines comparing actual vs expected envelope.

    The ``actual`` envelope is normalized (``review_id``, ``emitted_at``,
    ``telemetry`` stripped) before comparison; the expected file is
    compared as-is. ``update_expected`` writes pre-normalized JSON, so
    hand-editing an expected file with a real UUID will produce a diff
    rather than being silently scrubbed at read time.

    The diff is structural: missing keys, type mismatches, value mismatches
    are reported with dotted paths so failures are easy to read.
    """
    expected_path = fixture.expected_dir / _REVIEW_RESULT_FILENAME
    if not expected_path.exists():
        return [
            f"fixture {fixture.name!r}: expected/review_result.json missing; "
            "run with --update-golden to create it",
        ]
    with expected_path.open() as f:
        expected = json.load(f)
    return _diff_json(normalize_envelope(actual), expected, "")


def _diff_json(actual: Any, expected: Any, path: str) -> list[str]:
    if type(actual) is not type(expected):
        return [f"{path or '<root>'}: type mismatch — actual={type(actual).__name__}, expected={type(expected).__name__}"]
    if isinstance(actual, dict):
        return _diff_dict(actual, expected, path)
    if isinstance(actual, list):
        return _diff_list(actual, expected, path)
    if actual != expected:
        return [f"{path or '<root>'}: actual={actual!r}, expected={expected!r}"]
    return []


def _diff_dict(actual: dict[str, Any], expected: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    for k in sorted(set(actual) | set(expected)):
        sub = f"{path}.{k}" if path else k
        if k not in actual:
            errors.append(f"{sub}: missing in actual")
        elif k not in expected:
            errors.append(f"{sub}: unexpected in actual")
        else:
            errors.extend(_diff_json(actual[k], expected[k], sub))
    return errors


def _diff_list(actual: list[Any], expected: list[Any], path: str) -> list[str]:
    if len(actual) != len(expected):
        return [f"{path or '<root>'}: length {len(actual)} != expected {len(expected)}"]
    errors: list[str] = []
    for i, (a, e) in enumerate(zip(actual, expected)):
        errors.extend(_diff_json(a, e, f"{path}[{i}]"))
    return errors


def update_expected(fixture: GoldenFixture, actual: dict[str, Any]) -> None:
    """Write the normalized envelope to ``expected/review_result.json``."""
    fixture.expected_dir.mkdir(parents=True, exist_ok=True)
    normalized = normalize_envelope(actual)
    out_path = fixture.expected_dir / _REVIEW_RESULT_FILENAME
    with out_path.open("w") as f:
        json.dump(normalized, f, indent=2, sort_keys=True)
        f.write("\n")
