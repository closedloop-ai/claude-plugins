"""Contract checks for ISS-13411.

The prose scan is a heuristic backstop, not a proof that every possible
paraphrase is caught. The executable classifier and evidence gates own the
behavior; these patterns catch known regressions cheaply.
"""

import re
from pathlib import Path


PLUGIN = Path(__file__).parents[2]
HANDOFF = PLUGIN / "skills" / "handoff"
CLASSIFIER = HANDOFF / "scripts" / "qa-impact.mjs"
SCRIPT_MESSAGE_PATHS = (
    Path("skills/handoff/scripts/pr-facts.mjs"),
    Path("skills/handoff/scripts/live-ticket-check.mjs"),
)
HEAD = r"(?:head|sha|commit(?:\s+(?:hash|identity))?|(?:branch\s+)?tip)"
ACTION = r"(?:re[- ]?run|redo|repeat|refresh|invalidate(?:s|d)?|stale|no\s+longer\s+(?:counts?|valid)|must\s+run\s+again|run\b.{0,30}\bagain)"
QA = r"(?:automated\s+qa|visual[- ]?qa|qa\s+(?:pass|evidence|proof)|lanes?|screenshots?|critics?|frozen[- ]render(?:\s+(?:proof|evidence|line))?)"
HEAD_BOUND_QA = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    rf"\b{HEAD}\b.{{0,180}}\b{ACTION}\b.{{0,180}}\b{QA}\b",
    rf"\b{QA}\b.{{0,180}}\b{ACTION}\b.{{0,180}}\b{HEAD}\b",
    rf"\b{ACTION}\b.{{0,180}}\b{QA}\b.{{0,180}}\b{HEAD}\b",
    rf"\b{ACTION}\b.{{0,180}}\b{HEAD}\b.{{0,180}}\b{QA}\b",
    r"\ba head change\b.{0,60}\bsends? it back\b",
    r"\bchanged source\b.{0,60}\binvalidates? proof\b",
    r"\bafter any (?:change|fix|merge)(?:,|\s|or)*.{0,100}\b(?:run|rerun|repeat)\b.{0,80}\b(?:every )?(?:qa|lane|check|critic)",
    r"\brerun\b.{0,60}\bat the final head\b",
    r"\bfrozen[- ]render\b.{0,160}\bafter any (?:later )?change\b.{0,80}\b(?:runs? again|rerun)",
    r"\bevery main sync\b.{0,120}\b(?:rerun|repeat)\b.{0,80}\b(?:check|critic|guardrail)",
    r"\bafter any fix\b.{0,100}\b(?:rerun|repeat)\b.{0,80}\b(?:all|every)\b.{0,40}\b(?:check|critic)",
    r"\bnew (?:commit|sha)\b.{0,80}\b(?:redo|rerun|refresh)\b.{0,80}\b(?:visual[- ]?qa|qa|screenshots?)\b",
    r"\beach push\b.{0,80}\b(?:needs?|requires?)\b.{0,40}\bfresh\b.{0,40}\b(?:screenshots?|qa|lanes?)\b",
    r"\b(?:new|changed) sha\b.{0,80}\binvalidates?\b.{0,60}\b(?:lane|qa|screenshot)",
    r"\bafter (?:every |each )?(?:push|commit|merge)\b.{0,80}\b(?:refresh|redo|rerun)\b.{0,60}\b(?:critic|lane|qa|screenshot)",
    r"\b(?:automated qa|qa evidence)\b.{0,80}\b(?:match|bind|belong)\w*\b.{0,60}\bfinal commit\b",
    r"\blater commit\b.{0,80}\b(?:stales?|invalidates?)\b.{0,60}\bfrozen[- ]render\b",
    rf"\b{HEAD}\b.{{0,60}}\b(?:moves?|changes?)\b.{{0,100}}\b(?:run|rerun|redo|repeat|refresh)\b.{{0,60}}\b{QA}\b",
    rf"\b(?:run|rerun|redo|repeat|refresh)\b.{{0,60}}\b{QA}\b.{{0,100}}\b(?:when|if|after)\b.{{0,40}}\b{HEAD}\b.{{0,40}}\b(?:moves?|changes?)\b",
    rf"\b{HEAD}\b.{{0,80}}\b{QA}\b.{{0,80}}\b{ACTION}\b",
))
MANUAL_QA_ALLOWLIST = {
    "skills/cl-execute/references/feature-manual-qa.md": re.compile(r"manual[- ]qa|responsible-human", re.I),
    "skills/cl-execute/references/implementation-review-pr.md": re.compile(r"manual[- ]qa|responsible-human|current-head visual-QA refresh", re.I),
    "skills/cl-sweep/references/open-pr-lifecycle.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/cl-sweep/references/worker-prompt-packets.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/cl-sweep/references/parent-goal.md": re.compile(r"manual[- ]qa|responsible human", re.I),
    "skills/fleet-orchestrator/references/judgment.md": re.compile(r"qa-impact\.mjs", re.I),
    "agents/vibe-verify-worker.md": re.compile(r"source validator|ciEvidence", re.I),
    "skills/cl-execute/SKILL.md": re.compile(r"automatic rerun evidence proves the current head|never start.{0,80}visual-QA", re.I),
}


