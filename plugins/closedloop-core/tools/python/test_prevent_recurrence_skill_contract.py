"""Contract checks for the prevent-recurrence skill.

The skill must work for any agent in any repository, so it may not depend on
workflow-specific skills or private local files, and its links must resolve
from the skill's own folder.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = PLUGIN_ROOT / "skills" / "prevent-recurrence"
MARKDOWN_LINK_RE = re.compile(r"\]\(([^)]+)\)")
LADDER = (
    "1. Architecture or types",
    "2. Static analysis",
    "3. Guard test",
    "4. Owning instruction rule",
    "5. Memory or notes hint",
)
FORBIDDEN_DEPENDENCIES = (
    "cl-execute",
    ".closedloop-ai",
    "gardener",
    "symphony",
    "${CLAUDE_SKILL_DIR}",
    "/Users/",
    "/home/",
    "~/",
)
DASH_ONLY_CHARS = frozenset("-|: ")


def skill_files() -> list[Path]:
    return sorted(SKILL_ROOT.rglob("*.md"))


def skill_section(start: str, end: str) -> str:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    body = skill.split(start, 1)[1].split(end, 1)[0]
    return " ".join(body.split())


def test_frontmatter_names_the_skill_and_its_triggers() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    frontmatter = skill.split("---", 2)[1]
    assert "\nname: prevent-recurrence\n" in frontmatter
    description = next(
        line for line in frontmatter.splitlines() if line.startswith("description: ")
    )
    for trigger in (
        "correcting an issue or failure",
        "code",
        "setup",
        "measurement",
        "validation",
        "workflow",
        "accepted code-review findings",
        "keeps happening",
        "post-incident",
        "owning instruction rule",
    ):
        assert trigger in description, trigger
    for exclusion in (
        "ordinary feature work",
        "rejected findings",
        "external outages",
        "flaky infrastructure",
        "no agent or system mistake",
    ):
        assert exclusion in description, exclusion


def test_opening_covers_non_product_corrections_and_exclusions() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    opening = " ".join(skill.split("## 1. Fix the instance", 1)[0].split())
    assert "correcting an issue or failure reveals a reusable lesson" in opening
    assert "code, setup, measurement, validation, workflow" in opening
    assert "ordinary feature work" in opening
    assert "rejected review findings" in opening
    assert "external outages or flaky infrastructure" in opening
    assert "no agent or system mistake" in opening


def test_trust_ladder_table_lists_the_highest_rung_first() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    positions = [skill.index(f"| {rung} |") for rung in LADDER]
    assert positions == sorted(positions)


def test_skill_files_stay_portable() -> None:
    files = skill_files()
    assert files
    for path in files:
        text = path.read_text()
        for dependency in FORBIDDEN_DEPENDENCIES:
            assert dependency not in text, f"{path.name}: {dependency}"
        assert "\u2014" not in text, f"{path.name}: em dash"
        for line in text.splitlines():
            if line.strip() and set(line) <= DASH_ONLY_CHARS:
                continue  # frontmatter fence or table separator row
            assert "--" not in line, f"{path.name}: double hyphen in {line!r}"


def test_relative_links_resolve_inside_the_skill() -> None:
    for path in skill_files():
        for target in MARKDOWN_LINK_RE.findall(path.read_text()):
            assert not target.startswith(("/", "~", "http")), f"{path.name}: {target}"
            resolved = (path.parent / target).resolve()
            assert resolved.is_file(), f"{path.name}: {target}"
            assert resolved.is_relative_to(SKILL_ROOT), f"{path.name}: {target}"


def test_step_3_runs_the_harness_check() -> None:
    step = skill_section("## 3.", "## 4.")
    for fact in (
        "Harness check:",
        "Claude Code at launch:",
        "On demand:",
        "Codex at start, once per run, in trusted projects only:",
        "`project_doc_max_bytes` (default 32768)",
        "Not loaded: files below its working directory",
        "hook's `additionalContext`",
    ):
        assert fact in step, fact


def test_rung_4_places_rules_where_each_harness_loads_them() -> None:
    step = skill_section("## 4.", "## 5.")
    lead_in = "where the harness check shows each harness loads them:"
    placement = step.split(lead_in, 1)[1]
    placement = placement.split("Size budget check before appending:", 1)[0]
    for rule in (
        "- Default: the nearest owning `AGENTS.md`",
        "- A path-scoped `.claude/rules` file only for a lesson keyed to a file pattern"
        " that crosses directories",
        "it adds to the `AGENTS.md` text, never replaces it",
        "Never move existing `AGENTS.md` lines into rules",
        "- For a high-value lesson keyed to file paths, a shared PreToolUse or"
        " PostToolUse hook returning `additionalContext` reaches both harnesses",
        "Codex: only in trusted projects, once reviewed",
        "It stays advisory",
    ):
        assert rule in placement, rule


def test_rung_4_checks_size_budgets_before_appending() -> None:
    step = skill_section("## 4.", "## 5.")
    budget = step.split("Size budget check before appending:", 1)[1]
    budget = budget.split("Rung 5", 1)[0]
    for limit in ("40,000 characters", "`project_doc_max_bytes`", "200 lines"):
        assert limit in budget, limit


def test_step_5_covers_a_rule_the_harness_never_loaded() -> None:
    step = skill_section("## 5.", "## 6.")
    never_loaded = step.split("Harness never loaded it:", 1)[1]
    for cause in (
        "working directory was above the file",
        "project was untrusted",
        "cut off for size",
        "only one harness reads its file",
        "Fix placement or size, not another copy",
    ):
        assert cause in never_loaded, cause


def test_closeout_records_harness_reach() -> None:
    closeout = (SKILL_ROOT / "SKILL.md").read_text().split("## Closeout", 1)[1]
    block = closeout.split("```text", 1)[1].split("```", 1)[0]
    assert "\n- Harness reach: per harness, <harness>: <file>" in block
