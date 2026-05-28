"""PLN-719 Phase 8 — golden fixture harness tests.

Each subdirectory under ``fixtures/`` matching ``golden_*`` is a fixture.
The harness lives in ``golden_fixture_harness.py``; this module hosts the
pytest collection that parametrizes over the fixture directories, runs
the post-collection pipeline, and either asserts byte-identical output
against ``expected/`` or rewrites it (with ``pytest --update-golden``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from golden_fixture_harness import (
    GoldenFixture,
    diff_envelope_against_expected,
    run_post_collection_pipeline,
    update_expected,
)

_FIXTURES_ROOT = Path(__file__).parent / "fixtures"


# Phase 8 ships 3 fixtures end-to-end. The other 6 fixtures in PLN-719
# Section 10 require plans 01/02/03/05/06 outputs to be canonical before
# their expected envelopes can be pinned; they ship as fixture skeletons
# and the test parametrization skips them with a clear reason.
_DEFERRED_FIXTURES: dict[str, str] = {
    "golden_premise_justified": "plan 02 (justification) not shipped",
    "golden_premise_rejected": "plan 02 (justification) not shipped",
    "golden_impact_with_callsites": "plan 06 (external impact) not shipped",
    "golden_coverage_gap": "plans 03 + 05 (verifier + coverage) not shipped",
    "golden_injection_quarantine": "plan 01 (detect-injection) not shipped",
    "golden_budget_exceeded": "arbitrate-budget integration fixture pending",
}


def _discover_fixtures() -> list[Path]:
    if not _FIXTURES_ROOT.exists():
        return []
    return sorted(p for p in _FIXTURES_ROOT.glob("golden_*") if p.is_dir())


@pytest.mark.parametrize(
    "fixture_path", _discover_fixtures(), ids=lambda p: p.name,
)
def test_golden_fixture(
    fixture_path: Path, tmp_path: Path, update_golden: bool,
) -> None:
    """Run the post-collection pipeline and diff against expected/."""
    reason = _DEFERRED_FIXTURES.get(fixture_path.name)
    if reason is not None:
        pytest.skip(f"deferred fixture: {reason}")

    fixture = GoldenFixture.load(fixture_path)
    envelope = run_post_collection_pipeline(tmp_path, fixture)

    if update_golden:
        update_expected(fixture, envelope)
        return

    diffs = diff_envelope_against_expected(fixture, envelope)
    assert not diffs, (
        f"fixture {fixture.name!r} envelope differs from expected/:\n"
        + "\n".join(diffs)
    )


def test_fixtures_root_exists() -> None:
    """A guard so the harness can't silently drop all fixtures."""
    assert _FIXTURES_ROOT.exists(), (
        f"Fixture root {_FIXTURES_ROOT} missing — Phase 8 ships fixtures alongside the harness."
    )


def test_discovered_fixtures_include_at_least_the_three_shipped() -> None:
    """Pins the three Phase 8 fixtures so a future refactor can't drop them silently."""
    names = {p.name for p in _discover_fixtures()}
    for required in (
        "golden_minimal_correctness",
        "golden_all_categories",
        "golden_schema_v1_round_trip",
    ):
        assert required in names, f"required fixture {required!r} missing from fixtures/"


def test_prepare_run_produces_byte_identical_output_modulo_review_id(
    tmp_path: Path,
) -> None:
    """PLN-719 Section 6 determinism: two invocations differ only in review_id.

    Pops the uuid v4 ``review_id`` field, then compares the remaining
    document byte-by-byte. Any drift in stage args, validation gates,
    telemetry projections, or flag normalization fails the test.
    """
    import argparse
    import io
    import json as _json
    import sys as _sys

    from code_review_helpers import cmd_prepare_run

    def _invoke(output_path: Path) -> dict[str, object]:
        ns = argparse.Namespace(
            cr_dir=str(tmp_path / "cr"),
            mode="local",
            output=str(output_path),
            pr_number=None,
            hygiene_only=False,
            since_last_review=False,
            full_review=False,
            base_ref_override="",
            scope_args="",
        )
        old = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            cmd_prepare_run(ns)
        finally:
            _sys.stdout = old
        with output_path.open() as f:
            return _json.load(f)

    a = _invoke(tmp_path / "plan_a.json")
    b = _invoke(tmp_path / "plan_b.json")

    # review_id is the only deliberately non-deterministic field.
    assert a.pop("review_id") != b.pop("review_id"), (
        "review_id should be unique per invocation"
    )
    assert a == b, "run_plan.json drift detected outside review_id"
