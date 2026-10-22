"""Contract coverage for the QA lessons encoded in vibe 1.0.56."""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
GRAPH = PLUGIN_ROOT / "skills" / "vibe" / "references" / "closedloop-graph.md"


def assert_all(text: str, required: tuple[str, ...]) -> None:
    """Assert that every required contract phrase is present."""
    for phrase in required:
        assert phrase in text, phrase


def test_story_plays_run_awaited_in_a_real_browser() -> None:
    verify = section(agent("vibe-verify-worker"), "## Existing checks")
    assert_all(verify, (
        "every new or changed story with a `play` function",
        "`storybook/test` interaction",
        "not awaited",
        "plays in a real browser",
        "containerized Storybook service",
        "A jsdom result",
    ))


def test_cards_and_narrow_layouts_require_two_real_touch_devices() -> None:
    required = (
        "WebKit iPhone",
        "Chromium Pixel",
        "`hasTouch` alone",
        "`pointerType`",
        "`mouse`",
    )
    assert_all(flat(agent("vibe-verify-worker")), required)
    adversary = flat(agent("vibe-adversarial-reviewer"))
    assert_all(adversary, required + (
        "compare the narrow-width DOM geometry and captures with the same width on main",
        "in-flow band",
    ))


def test_story_fixtures_keep_type_and_layout_invariants() -> None:
    decomposer = flat(agent("vibe-storybook-decomposer"))
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    required = (
        "slug prefix matches its entity type",
        "distinct non-default values",
        "all-default fixture",
        "column collapse",
    )
    assert_all(decomposer, required)
    assert_all(reviewer, required)


def test_sidebar_folding_requires_an_explicit_request() -> None:
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert_all(decomposer, (
        "`!dev` fold",
        "person explicitly requested less content in the sidebar",
        "Without that request",
    ))


def test_requirements_overlap_includes_shipped_work_and_open_prs() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    assert_all(requirements, (
        "for a ticket or a description, run `query_collisions`",
        "run `blast_radius_tickets`",
        "open GitHub pull requests",
        "touches any of those same files",
        "`EXECUTED` PRD",
        "`DONE` children and shipped rules",
    ))
    assert_all(flat(GRAPH.read_text()), (
        "`query_collisions` for every ticket or description",
        "matched `EXECUTED` PRDs and their `DONE` children",
    ))


def test_missing_tests_none_requires_both_host_adapters_per_criterion() -> None:
    verify = section(agent("vibe-verify-worker"), "## Coverage advice and the missing tests list")
    assert_all(verify, (
        "`Missing tests: None` is a hard coverage claim",
        "every acceptance criterion",
        "real web host adapter",
        "real Desktop host adapter",
        "coverage on only one host is insufficient",
    ))
    assert "missing tests list may say `None` only when every acceptance criterion" in flat(HANDOFF.read_text())


def test_test_names_keep_acceptance_criterion_provenance() -> None:
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    assert_all(reviewer, (
        "match it exactly to the ID and source already recorded",
        "An invented ID",
        "drops the recorded source provenance",
    ))


def test_agent_rationale_cannot_source_a_rule_or_exemption() -> None:
    provenance = section(agent("vibe-guardrails-reviewer"), "15. Rule provenance")
    assert_all(provenance, (
        "every exemption and product rule",
        "only source is an agent's own rationale",
        "blocking `engineering decision`",
        "not a product source",
    ))


def test_handoff_records_same_storybook_version_claims() -> None:
    handoff = flat(HANDOFF.read_text())
    assert_all(handoff, (
        "read the Storybook package version on the final branch",
        "list every other open pull request",
        "claimed Storybook version",
        "Record the version and matching pull request numbers",
    ))
    assert "same-Storybook-version check" in flat(agent("vibe-ticket-worker"))


def test_missing_current_week_falls_back_to_latest_weekly_project() -> None:
    create = section(agent("vibe-ticket-worker"), "## Create mode")
    assert_all(create, (
        "If no weekly project covers today",
        "select the latest weekly project by its ending date and continue",
        "Note that fallback and the selected project under What this is",
        "never stop",
    ))
