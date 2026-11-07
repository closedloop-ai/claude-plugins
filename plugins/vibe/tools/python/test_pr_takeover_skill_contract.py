"""Contract checks for the engineer PR takeover skill in both harnesses."""

from __future__ import annotations

import json
from pathlib import Path
import re

import pytest


PLUGIN = Path(__file__).resolve().parents[2]
SKILL = PLUGIN / "skills" / "pr-takeover" / "SKILL.md"
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
EVALS = PLUGIN / "evals"


def _section(text: str, heading: str) -> str:
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return text[start:] if end < 0 else text[start:end]


def test_both_manifests_publish_the_same_new_skill_version() -> None:
    claude = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
    codex = json.loads((PLUGIN / ".codex-plugin" / "plugin.json").read_text())
    assert claude["version"] == codex["version"] == "1.1.61"
    assert codex["skills"] == "./skills/"
    assert SKILL.read_text().startswith("---\nname: pr-takeover\n")


def test_url_only_entry_does_not_depend_on_a_prior_vibe_session() -> None:
    skill = SKILL.read_text()
    entry = _section(skill, "## 1. Resolve the PR before launching work")
    assert "Input: one GitHub pull request URL" in skill
    assert "no vibe session" in skill
    assert "head repository" in entry and "live base" in entry
    assert "new worktree" in skill and "one source writer" in skill


def test_unverified_premise_never_reaches_fix_or_confirmed_ticket() -> None:
    review = _section(SKILL.read_text(), "## 2. Review the PR independently")
    assert "independently reopens every cited source line" in review
    assert "any `UNVERIFIED` premise" in review
    assert "neither a confirmed bug to fix nor a confirmed vibe mistake to file" in review
    assert "Do not initiate or retrigger automated PR review" in review


def test_stack_review_and_main_conflict_are_separate() -> None:
    skill = SKILL.read_text()
    review = _section(skill, "## 2. Review the PR independently")
    repair = _section(skill, "## 4. Repair the actual PR")
    assert "live base branch as the review diff base" in review
    assert "`git merge-tree` against that base and separately against fetched `origin/main`" in review
    assert "Do not review the parent PR's diff again" in review
    assert "updated parent first, then current main" in repair
    assert "re-measure version-history counts" in repair


def test_prevention_deduplicates_and_uses_claude_plugins_worktree() -> None:
    section = _section(SKILL.read_text(), "## 3. Feed verified vibe mistakes back to vibe")
    for phrase in (
        "Search recent open claude-plugins vibe tickets",
        "Do not create a duplicate",
        "ticket-write-check.mjs",
        "`create-document`",
        "`closedloop-ai/claude-plugins`",
        "separate claude-plugins worktree",
        "`closedloop-core:prevent-recurrence`",
        "In Claude Code use a native Agent worker; in Codex use a native worker",
    ):
        assert phrase in section, phrase


def test_push_threads_and_merge_boundary() -> None:
    section = _section(SKILL.read_text(), "## 4. Repair the actual PR")
    assert "commit-worktree.mjs" in section
    assert "`git push origin HEAD:<source branch>`" in section
    assert "Never force push, skip hooks, merge the PR, or arm auto-merge" in section
    assert "pr-threads.mjs" in section and "review-threads.mjs" in section
    assert "answer every thread" in section.lower()


def test_e2e_requires_real_displayless_or_permitted_remote_evidence() -> None:
    section = _section(SKILL.read_text(), "## 5. Run required E2E and record it on the PR")
    for phrase in (
        "`pnpm test:lanes`",
        "pre-pr-lanes.mjs",
        "e2e-lock.mjs",
        "Linux dbus, keyring and Xvfb",
        "permitted remote machine",
        "operator's interactive desktop",
        "source option",
        "`not-run` result means the lane is incomplete",
        "Postmerge `desktop-e2e/validated` never proves premerge Desktop E2E",
        "No `DONE` claim follows a not-run receipt or a control walk",
    ):
        assert phrase in section, phrase


def test_fleet_routes_engineer_pr_takeover_without_changing_dead_writer_route() -> None:
    section = _section(FLEET.read_text(), "## Moving work between runtimes and accounts")
    assert "`vibe:pr-takeover`" in section and "`$pr-takeover`" in section
    assert "dead writer" in section and "does not start the PR review" in section


@pytest.mark.parametrize(
    "case",
    (
        "orch-pr-takeover-url-only",
        "orch-pr-takeover-premises",
        "orch-pr-takeover-prevention",
        "orch-pr-takeover-stack",
        "orch-pr-takeover-delivery",
        "orch-pr-takeover-e2e",
    ),
)
def test_claude_and_codex_share_each_rehearsal_case(case: str) -> None:
    prompt = EVALS / case / "prompt.md"
    assert prompt.is_file()
    text = prompt.read_text()
    assert "vibe:pr-takeover" in text
    assert "allowed_tools: [Skill, Read, Grep, Glob]" in text
    graders = list((prompt.parent / "graders").glob("*.md"))
    assert graders
    for grader in graders:
        pattern = re.search(r"^pattern: '(.+)'$", grader.read_text(), re.MULTILINE)
        assert pattern is not None, grader
        re.compile(pattern.group(1))