def directly_negates_action(text: str, start: int, end: int) -> bool:
    window_start = max(0, start - 40)
    window = text[window_start:end]
    match_offset = start - window_start
    actions = list(re.finditer(r"\b(?:run|re[- ]?run|redo|repeat|refresh|invalidate(?:s|d)?|stale)\b", window[match_offset:], re.I))
    if not actions:
        return False
    return all(
        re.search(r"\b(?:never|do not|does not)\s+$", window[: match_offset + action.start()], re.I)
        for action in actions
    )


def automated_head_qa_violations(root: Path) -> list[str]:
    violations: list[str] = []
    files = list(root.rglob("*.md"))
    files.extend(file for relative in SCRIPT_MESSAGE_PATHS if (file := root / relative).is_file())
    for file in files:
        relative = file.relative_to(root).as_posix()
        flattened = " ".join(file.read_text(errors="ignore").split())
        for pattern in HEAD_BOUND_QA:
            for match in pattern.finditer(flattened):
                start = max(0, match.start() - 300)
                end = min(len(flattened), match.end() + 300)
                excerpt = flattened[start:end]
                if directly_negates_action(flattened, match.start(), match.end()):
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
    assert "SAFE_ROOT_FILES" in source
    assert "commentOnlyImpact" in source
    assert "cat-file" in source
    assert '"--raw", "-z"' in source
    assert "FEATURE_MAP_DEFAULT" in source
    assert "CONFIG_DEFAULT" in source
    assert "UI_LOCATION" not in source
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


def test_no_instruction_or_gate_message_reintroduces_head_based_automated_qa() -> None:
    assert automated_head_qa_violations(PLUGIN) == []


def test_semantic_guard_catches_every_iss_13411_rerun_phrase_outside_the_old_list(tmp_path: Path) -> None:
    variants = {
        "skills/head-back.md": "A head change sends it back to verification.",
        "agents/source-proof.md": "Changed source invalidates proof.",
        "references/every-lane.md": "After any change, fix, or merge, run every lane.",
        "skills/final-head.md": "Rerun visual QA at the final head.",
        "references/frozen.md": "Frozen-render evidence counts only while files are unchanged; after any later change the command runs again.",
        "skills/main-sync.md": "Every main sync must rerun required checks and the guardrails critic.",
        "agents/fix-critics.md": "After any fix, rerun all checks and critics.",
    }
    for relative, text in variants.items():
        file = tmp_path / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
    violations = automated_head_qa_violations(tmp_path)
    assert {item.split(":", 1)[0] for item in violations} == set(variants)


def test_semantic_guard_catches_review_rewordings_and_leading_negation_bypass(tmp_path: Path) -> None:
    variants = {
        "skills/handoff/scripts/pr-facts.mjs": 'throw new Error("When a new commit lands, redo the visual QA.");',
        "skills/handoff/scripts/live-ticket-check.mjs": 'return "Each push needs fresh screenshots";',
        "references/sha-lanes.md": "A changed SHA invalidates the lane results.",
        "skills/push-critics.md": "After every push, refresh the critic evidence.",
        "agents/final-bind.md": "Automated QA must match the final commit.",
        "references/frozen-stale.md": "A later commit stales the frozen-render evidence.",
        "skills/leading-negation.md": "Never skip this rule: when a new commit lands, redo the visual QA.",
    }
    for relative, content in variants.items():
        file = tmp_path / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
    violations = automated_head_qa_violations(tmp_path)
    assert {item.split(":", 1)[0] for item in violations} == set(variants)


def test_heuristic_guard_catches_round_three_paraphrases(tmp_path: Path) -> None:
    variants = {
        "skills/negated-prefix.md": "Do not rerun anything else; rerun the lanes when the head moves.",
        "agents/tip-moves.md": "If the branch tip moves, run the lanes again.",
        "references/commit-qa.md": "When the commit changes, redo automated QA.",
        "skills/sha-shots.md": "After the SHA changes, refresh the screenshots.",
        "agents/head-lanes.md": "Repeat the lanes whenever the head changes.",
        "references/tip-visual.md": "A changed tip means visual QA must run again.",
    }
    for relative, content in variants.items():
        file = tmp_path / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
    violations = automated_head_qa_violations(tmp_path)
    assert {item.split(":", 1)[0] for item in violations} == set(variants)


def test_frozen_render_evidence_names_states_and_dependency_inputs_without_a_head() -> None:
    renderer = (HANDOFF / "scripts" / "frozen-render.mjs").read_text()
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "; states ${states}" in renderer
    assert "FROZEN_LINE_HEAD" not in rules
    assert "repo.frozenInputs(base, affected)" in rules
    assert "qa-impact.mjs names one of these story states" in rules
