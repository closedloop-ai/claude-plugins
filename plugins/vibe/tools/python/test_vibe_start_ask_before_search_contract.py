"""Contract checks for how `$vibe` starts (operator ruling, 2026-10-15).

Starting `$vibe` no longer searches for previous vibe sessions up front,
because that search is slow:

1. The orchestrator decides resume or new before any search. It asks one
   plain question only when the person's own words do not already answer it,
   and that question never mentions worktrees, branches or ledgers.
2. "pick up where I left off", "resume", or a named session or slug means
   resume; a ticket or a description of new work means new. Neither asks.
3. A new session skips the search entirely.
4. The search (`vibe-sessions.mjs list`) runs only after the person chose
   resume, and what it finds is then offered.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
SESSIONS_SCRIPT = PLUGIN_ROOT / "skills" / "vibe" / "scripts" / "vibe-sessions.mjs"
START = "## 2. Start or resume"
RESUME = "### Finding a session to resume"
QUESTION = "Do you want to pick up something you worked on before, or start something new?"
SEARCH = "vibe-sessions.mjs list"


def start_section() -> str:
    return section(VIBE_SKILL.read_text(), START)


def decision() -> str:
    """Section 2 up to its first subsection: what runs before any search."""
    start = start_section()
    return start[: start.index(RESUME)]


def starting_new() -> str:
    start = start_section()
    return start[start.index("### Starting new") : start.index("### Mockup sessions")]


def test_the_decision_comes_before_any_search_and_states_why() -> None:
    start = start_section()
    assert "that search is slow, so it runs only for someone who chose to resume" in decision()
    assert SEARCH not in decision().replace(f"never run `{SEARCH}`", "")
    assert start.index(QUESTION) < start.index(f"run `node scripts/{SEARCH}`")
    assert not start.lstrip().startswith(f"Run `node scripts/{SEARCH}`")


def test_the_question_is_asked_only_when_unclear_and_is_plain() -> None:
    text = decision()
    assert f'ask exactly: "{QUESTION}"' in text
    assert "Only when it is genuinely unclear" in text
    for technical in ("worktree", "branch", "ledger", "session", "slug"):
        assert technical not in QUESTION.lower(), technical
    assert "Never mention worktrees, branches or ledgers" in text


def test_the_persons_own_words_settle_it_without_asking() -> None:
    text = decision()
    resume = text[text.index("already say resume") : text.index("already say new")]
    for phrase in ('"pick up where I left off"', '"resume"', "a named session or slug"):
        assert phrase in resume, phrase
    assert "without asking" in resume
    new = text[text.index("already say new") : text.index("Only when it is genuinely unclear")]
    assert "a ClosedLoop ticket" in new
    assert "a description of new work" in new
    assert "without asking" in new


def test_a_new_session_skips_the_search_entirely() -> None:
    assert "A new session skips the search entirely" in decision()
    assert SEARCH not in starting_new()
    assert "never search previous sessions" in starting_new()
    # The old up-front matching of a new request against every session is gone.
    start = start_section()
    assert "match it against the summaries" not in start
    assert "mention the open sessions" not in start


def test_the_search_runs_only_after_resume_was_chosen() -> None:
    skill = VIBE_SKILL.read_text()
    resume = section(skill, RESUME)
    assert resume.index("Only after the person chose resume") < resume.index(f"run `node scripts/{SEARCH}`")
    assert "Never resume on a guess" in resume
    assert "offer the matching session first" in resume
    assert "nothing to pick up" in resume
    # The only place vibe runs the search is the resume path.
    runs = [m.start() for m in re.finditer(re.escape(f"node scripts/{SEARCH}"), flat(skill))]
    assert len(runs) == 1
    assert flat(skill).index(RESUME) < runs[0]


def test_handoff_still_uses_the_unchanged_list_command() -> None:
    assert f"node ../vibe/scripts/{SEARCH}" in HANDOFF_SKILL.read_text()
    assert 'case "list":' in SESSIONS_SCRIPT.read_text()
