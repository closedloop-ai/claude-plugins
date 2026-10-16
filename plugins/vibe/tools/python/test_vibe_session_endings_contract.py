"""Contract checks for how a vibe session ends (operator ruling, 2026-10-15).

1. Plain words that say the person will take the work through review and merge
   themselves ("i will get the pr merged", "I'll ship it myself") are an
   explicit request for a pull request and take handoff's requested pull
   request path. The person is never offered the branch to merge.
2. Handoff no longer asks "Who should pick this up next?". It settles the
   ending with one plain two-way question that never says "handoff": open a
   pull request, or pass it on. Only passing it on asks for a name or email.
3. The first reply to a new session carries one endings line as a notice that
   never waits; a resumed session does not get it.
4. On the pull request path the SAME writer authors the tests in its
   `pull-request` turn, step 7 pushes and publishes, handoff opens the pull
   request as its last step through the environment worker's `pull-request`
   mode, the ticket stays with the person, and they get the pull request link.
   No brief may say both that the person takes it to a pull request and that
   no tests are authored.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
REFERENCES = PLUGIN_ROOT / "skills" / "vibe" / "references"
GUARDRAILS = REFERENCES / "guardrails.md"
QUALITY = REFERENCES / "quality-loop.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
RECORD_CONTEXT = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src" / "record-context.ts"
RULING = "operator ruling, 2026-10-15"
TWO_WAY = ("Do you want me to open a pull request so you can take it through review and merge, "
           "or pass it to someone, usually design and then engineering, to finish?")
ENDINGS_LINE = ("When you're done, I can either open a pull request for you, "
                "or pass it to design or engineering to finish.")
PR_PHRASES = ("raise a PR", "I'll get the PR merged", "I'll ship it myself", "I want to take it through review")
BRANCH_TO_MERGE = re.compile(r"branch to merge", re.IGNORECASE)
NEGATION = re.compile(r"\b(never|not)\b", re.IGNORECASE)
HANDOFF_WORD = re.compile(r"hand ?off", re.IGNORECASE)


def plugin_texts() -> dict[str, str]:
    files = [*PLUGIN_ROOT.glob("skills/**/*.md"), *AGENTS.glob("*.md"), PLUGIN_ROOT / "README.md"]
    return {str(path.relative_to(PLUGIN_ROOT)): path.read_text() for path in files}


def test_plain_words_are_an_explicit_pull_request_request() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")
    assert "plain-language intent to take the work through review and merge themselves IS that explicit request" in rule
    assert RULING in rule
    for phrase in (*PR_PHRASES, "open a pull request", "I'll get it merged"):
        assert phrase in rule, phrase
    assert "take handoff's requested pull request path" in rule
    assert "the rule that tests are written only on that request is unchanged" in rule
    assert "That request is the only thing that authorizes test writing" in rule


def test_every_place_that_decides_a_pull_request_request_recognizes_plain_words() -> None:
    requested = section(HANDOFF_SKILL.read_text(), "## A requested pull request")
    tests_rule = flat(VIBE_SKILL.read_text())
    ending = section(VIBE_SKILL.read_text(), "## 8. Ending a session")
    writer = section(agent("vibe-change-worker"), "## Tests: repair, don't author")
    for phrase in PR_PHRASES:
        for name, text in (("handoff", requested), ("vibe", tests_rule), ("ending", ending), ("writer", writer)):
            assert phrase in text, (name, phrase)
    assert "plain-language intent to take the work through review and merge themselves IS that request" in requested
    assert "takes the handoff skill's requested pull request path" in tests_rule
    assert "choose the pull request. Run the handoff skill with that choice; ask nothing more." in ending
    assert "only the orchestrator's `pull-request` turn carries the authority" in writer
    assert "plain-language intent counts" in section(QUALITY.read_text(), "## One persistent writer and a serial queue")
    assert "in any plain words" in section(QUALITY.read_text(), "## Tests: repair, don't author")


def test_the_two_way_question_replaces_who_picks_it_up() -> None:
    handoff = HANDOFF_SKILL.read_text()
    settle = section(handoff, "### Settle how it ends")
    assert TWO_WAY in settle
    assert "Never ask for a name before they choose passing it on" in settle
    assert "never jump straight to asking for a name" in settle
    assert "never re-ask it" in settle
    assert TWO_WAY in section(VIBE_SKILL.read_text(), "## 8. Ending a session")
    assert not HANDOFF_WORD.search(TWO_WAY)
    step_eight = section(handoff, "## 8. Choose who picks it up, then check the ticket")
    assert "Who should I pass it to? A name or email is fine." in step_eight
    assert "On a requested pull request (step 0), skip the question and the lookup" in step_eight
    for name, text in plugin_texts().items():
        assert "Who should pick this up next?" not in text, name
        assert "Hand this off now" not in text, name


def test_the_person_never_hears_handoff_as_an_unexplained_term() -> None:
    ending = section(VIBE_SKILL.read_text(), "## 8. Ending a session")
    assert 'Never use the word "handoff" with the person as if they know it' in ending
    assert 'Never say "handoff" to the person as if they know the word' in flat(HANDOFF_SKILL.read_text())
    resume = section(VIBE_SKILL.read_text(), "### Finding a session to resume")
    stale = re.search(r'"This one isn\'t finished yet\.[^"]*"', resume)
    assert stale, resume
    assert not HANDOFF_WORD.search(stale.group(0))
    description = HANDOFF_SKILL.read_text().split("---", 2)[1]
    assert 'Use when someone says "handoff", "hand this off"' in description


def test_the_endings_line_is_a_non_blocking_notice_in_a_new_sessions_first_reply_only() -> None:
    skill = VIBE_SKILL.read_text()
    notices = section(skill, "### Notices that never wait")
    assert "- Endings. In the first reply to a NEW session" in notices
    assert ENDINGS_LINE in notices
    assert "It is a notice, not a question" in notices
    assert "nothing waits on it" in notices
    assert "Never add it when resuming a session" in notices
    starting = section(skill, "### Starting new")
    assert starting.index("carries the endings line") < starting.index("ask what they want to work on")
    assert "A resumed session gets no endings line." in section(skill, "### Mockup sessions")
    assert ENDINGS_LINE not in section(skill, "### Finding a session to resume")
    assert "the endings line in a new session's first reply" in flat(skill[: skill.index("## Harness notes")])


def test_nothing_offers_the_branch_to_merge() -> None:
    for name, text in plugin_texts().items():
        flattened = flat(text)
        for match in BRANCH_TO_MERGE.finditer(flattened):
            before = flattened[max(0, match.start() - 80) : match.start()]
            assert NEGATION.search(before), (name, flattened[max(0, match.start() - 80) : match.end()])
    final = section(HANDOFF_SKILL.read_text(), "## 9. Hand it over")
    assert "the pull request link, and that they take it through review and merge from there; never the branch to merge" in final


def test_handoff_opens_the_requested_pull_request_as_its_last_step() -> None:
    handoff = HANDOFF_SKILL.read_text()
    requested = section(handoff, "## A requested pull request")
    assert "Handoff opens the pull request as its last step" in requested
    assert "the ticket stays with the person" in requested
    final = section(handoff, "## 9. Hand it over")
    assert "On a requested pull request, skip assign mode" in final
    assert "`vibe-environment-worker` in `pull-request` mode" in final
    assert "it never enqueues or merges it" in final
    for retired in ("Handoff itself still opens none", "It ends at the branch; no pull request is opened"):
        assert retired not in flat(handoff), retired
    assert "ends at the branch without opening a pull request" not in flat((PLUGIN_ROOT / "README.md").read_text())
    assert "Opening a requested pull request | `vibe-environment-worker` (`pull-request` mode)" in flat(handoff)


def test_the_environment_worker_opens_the_pull_request_from_the_template_and_never_merges() -> None:
    worker = agent("vibe-environment-worker")
    mode = section(worker, "## Pull-request mode")
    for required in ("no push, no commit", "gh pr create --repo closedloop-ai/symphony-alpha --base main",
                     ".github/pull_request_template.md", "never from invention",
                     "only when Production impact supports it", "`[ui-flag:gated] <key>` or `[ui-flag:N/A] <reason>`",
                     "at most 20 lines", "at most 72 characters including the ` (#NNNN)`",
                     "say so in that section for the reviewer instead of inventing one",
                     "Never add the `warning-acknowledged` label, request reviewers, trigger CI by hand, "
                     "arm auto-merge, enqueue or merge", "never push to make it so"):
        assert required in mode, required
    assert "`pull-request`), the worktree path" in flat(worker)
    record = RECORD_CONTEXT.read_text()
    assert '"pull-request": [] }' in record
    assert '"pull-request"]);' in record


def test_the_ticket_stays_with_the_person_on_the_pull_request_path() -> None:
    template = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    assert "- Next: <the next owner the person chose at handoff, by full name>" in template
    assert ("Next: <the person who ran the session, by full name> takes this through review and merge "
            "in the pull request handoff opens from this branch.") in template
    assert "The ticket stays assigned to them." in template
    handoff_mode = section(agent("vibe-ticket-worker"), "## Handoff mode")
    assert "that owner is the session's operator and the line takes the template's pull request form" in handoff_mode


def test_a_requested_pull_request_runs_the_tests_the_push_and_one_consistent_brief() -> None:
    requested = section(HANDOFF_SKILL.read_text(), "## A requested pull request")
    assert "Resume the SAME writer in `pull-request` mode" in requested
    assert "step 7's commit and its push and publication through `vibe-environment-worker` in redeploy mode" in requested
    assert "every brief in this handoff" in requested
    assert "carries the `pull-request` phase" in requested
    assert ("No brief may say both that the person takes the work to a pull request and that no tests are "
            "authored") in requested
