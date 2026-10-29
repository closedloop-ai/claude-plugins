"""Contract checks for the triage manifest and the class pipeline skills (PRD-823, WS1).

1. Each shared rule lives in exactly one file, `references/pipeline-core.md`, and every
   class pipeline skill cites every rule id without restating it.
2. Defer and skip are applied automatically, and the vibe skill reads the
   manifest's `effective` values.
3. Today's "Start Desktop for every session" rule and the eager environment step stay in
   the vibe skill, qualified only by the manifest.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from vibe_contract_text import flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILLS = PLUGIN_ROOT / "skills"
VIBE = SKILLS / "vibe"
CORE = VIBE / "references" / "pipeline-core.md"
TRIAGE = VIBE / "references" / "triage.md"
SCRIPT = VIBE / "scripts" / "vibe-triage.mjs"
CLASS_SKILLS = {
    "vibe-pipeline-trivial-ui": "trivial-ui",
    "vibe-pipeline-ui-feature": "ui-feature",
    "vibe-pipeline-backend": "backend",
    "vibe-pipeline-docs-config": "docs-config",
}
RULES = {
    "PC-1": "## PC-1 Policy steps",
    "PC-2": "## PC-2 Quality gates",
    "PC-3": "## PC-3 Lanes and end-to-end specs",
    "PC-4": "## PC-4 Words the person sees",
    "PC-5": "## PC-5 Unknown class",
}
# One sentence per rule that must not be restated anywhere else.
RULE_SENTENCES = {
    "PC-1": "A step runs differently only when its `effective` value in the manifest says so",
    "PC-2": "A class changes who reads the diff, never whether it is read.",
    "PC-3": "come from `pnpm test:lanes` and the target repository's e2e path filter, never from the class.",
    "PC-4": "A class adds no user-visible text.",
    "PC-5": "uses the vibe skill's flow with no class pipeline skill.",
}
POLICY_STEPS = ("environment", "desktop", "ticket", "planPublish", "decisionTable", "redeploy", "handoffSteps")


def frontmatter(path: Path) -> dict[str, str]:
    return yaml.safe_load(path.read_text().split("---", 2)[1])


def markdown_files() -> list[Path]:
    return sorted(SKILLS.glob("**/*.md"))


def test_core_defines_each_shared_rule_once() -> None:
    text = CORE.read_text()
    for rule, heading in RULES.items():
        assert text.count(heading) == 1, rule
        assert len(section(text, heading)) > 40, rule
        assert RULE_SENTENCES[rule] in flat(text), rule


def test_each_shared_rule_sentence_lives_in_exactly_one_file() -> None:
    for rule, sentence in RULE_SENTENCES.items():
        homes = [path for path in markdown_files() if sentence in flat(path.read_text())]
        assert homes == [CORE], (rule, homes)


def test_every_class_pipeline_skill_cites_every_rule_and_restates_none() -> None:
    for name, cls in CLASS_SKILLS.items():
        path = SKILLS / name / "SKILL.md"
        meta = frontmatter(path)
        assert meta["name"] == name
        assert cls in meta["description"]
        text = flat(path.read_text())
        assert f"`class: {cls}`" in text, name
        assert "../vibe/references/pipeline-core.md" in text, name
        assert "../vibe/references/triage.md" in text, name
        assert "PC-1 to PC-5" in text, name
        assert "restates none" in text, name
        for rule, sentence in RULE_SENTENCES.items():
            assert sentence not in text, (name, rule)
        assert re.search(r"\(PC-1\)", text), name


def test_class_skills_cover_every_class_the_script_can_name() -> None:
    script = SCRIPT.read_text()
    classes = set(re.findall(r'^\s+\w+: "([a-z-]+)",?$', script.split("export const CLASSES", 1)[1].split("});", 1)[0], re.MULTILINE))
    assert classes == {"trivial-ui", "ui-feature", "backend", "docs-config", "mockup", "data-metric", "unknown"}
    table = section(TRIAGE.read_text(), "## Classes")
    for cls in classes:
        assert f"`{cls}`" in table, cls
    for name in CLASS_SKILLS:
        assert f"`{name}`" in table, name


def test_class_skills_do_not_waive_a_policy_step() -> None:
    for name in CLASS_SKILLS:
        text = flat((SKILLS / name / "SKILL.md").read_text())
        for waiver in ("skip Desktop", "without Desktop", "skips the decision table", "no decision table", "skip the ticket"):
            assert waiver not in text, (name, waiver)


def test_script_records_every_policy_step_and_the_reference_names_them() -> None:
    script = SCRIPT.read_text()
    reference = flat(TRIAGE.read_text())
    assert 'export const POLICY = "required (policy)"' in script
    assert "`required (policy)`" in reference
    for step in POLICY_STEPS:
        assert f'"{step}"' in script, step
    assert 'export const E2E_SOURCE = "pnpm test:lanes and the e2e path filter"' in script
    assert "`pnpm test:lanes and the e2e path filter`" in reference


def test_defer_and_skip_apply_automatically_with_no_switch() -> None:
    text = section(TRIAGE.read_text(), "## Applying the manifest")
    assert "applied automatically; there is no switch" in text
    assert "ISS-13333, ISS-13334" in text
    script = SCRIPT.read_text()
    assert "process.env" not in script
    assert "VIBE_TRIAGE_APPLY_RECOMMENDATIONS" not in script + flat(TRIAGE.read_text())


def test_vibe_skill_reads_effective_and_keeps_todays_rules() -> None:
    text = flat((VIBE / "SKILL.md").read_text())
    assert "VIBE_TRIAGE_APPLY_RECOMMENDATIONS" not in text
    assert "scripts/vibe-triage.mjs classify" in text
    assert "`effective: defer`" in text
    assert "`effective: skip`" in text
    assert "Start Desktop for every session, per the Desktop section of `references/environment.md`, unless the manifest's `desktop` step has" in text
    assert "Stand up the environment (section 3)" not in text, "step 7 now says it runs unless the manifest defers it"
    assert "Section 3 runs now unless the manifest's `environment` step has `effective: defer`" in text
    assert "references/triage.md" in text and "references/pipeline-core.md" in text
    reference = flat(TRIAGE.read_text())
    assert "mid-run upgrade rules are not part of this release" in reference
    assert "never skipped" in reference
