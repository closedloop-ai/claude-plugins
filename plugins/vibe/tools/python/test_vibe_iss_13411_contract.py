"""Contract checks for ISS-13411: automated QA follows affected scope, not a commit identity."""

from pathlib import Path


PLUGIN = Path(__file__).parents[2]
HANDOFF = PLUGIN / "skills" / "handoff"
CLASSIFIER = HANDOFF / "scripts" / "qa-impact.mjs"


def test_the_one_classifier_owns_post_qa_scope() -> None:
    source = CLASSIFIER.read_text()
    assert 'None: "None"' in source
    assert 'LanesOnly: "Lanes only"' in source
    assert 'Visual: "Visual QA"' in source
    assert "graph importer results are missing" in source
    assert "FEATURE_MAP_DEFAULT" in source
    assert "QA evidence is screen and state based" in source
    assert (HANDOFF / "scripts" / "qa-impact.test.mjs").is_file()
    assert not (HANDOFF / "scripts" / "qa-merge-order.mjs").exists()


def test_instructions_call_the_classifier_instead_of_repeating_its_policy() -> None:
    fleet = (PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md").read_text()
    handoff = (HANDOFF / "SKILL.md").read_text()
    worker = (PLUGIN / "agents" / "vibe-change-worker.md").read_text()
    for text in (fleet, handoff, worker):
        assert "qa-impact.mjs" in text
    assert "`None` runs no local lane, screenshot, audit or critic" in fleet
    assert all(term in handoff for term in ("screens", "hosts", "states", "flag arms"))


def test_no_instruction_or_gate_reintroduces_head_based_automated_qa() -> None:
    forbidden = (
        "qa-merge-order.mjs",
        "--qa-head",
        "Changed source invalidates proof",
        "A head change sends it back",
        "rerun at the final head",
        "a line recorded before a later change no longer counts",
        "the same bytes on a different head require a new render proof",
    )
    failures: list[str] = []
    for file in PLUGIN.rglob("*"):
        if not file.is_file() or file.suffix not in {".md", ".mjs", ".py"} or file == Path(__file__):
            continue
        text = file.read_text(errors="ignore")
        for phrase in forbidden:
            if phrase.lower() in text.lower():
                failures.append(f"{file.relative_to(PLUGIN)}: {phrase}")
    assert failures == []


def test_frozen_render_evidence_names_states_and_dependency_inputs_without_a_head() -> None:
    renderer = (HANDOFF / "scripts" / "frozen-render.mjs").read_text()
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "; states ${states}" in renderer
    assert "FROZEN_LINE_HEAD" not in rules
    assert "repo.frozenInputs(base, affected)" in rules
    assert "qa-impact.mjs names one of these story states" in rules
