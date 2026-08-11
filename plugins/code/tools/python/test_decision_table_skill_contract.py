"""Contract checks for decision-table workflow hard stops and test realism."""

from __future__ import annotations

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = PLUGIN_ROOT / "skills" / "decision-table"


def read_skill_file(relative_path: str) -> str:
    return (SKILL_ROOT / relative_path).read_text()


def test_not_aligned_is_a_terminal_workflow_stop() -> None:
    skill = read_skill_file("SKILL.md")
    artifact_format = read_skill_file("references/artifact-format.md")

    for text in (skill, artifact_format):
        assert "Not aligned" in text
        assert "terminal" in text
        assert "PR" in text
        assert "merge" in text
        assert "completion" in text
        assert "next action" in text


def test_source_interactions_and_precedence_are_required() -> None:
    edge_cases = read_skill_file("references/edge-cases.md")

    assert "legacy or absent evidence alongside fresh valid evidence" in edge_cases
    assert "corrupt or undated evidence alongside fresh valid evidence" in edge_cases
    assert "irrelevant historical evidence alongside a current authoritative record" in edge_cases
    assert "tied or conflicting current records" in edge_cases
    assert "state/source precedence" in edge_cases
    assert "unbounded Cartesian product" in edge_cases


def test_executable_twins_require_real_boundary_shared_corpus() -> None:
    edge_cases = read_skill_file("references/edge-cases.md")
    review_prevention = read_skill_file("references/review-prevention.md")

    for text in (edge_cases, review_prevention):
        assert "shared scenario corpus" in text
        assert "real production boundary" in text
        assert "Source-string" in text or "source-string" in text
        assert "SQL-shape" in text
        assert "supplement" in text


def test_required_tests_map_to_rows_and_negative_cases() -> None:
    artifact_format = read_skill_file("references/artifact-format.md")

    assert "Row ID" in artifact_format
    assert "Decision Row IDs" in artifact_format
    assert "Wrong-Input / Mixed-State Negative Case" in artifact_format
