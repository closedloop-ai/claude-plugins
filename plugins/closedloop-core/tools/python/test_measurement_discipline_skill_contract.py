"""Contract checks for measurement-discipline's experiment-selection guidance."""

from pathlib import Path


SKILL = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "measurement-discipline"
    / "SKILL.md"
).read_text()
PROSE = " ".join(SKILL.split())


def test_attribution_precedes_bounded_harness_investment() -> None:
    rank = PROSE.index("rank measured contributors")
    harness_budget = PROSE.index("Set a harness-investment budget")
    comparison_rules = PROSE.index("## The rules")

    assert rank < harness_budget < comparison_rules
    assert "maximum elapsed time, and the attempt limit" in PROSE
    assert "minimum instrumentation" in PROSE
    assert "harness defects repeat" in PROSE
    assert "existing tools already answer the decision" in PROSE


def test_harness_exit_preserves_measurement_rigor() -> None:
    assert "A broken or unvalidated harness supplies no positive evidence" in PROSE
    assert "preserve the one-variable comparison" in PROSE
    assert "fail closed" in PROSE
    assert "materially advance the operator's target" in PROSE
