"""Contract checks for the 2026-10-14 operator ruling that nothing is called ready before its acceptance criteria are checked.

1. Each session keeps one acceptance criteria list inside its session decision
   table (no new artifact type): the linked ticket's and its PRD's criteria,
   each concrete requirement in the person's own words, and handoff behavior
   answers, quoted with their source and never invented or narrowed.
2. After each build or fix and before `DONE`, the writer checks every criterion
   the change touches with cheap concrete evidence (an existing test run alone,
   a throwaway script, one bounded control read, or an end-to-end source trace)
   and records criterion, check and result.
3. A criterion that is not met is fixed, or reported plainly to the person as
   not done yet; never claimed, never an engineering question, and no test is
   authored for it. A `DONE` without the block is incomplete.
4. It stays light: no QA pass, suite or long-running command joins the loop.
5. Handoff's alignment starts from the list.
6. The rule lives once, in `quality-loop.md`; the skills and workers point at it.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
QUALITY = VIBE / "references" / "quality-loop.md"
GUARDRAILS = VIBE / "references" / "guardrails.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
HEADING = "## Acceptance criteria before ready"
POINTER = '"Acceptance criteria before ready"'


def rule() -> str:
    return section(QUALITY.read_text(), HEADING)


def test_the_rule_is_dated_and_canonical() -> None:
    text = rule()
    assert "operator ruling, 2026-10-14" in text
    assert "This section is the rule's one canonical statement" in text
    assert "Heavy QA still waits for handoff." in text


def test_the_list_lives_in_the_session_decision_table_with_quoted_sourced_criteria() -> None:
    text = rule()
    for required in (
        "The list lives in the session decision table, not a new artifact",
        "one `## Acceptance Criteria` section, authored only by the SAME writer",
        "a stable ID (`AC-1`, `AC-2`, ...), its exact words quoted, its source and the row IDs that implement it",
        "every acceptance criterion of the linked ticket and its PRD",
        "each concrete requirement in the person's requests and annotations, in their own words",
        "each behavior answer at handoff",
        "Never invent a criterion or narrow its words.",
        "gets an explicit `Superseded` entry with its source, never a silent edit",
    ):
        assert required in text, required


def test_each_touched_criterion_is_checked_with_cheap_concrete_evidence_before_done() -> None:
    text = rule()
    for required in (
        "After each build or fix and its quick checks, before returning `DONE`",
        "checks every unsuperseded criterion the change touches",
        "including earlier requests' criteria its files or rows could break",
        "when unsure whether one is touched, check it",
        "an existing test that exercises it, run alone by file or test name, never the suite",
        "kept outside the worktree and deleted afterwards; it is not a test, is never committed",
        "one bounded `pnpm control` read against the running app under the control skill's own rules",
        "hidden, read-only, `pnpm control down` for every session it started",
        "such as URL state surviving a reload",
        "a source trace that follows the behavior end to end, with file and line",
        "A trace through one view does not check a criterion that covers several.",
    ):
        assert required in text, required


def test_each_check_records_criterion_check_and_result() -> None:
    text = rule()
    assert "Append one line per check to the section's `### Checks` log" in text
    assert "request ID, criterion ID, the check (test name, command or trace) and the result" in text
    assert "`met` or `not met yet`, with its evidence" in text
    assert "earlier lines stay" in text


def test_an_unmet_criterion_is_fixed_or_reported_never_claimed() -> None:
    text = rule()
    for required in (
        "A criterion not met yet is fixed in the same request and checked again.",
        "its result stays `not met yet` with the reason",
        "the orchestrator's ready message says plainly, in the person's terms, that this part is not done yet",
        "never claimed, silently dropped or turned into an engineering question for the person",
        "no test is authored for it (`guardrails.md`, \"Tests\")",
    ):
        assert required in text, required


def test_done_without_the_block_is_incomplete() -> None:
    text = rule()
    assert "`DONE` carries an Acceptance criteria block" in text
    assert "A `DONE` without that block, or with a touched criterion that has no check, is incomplete" in text
    assert "before committing, deploying or saying ready" in text


def test_it_stays_light() -> None:
    text = rule()
    assert "It is not a QA pass" in text
    assert "no long-running command joins the loop" in text
    lean = section(QUALITY.read_text(), "## Lean build loop")
    assert "- Acceptance check: before `DONE`" in lean
    assert "The acceptance check's single test, script or control read per criterion is not one of them." in lean


def test_handoff_alignment_starts_from_the_list() -> None:
    assert "At handoff the whole-table alignment above starts from this list" in rule()
    handoff = HANDOFF_SKILL.read_text()
    checks = section(handoff, "## 5. Checks and the missing tests list")
    assert "its `## Acceptance Criteria` list and checks log" in checks
    assert "that list is where its whole-table alignment starts" in checks
    review = section(handoff, "## 6. Independent integrated review")
    assert "The alignment below starts from the table's Acceptance Criteria list" in review
    assert "never counted as met" in review
    answers = section(handoff, "## Answers from the person")
    assert "add the answer to its `## Acceptance Criteria` list" in answers


def test_the_vibe_skill_forwards_criteria_and_refuses_an_unchecked_done() -> None:
    skill = VIBE_SKILL.read_text()
    start = section(skill, "## 2. Start or resume")
    assert "Keep its quoted acceptance criteria from the ticket and its PRD" in start
    loop = section(skill, "## 5. Build loop")
    for required in (
        "with the first request, the requirements worker's quoted acceptance criteria",
        "Then it checks every acceptance criterion the change touches and records each result",
        "must carry the Acceptance criteria block with a checked result for every criterion the change touches",
        "one without it is incomplete, so resume the SAME writer to finish it before committing",
        "each criterion the writer reported `not met yet` as not done yet; never claim it",
    ):
        assert required in loop, required
    deploy = section(skill, "## 6. Deploy each change")
    assert "naming plainly any acceptance criterion still `not met yet`" in deploy


def test_workers_point_at_the_rule() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert f'`quality-loop.md`, {POINTER}' in writer
    assert "always carries the Acceptance criteria block" in writer
    assert "At handoff, start the whole-table alignment from that list." in writer
    requirements = flat(agent("vibe-requirements-worker"))
    assert "acceptance criteria of the ticket AND of its PRD, each quoted exactly with its source slug" in requirements
    assert f'(`quality-loop.md`, {POINTER})' in requirements
    assert "and its acceptance criterion checks" in flat(agent("vibe-verify-worker"))
    assert POINTER in flat(GUARDRAILS.read_text())


def test_the_rule_is_stated_once() -> None:
    canonical = "Nothing is called ready until every acceptance criterion the change touches"
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if canonical in flat(path.read_text())]
    assert holders == ["quality-loop.md"]
