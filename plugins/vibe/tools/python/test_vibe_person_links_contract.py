"""Contract checks for ISS-13320: vibe gives the person a link, never a bare id.

A product manager asked her session for the first thing to do and was told to
open a story by its id, which nobody outside engineering can open. Whenever
vibe points the person at something to look at, it gives a link that opens
that exact thing, built from the session record (`vibe-sessions.mjs link`).

1. The rule lives once, in `plain-words.md`, which every person-facing reply
   follows; the skills, `environment.md` and the workers whose words reach the
   person point at it.
2. The new-components notice builds its links with `link --local` and names
   each story by its gallery name.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
PLAIN_WORDS = VIBE / "references" / "plain-words.md"
ENVIRONMENT = VIBE / "references" / "environment.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
SCRIPT = VIBE / "scripts" / "vibe-sessions.mjs"
RULE = "## Links to what the person should look at"
RULE_NAME = '"Links to what the person should look at"'
PERSON_FACING_WORKERS = (
    "vibe-change-worker",
    "vibe-verify-worker",
    "vibe-prototype-worker",
    "vibe-storybook-decomposer",
    "vibe-primitive-worker",
    "vibe-handoff-summarizer",
)
WORKER_POINTER = (
    "A story or page named for the person to look at carries a link that opens it, never a bare story ID, path or "
    "route pattern: give its story ID or the page's real path for the example data, and the link comes from "
    "`../skills/vibe/scripts/vibe-sessions.mjs link` (`../skills/vibe/references/plain-words.md`, "
    f"{RULE_NAME})."
)


def test_the_rule_is_stated_once_in_plain_words() -> None:
    rule = section(PLAIN_WORDS.read_text(), RULE)
    for required in (
        "it gives a link that opens that exact thing in one click",
        "The link text is the plain name the person sees in the product",
        "A story id, file path, component name or route pattern is never the thing the person is told to open; "
        "one may appear only beside a working link to it",
        "This section is the rule's one canonical statement",
        '`node scripts/vibe-sessions.mjs link --worktree "<wt>" --story <story id>` or `--page <path>`',
        "a story on the deployed environment's Storybook once the environment is verified, otherwise on the local "
        "Storybook the session started",
        "a page as the verified app URL plus the page's real path for the example data",
        "It refuses a route pattern",
        "the ticket's `webUrl`",
        "When `link` prints `url: null`, nothing is running or deployed to open yet",
        "Otherwise say so in plain words and offer to start it",
        "Never send the id or path in its place",
    ):
        assert required in rule, required
    holders = [path.name for path in PLUGIN_ROOT.rglob("*.md") if RULE in path.read_text()]
    assert holders == ["plain-words.md"]


def test_the_word_table_sends_ids_and_paths_to_the_rule() -> None:
    table = flat(PLAIN_WORDS.read_text())
    assert (
        "| a story id, file path, component name or route pattern to look at | a link to that exact thing "
        f"({RULE_NAME}) |" in table
    )


def test_the_skills_and_storybook_rule_point_at_it() -> None:
    skill = flat(VIBE_SKILL.read_text())
    assert (
        "anything you point the person at to look at is a link that opens it "
        f"(`references/plain-words.md`, {RULE_NAME})" in skill
    )
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert "look at with a link to each changed page (`vibe-sessions.mjs link --page`;" in loop
    deploy = section(VIBE_SKILL.read_text(), "## 6. Deploy each change")
    assert f"with a link to each changed page or component (`references/plain-words.md`, {RULE_NAME})" in deploy
    handoff = flat(HANDOFF_SKILL.read_text())
    assert f'including its {RULE_NAME} (a story or page link comes from `../vibe/scripts/vibe-sessions.mjs link`)' in handoff
    assert f"Tell them, in a few lines, each as a link that opens it (`../vibe/references/plain-words.md`, {RULE_NAME})" in handoff
    storybook = section(ENVIRONMENT.read_text(), "## Storybook links")
    assert "`scripts/vibe-sessions.mjs link --story <story-id>` builds the link from the session record" in storybook
    assert f"`plain-words.md`, {RULE_NAME}" in storybook


def test_the_new_components_notice_links_each_story_by_its_gallery_name() -> None:
    notices = section(VIBE_SKILL.read_text(), "### Notices that never wait")
    assert "returns `STORIES_READY` with each new story's ID and the name the gallery shows for it" in notices
    assert '`node scripts/vibe-sessions.mjs link --worktree "<wt>" --story <id> --local`' in notices
    assert "If it prints `url: null`, no local Storybook is running: dispatch `vibe-setup-worker` to start it, then run `link` again" in notices
    assert f"and never a bare id (`references/plain-words.md`, {RULE_NAME})" in notices
    assert "[<gallery name>](<link>)" in notices
    writer = flat((AGENTS / "vibe-change-worker.md").read_text())
    assert "`STORIES_READY` with each new story's ID and the name the gallery shows for it" in writer


def test_every_worker_whose_words_reach_the_person_points_at_the_rule() -> None:
    for name in PERSON_FACING_WORKERS:
        assert WORKER_POINTER in flat((AGENTS / f"{name}.md").read_text()), name


def test_the_session_script_offers_the_link_command() -> None:
    text = SCRIPT.read_text()
    assert '//   vibe-sessions.mjs link            --worktree <path> (--story <story id> [--local] | --page <path>)' in text
    assert 'case "link":\n      return personLink();' in text
