"""Contract checks for ISS-13411: automated QA follows affected scope, not a commit identity."""

import re
from pathlib import Path


PLUGIN = Path(__file__).parents[2]
HANDOFF = PLUGIN / "skills" / "handoff"
CLASSIFIER = HANDOFF / "scripts" / "qa-impact.mjs"
HEAD = r"(?:head|sha|commit(?:\s+(?:hash|identity))?)"
ACTION = r"(?:re[- ]?run|repeat|refresh|invalidate(?:s|d)?|stale|no\s+longer\s+(?:counts?|valid)|must\s+run\s+again)"
QA = r"(?:automated\s+qa|visual[- ]?qa|qa\s+(?:pass|evidence|proof)|lanes?|screenshots?|critics?|frozen[- ]render(?:\s+(?:proof|evidence|line))?)"
HEAD_BOUND_QA = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    rf"\b{HEAD}\b.{{0,180}}\b{ACTION}\b.{{0,180}}\b{QA}\b",
    rf"\b{QA}\b.{{0,180}}\b{ACTION}\b.{{0,180}}\b{HEAD}\b",
    rf"\b{ACTION}\b.{{0,180}}\b{QA}\b.{{0,180}}\b{HEAD}\b",
    rf"\b{ACTION}\b.{{0,180}}\b{HEAD}\b.{{0,180}}\b{QA}\b",
))
MANUAL_QA_ALLOWLIST = {
    "skills/cl-execute/references/feature-manual-qa.md": re.compile(r"manual[- ]qa|responsible-human", re.I),
    "skills/cl-execute/references/implementation-review-pr.md": re.compile(r"manual[- ]qa|responsible-human", re.I),
    "skills/cl-sweep/references/open-pr-lifecycle.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/cl-sweep/references/worker-prompt-packets.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/cl-sweep/references/parent-goal.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/fleet-orchestrator/references/judgment.md": re.compile(r"qa-impact\.mjs", re.I),
    "agents/vibe-verify-worker.md": re.compile(r"source validator|ciEvidence", re.I),
    "skills/cl-execute/SKILL.md": re.compile(r"automatic rerun evidence proves the current head", re.I),
}


def automated_head_qa_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for file in root.rglob("*.md"):
        relative = file.relative_to(root).as_posix()
        flattened = " ".join(file.read_text(errors="ignore").split())
        for pattern in HEAD_BOUND_QA:
            for match in pattern.finditer(flattened):
                prefix = flattened[max(0, match.start() - 50):match.start()]
                if re.search(r"\b(?:never|do not|does not)\s+$", prefix, re.I):
                    continue
                start = max(0, match.start() - 300)
                end = min(len(flattened), match.end() + 300)
                excerpt = flattened[start:end]
                if re.search(r"\b(?:never|do not|does not)\b.{0,40}\b(?:re[- ]?run|repeat|refresh|invalidate)", match.group(0), re.I):
                    continue
                allowed = MANUAL_QA_ALLOWLIST.get(relative)
                if allowed and allowed.search(excerpt):
                    continue
                violations.append(f"{relative}: {match.group(0)}")
    return violations


def test_the_one_classifier_owns_post_qa_scope() -> None:
    source = CLASSIFIER.read_text()
    assert 'None: "None"' in source
    assert 'LanesOnly: "Lanes only"' in source
    assert 'Visual: "Visual QA"' in source
    assert "code importers missing" in source
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


def test_no_markdown_instruction_reintroduces_head_based_automated_qa() -> None:
    assert automated_head_qa_violations(PLUGIN) == []


def test_semantic_guard_catches_reworded_head_based_qa_outside_the_old_phrase_list(tmp_path: Path) -> None:
    variants = {
        "skills/new-rule.md": "When the commit changes, refresh the visual QA evidence.",
        "agents/new-worker.md": "Rerun the selected lanes whenever HEAD advances.",
        "references/new-proof.md": "Screenshot proof becomes stale after a new SHA.",
    }
    for relative, text in variants.items():
        file = tmp_path / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
    violations = automated_head_qa_violations(tmp_path)
    assert len(violations) == 3
    assert {item.split(":", 1)[0] for item in violations} == set(variants)


def test_frozen_render_evidence_names_states_and_dependency_inputs_without_a_head() -> None:
    renderer = (HANDOFF / "scripts" / "frozen-render.mjs").read_text()
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "; states ${states}" in renderer
    assert "FROZEN_LINE_HEAD" not in rules
    assert "repo.frozenInputs(base, affected)" in rules
    assert "qa-impact.mjs names one of these story states" in rules
