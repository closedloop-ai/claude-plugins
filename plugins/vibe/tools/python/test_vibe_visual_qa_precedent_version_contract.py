"""Contract checks for the 2026-10-16 operator rulings from a product meeting.

1. Visual QA checks the change against the acceptance criteria when the ticket
   or its PRD has them, and otherwise is the design pack's best-practice review.
2. When the product's behavior in a situation is unspecified, how a mature app
   handles the same situation is the default answer.
3. A product question follows one shared order ending in live Asana in the
   operator's signed-in browser; public help centers are never precedent.
4. Every vibe start checks the plugin version, asks "keep going or update" when
   it is outdated, helps with the update and asks for a reopen, and carries on
   when the check cannot run.
5. The orchestrator offers visual QA at each visible milestone, never on a small
   edit, and the build loop is otherwise unchanged.
6. "Looks good, make it polished" runs visual QA before handoff unless the change
   shows nothing visible or the person declined it for that version.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
VIBE_SKILL = VIBE / "SKILL.md"
REFERENCES = VIBE / "references"
QUALITY = REFERENCES / "quality-loop.md"
GUARDRAILS = REFERENCES / "guardrails.md"
INSTALL = VIBE / "INSTALL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
PLUGIN_VERSION = VIBE / "scripts" / "plugin-version.mjs"
PRECEDENT = VIBE / "scripts" / "precedent-check.mjs"
OFFER_WITH_CRITERIA = "Want me to check how it looks against the ticket's requirements and fix anything that's off?"
OFFER_WITHOUT = "Want me to check how it looks against our design standards and fix anything that's off?"


def visual_qa() -> str:
    return section(QUALITY.read_text(), "## Visual QA during the session")


def precedent() -> str:
    return section(QUALITY.read_text(), "### Precedent before asking")


def plugin_version() -> str:
    return section(VIBE_SKILL.read_text(), "### Plugin version")


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def test_visual_qa_checks_the_criteria_or_falls_back_to_the_design_pack() -> None:
    assert_all(visual_qa(), (
        "This section adds an opt-in visual QA the orchestrator offers during the session",
        "takes precedence over the lean build loop's rule that leaves visual QA to handoff alone",
        "in Codex and Claude Code alike",
        "`/visual-qa` in Claude Code, `$visual-qa` in Codex",
        "`/design` and `$design`",
        "When the linked ticket or its PRD has acceptance criteria, visual QA checks the change against them",
        "`## Acceptance Criteria` list",
        "When neither has any, it falls back to the design pack's best-practice review, against `.claude/design/soul.md`",
        "It changes no code.",
        "Its confirmed findings go to the SAME writer as one fix request",
        "never new user-visible words",
    ))
    qa = section(HANDOFF_SKILL.read_text(), "### Browser E2E and the repository's QA passes")
    assert "against the session's acceptance criteria when the ticket or its PRD has them" in qa
    assert "otherwise as the design pack's best-practice review" in qa
    assert '"Visual QA during the session"' in qa


def test_visual_qa_is_offered_at_visible_milestones_and_never_on_a_small_edit() -> None:
    rule = visual_qa()
    assert_all(rule, (
        "At each visible milestone, the ready message offers it, without waiting for the person to think of it",
        "when a user-visible change is first ready to look at, and again after a major visible change",
        "Never on a small edit",
        "never for a change that shows nothing visible",
        "`scripts/session-questions.mjs` with the key `visual-qa:<request ID>`",
        "each milestone's offer is asked once",
        OFFER_WITH_CRITERIA,
        OFFER_WITHOUT,
        "A no is recorded and declines visual QA for that version of the change, until the next visible milestone.",
    ))
    deploy = section(VIBE_SKILL.read_text(), "## 6. Deploy each change")
    assert_all(deploy, (
        "When this deploy is a visible milestone",
        "never a small edit",
        "the ready message also offers visual QA, without waiting for the person to think of it",
        "When the person says it looks good and wants it polished, run visual QA before handoff without asking",
    ))


def test_a_polish_request_runs_visual_qa_unless_nothing_is_visible_or_it_was_declined() -> None:
    assert_all(section(QUALITY.read_text(), "### When the person asks for polish"), (
        "\"looks good, make it polished\"",
        "run visual QA before handoff without asking",
        "Skip it only when the change shows nothing visible, or when the person already declined visual QA for this version of the change",
        "an ordinary request under `guardrails.md`, \"Making something look better\"",
    ))
    deploy = section(VIBE_SKILL.read_text(), "## 6. Deploy each change")
    assert "wants it polished, run visual QA before handoff without asking" in deploy
    assert "already declined it for this version" in deploy


def test_the_build_loop_is_otherwise_unchanged() -> None:
    lean = section(QUALITY.read_text(), "## Lean build loop")
    assert "never during the loop" in lean
    assert "Visual QA can also run between requests, outside the loop" in lean
    assert "never inside a request's build, and it never holds a deploy back" in lean
    assert "The reference check before ready is the one exception to this rule" in lean
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert "Visual QA runs at handoff too, and during the session only when the person accepts the offer or asks for polish" in loop
    assert "No reviewer, browser E2E, visual QA, logical QA" in loop
    writer = flat(agent("vibe-change-worker"))
    assert "do not run or request them in the loop" in writer
    assert "its confirmed findings reach you as a fix request" in writer
    guardrails = flat(GUARDRAILS.read_text())
    assert "Outside the loop, visual QA also runs during the session when the person accepts it or asks for polish" in guardrails
    assert "Reviews and heavy validation run only at handoff" not in guardrails


def test_precedent_is_checked_in_order_before_any_question() -> None:
    rule = precedent()
    assert_all(rule, (
        "The ordered list above is the only product-question research order",
        "live Asana is the precedent",
        "Public help centers, documentation and search results are not a substitute",
    ))
    communication = section(QUALITY.read_text(), "## Communication and product questions")
    assert "runs the precedent check below before asking any question it can settle" in communication
    skill = flat(VIBE_SKILL.read_text())
    assert "Research product questions in the single order" in skill
    assert "and the precedent check (`references/quality-loop.md`, \"Communication and product questions\")" in skill
    assert 'then the precedent check ("Precedent before asking")' in flat(HANDOFF_SKILL.read_text())


def test_each_harness_has_its_precedent_path() -> None:
    assert_all(precedent(), (
        "`scripts/precedent-check.mjs` holds the research brief and its safety rules once, for both harnesses",
        "whichever actor has the operator's signed-in Chrome",
        "`node scripts/precedent-check.mjs run --question",
        "headless `claude -p --chrome`",
        "Codex: no computer use",
        "returns `NEEDS_PERSON` to the orchestrator",
    ))
    assert "`scripts/precedent-check.mjs`" in section(VIBE_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    mode = section(agent("vibe-requirements-worker"), "## Precedent mode")
    assert_all(mode, (
        "live Asana in the operator's signed-in Chrome",
        "never a public help center",
        "return `NEEDS_PERSON` to the orchestrator",
        "never its wording as our copy",
    ))


def test_precedent_research_never_touches_real_data() -> None:
    assert_all(precedent(), (
        "nobody signs in, creates an account or types a credential",
        "Nothing that already exists is touched",
        "one new private project named `zz vibe precedent check (temp)`, with no members and notifications off",
        "every created task prefixed `zz test`",
        "everything created is deleted at the end and confirmed gone in the report",
        "goes only as far as its confirmation step and is canceled there",
        "Every state is verified",
        "a hover can look like a completed task",
        "only what was observed directly counts as precedent evidence",
        "reported as `undocumented`, never guessed",
    ))
    brief = PRECEDENT.read_text()
    assert 'TEMP_PROJECT = "zz vibe precedent check (temp)"' in brief
    assert 'TASK_PREFIX = "zz test"' in brief


def test_a_precedent_is_recorded_with_its_source_and_is_not_a_human_ruling() -> None:
    assert_all(precedent(), (
        "records it in the session decision table as the decision for the affected rows, with its source",
        "`Asana, observed <date>`",
        "A precedent is the default, not a human ruling",
        "a later human statement supersedes it with an explicit `Superseded` entry",
        "settles behavior, never user-visible words",
    ))
    writer = flat(agent("vibe-change-worker"))
    assert "record it in the session decision table as the decision for the affected rows with its source" in writer
    assert "never as a human ruling" in writer


def test_the_version_check_runs_at_every_start_and_never_blocks() -> None:
    assert_all(plugin_version(), (
        "Every `$vibe` start, new or resume, first checks whether this plugin is the latest release",
        "It runs once per conversation, so its question is never repeated and does not go through `session-questions.mjs`.",
        "`node scripts/plugin-version.mjs --runtime codex` in Codex, or `--runtime claude` in Claude Code",
        "`current`: say nothing about it and continue.",
        "the check never blocks",
        "\"I couldn't check whether vibe is up to date, so I'm carrying on with the version you have.\"",
        "\"A newer version of vibe is available (you have <installed>, the latest is <latest>). Do you want to keep going with this one, or update now?\"",
        "On \"keep going\", continue with this version.",
        "run each command in its `update` list in order yourself",
        "Quit the ChatGPT app completely (press Cmd and Q), open it again, start a new chat and type $vibe.",
        "Close this Claude Code session, start a new one and type /vibe:vibe.",
        "Then stop: the update is used only from a new session.",
        "never retry it another way",
    ))
    asked_once = section(VIBE_SKILL.read_text(), "### Questions are asked once")
    assert "except the startup version question, which runs once per conversation" in asked_once


def test_the_person_chosen_update_is_the_one_plugin_change_allowed() -> None:
    tooling = section(GUARDRAILS.read_text(), "## Plugins and tooling")
    assert_all(tooling, (
        "The one exception is the vibe update the person chooses when the startup version check finds a newer release (`SKILL.md`, section 1, \"Plugin version\")",
        "the orchestrator runs exactly the update commands `plugin-version.mjs` printed, and nothing else",
    ))
    role = section(VIBE_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    assert "apart from the update the person chooses at startup" in role
    assert "run the update commands `plugin-version.mjs` prints, only when the person chose to update" in role


def test_the_update_commands_match_the_install_guide() -> None:
    script = PLUGIN_VERSION.read_text()
    install = flat(INSTALL.read_text())
    for command in ("plugin marketplace upgrade closedloop-ai", "plugin add vibe@closedloop-ai",
                    "plugin add closedloop-core@closedloop-ai"):
        assert command in install, command
    assert "plugin marketplace upgrade ${MARKETPLACE}" in script
    assert "plugin add vibe@${MARKETPLACE}" in script
    assert "plugin add closedloop-core@${MARKETPLACE}" in script
    assert "claude plugin marketplace update ${MARKETPLACE}" in script
    assert "claude plugin update vibe@${MARKETPLACE}" in script
    assert "`$vibe` checks this itself at the start of every session" in install


def test_codex_uses_no_computer_use_and_visual_requests_name_the_pushed_head() -> None:
    plugin = VIBE_SKILL.parents[2]
    docs = [*(plugin / "agents").glob("*.md"), *(VIBE_SKILL.parent / "references").glob("*.md"), VIBE_SKILL,
            VIBE_SKILL.parent / "INSTALL.md", plugin / "skills" / "handoff" / "SKILL.md"]
    for path in docs:
        for paragraph in re.split(r"\n\s*\n|\n(?=- )|\n(?=\| )", path.read_text()):
            if re.search("computer use", paragraph, re.IGNORECASE):
                assert re.search(r"\b(?:never|not|no)\b", paragraph, re.IGNORECASE), f"{path.name}: {flat(paragraph)[:160]}"
    rules = section((VIBE_SKILL.parent / "references" / "guardrails.md").read_text(), "## Processes and state")
    for phrase in ("In Codex, no computer use", "GitHub only through `gh`", "owned Claude launcher",
                   "written request made after the push", "the pushed head (never a local SHA)"):
        assert phrase in rules, phrase