def test_codex_runner_loads_takeover_skill_before_vibe_fallback() -> None:
    runner = (EVALS / "codex" / "run.py").read_text()
    assert 'SKILLS = ("pr-takeover", "fleet-orchestrator", "handoff", "vibe")' in runner


def _grader_matches(case: str, grader: str, answer: str) -> bool:
    path = EVALS / f"orch-pr-takeover-{case}" / "graders" / f"{grader}.md"
    text = path.read_text()
    pattern = re.search(r"^pattern: '(.+)'$", text, re.MULTILINE)
    assert pattern is not None, path
    matched = re.search(pattern.group(1), answer, re.IGNORECASE) is not None
    return not matched if "match: not_contains" in text else matched


def test_stack_graders_accept_equivalent_live_base_answers_and_reject_main_base() -> None:
    claude = (
        "REVIEW: Diff the child's head against its live base, the #9366 parent. "
        "Don't review the parent's diff again.\n"
        "CONFLICTS: Run merge-tree against the parent and origin/main.\n"
        "ORDER: Bring in the parent, then main. Re-measure Storybook counts."
    )
    codex = (
        "REVIEW: Diff against the live base, the parent branch of #9366, "
        "instead of origin/main.\n"
        "CONFLICTS: Run merge-tree against the parent and origin/main.\n"
        "ORDER: Bring in the parent, then main. Recount Storybook history."
    )
    wrong = (
        "REVIEW: Diff #9448 against origin/main and include the parent's changes.\n"
        "CONFLICTS: Run merge-tree against origin/main only.\n"
        "ORDER: Merge main first and ignore Storybook counts."
    )
    graders = ("base", "parent-excluded", "main-conflict", "order", "storybook")
    for answer in (claude, codex):
        assert all(_grader_matches("stack", grader, answer) for grader in graders)
    for grader in ("base", "parent-excluded", "main-conflict", "order", "storybook"):
        assert not _grader_matches("stack", grader, wrong), grader


def test_e2e_graders_keep_not_run_and_postmerge_status_incomplete() -> None:
    good = (
        "WEB: Run headless.\n"
        "DESKTOP: Use a remote Mac and record the source receipt.\n"
        "UNREACHABLE: Takeover incomplete; record the missing runner on the PR."
    )
    wrong = (
        "WEB: Run headed on the operator desktop.\n"
        "DESKTOP: The postmerge status covers the lane.\n"
        "UNREACHABLE: Takeover DONE without a PR result."
    )
    graders = ("desktop", "incomplete", "pr-record")
    assert all(_grader_matches("e2e", grader, good) for grader in graders)
    for grader in graders:
        assert not _grader_matches("e2e", grader, wrong), grader


def test_url_only_grader_rejects_a_session_record_block() -> None:
    for safe in (
        "BLOCK: no, a prior session record is not required.",
        "BLOCK: not blocked by the absent session record.",
        "BLOCK: the absence does not block entry.",
        "BLOCK: a prior session record is not required.",
    ):
        assert _grader_matches("url-only", "no-session-block", safe), safe
    wrong = "BLOCK: yes, entry is blocked because there is no session record."
    assert not _grader_matches("url-only", "no-session-block", wrong)


def test_unverified_grader_rejects_fix_and_file_after_a_negated_blocker() -> None:
    safe = "F1: UNVERIFIED; do not fix it or file a confirmed ticket."
    wrong = "F1: UNVERIFIED premise, not a blocker; fix it and file a ticket."
    assert _grader_matches("premises", "unverified", safe)
    assert not _grader_matches("premises", "unverified", wrong)


def test_delivery_grader_rejects_arming_auto_merge_on_an_open_pr() -> None:
    safe = "PR: open and unmerged; do not arm auto-merge."
    wrong = "PR: open, not merged; arm auto-merge for the engineer."
    assert _grader_matches("delivery", "no-merge", safe)
    assert not _grader_matches("delivery", "no-merge", wrong)
    assert _grader_matches("delivery", "no-affirmative-auto-merge", safe)
    assert not _grader_matches("delivery", "no-affirmative-auto-merge", wrong)
    mixed = "PR: open; auto-merge not armed; arm auto-merge for the engineer."
    assert _grader_matches("delivery", "no-merge", mixed)
    assert not _grader_matches("delivery", "no-affirmative-auto-merge", mixed)
    for verb in ("arm", "arms", "armed"):
        wrong_later = f"PR: open; auto-merge not armed now; we will {verb} auto-merge later."
        assert not _grader_matches("delivery", "no-affirmative-auto-merge", wrong_later)


def test_takeover_prompts_use_the_codex_rewrite_form() -> None:
    runner = (EVALS / "codex" / "run.py").read_text()
    assert "vibe|handoff|fleet-orchestrator|pr-takeover" in runner
    for prompt in sorted(EVALS.glob("orch-pr-takeover-*/prompt.md")):
        assert "(`vibe:pr-takeover`)" in prompt.read_text(), prompt


def test_codex_reviewer_path_names_managed_app_server_receipt() -> None:
    review = _section(SKILL.read_text(), "## 2. Review the PR independently")
    assert "managed App Server thread" in review
    assert "../handoff/SKILL.md" in review
