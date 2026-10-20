"""Contract checks for the 2026-10-20 operator ruling on feature flag sprawl.

About 14 symphony-alpha vibe sessions each added PostHog keys and nothing
challenged them: one gated a single Branches list redesign behind three keys,
writers gated edits to shipped surfaces, and no handoff said which keys to
turn on. Each lesson lands in the owner of the behavior:

1. `guardrails.md`, "Feature flags", is the one canonical statement: the
   target repo's own rule decides (read from the checkout, not this plugin),
   every new key or read is justified with a human source, one behavior gets
   one key, and an existing key is reused.
2. The writer justifies before building and records the set.
3. The guardrails reviewer checks every key the diff adds or depends on.
4. Handoff, the ticket, the summarizer and the pull request carry the keys to
   see the work per surface; the live ticket check refuses a ticket without
   them, and `vibe-sessions.mjs list` shows them across sessions.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
GUARDRAILS = VIBE / "references" / "guardrails.md"
TICKET_TEMPLATE = VIBE / "references" / "ticket-template.md"
VIBE_SKILL = VIBE / "SKILL.md"
SESSIONS_SCRIPT = VIBE / "scripts" / "vibe-sessions.mjs"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
TICKET_CHECK = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "live-ticket-check.mjs"
RULING = "operator ruling, 2026-10-20"
CANONICAL = '"Feature flags"'


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def test_the_canonical_rule_reads_the_target_repo_and_needs_a_human_source() -> None:
    rule = section(GUARDRAILS.read_text(), "## Feature flags")
    assert_all(rule, (
        "Operator ruling, 2026-10-20",
        "`branches-list-adapter-connected`",
        "The target repo's rule decides, never this file.",
        "an existing key read in a new place counts",
        "read the rule from the checkout",
        "Quote the sentence the key relies on",
        "No justification means no flag.",
        "An agent-written plan, PLN, decision table or change log is never the source",
        "is built ungated",
        "One behavior, one key. Staged rollout states",
        "never more keys",
        "One key gates every host the surface exists on, web and Desktop",
        "Reuse first.",
        "`vibe-sessions.mjs list` for keys other sessions recorded on the same surface",
        "`vibe-sessions.mjs flag-keys --worktree <wt> --file <flag-keys.json>`",
        "the existing keys the changed code already sits behind included",
        "a second new key on one surface",
        '"Keys to see this work"',
    ))


def test_the_closed_by_default_paragraph_points_at_the_repo_rule_instead_of_restating_it() -> None:
    text = flat(GUARDRAILS.read_text())
    assert "the target repo's own flag rule decides which keys the work may add or read" in text
    assert "net-new screen, surface, or navigation item ships behind a default-off PostHog flag" not in text
    labs = section(GUARDRAILS.read_text(), "## Labs")
    assert "record both keys with `flag-keys`" in labs


def test_the_writer_justifies_every_new_key_or_read_before_building_it() -> None:
    writer = paragraph(agent("vibe-change-worker"), "Before you add a feature flag key or a new read of any key")
    assert_all(writer, (
        CANONICAL,
        RULING,
        "quote the target repo's own flag rule from its `AGENTS.md`",
        "With no justification, build the change ungated.",
        "Never split one behavior across several keys",
        "Reuse the key that already gates the surface.",
        "`vibe-sessions.mjs flag-keys`",
        "is never `NEEDS_PERSON`: the answer is no flag",
    ))
    assert "keeps the set current with `vibe-sessions.mjs flag-keys`" in flat(VIBE_SKILL.read_text())


def test_the_guardrails_reviewer_checks_every_key_the_session_adds_or_depends_on() -> None:
    reviewer = agent("vibe-guardrails-reviewer")
    check = paragraph(reviewer, "17. Flag keys")
    assert_all(check, (
        CANONICAL,
        RULING,
        "read the target repo's flag rule from the checkout's `AGENTS.md` files yourself",
        "every existing key the changed code sits behind",
        "the record's `flagKeys`",
        "cites only an agent-written plan",
        "a gate on a change the repo rule says ships directly",
        "staged rollout states as separate keys included",
        "another session's `list` entry records",
        "different keys on web and Desktop",
        "a key the diff reads that the record does not list",
    ))
    assert "blocking" in check
    description = reviewer.split("\n", 4)[2]
    assert "every flag key the session adds or depends on" in description


def test_handoff_routes_flag_findings_to_the_writer_and_tells_the_person_the_keys() -> None:
    handoff = flat(HANDOFF_SKILL.read_text())
    assert_all(handoff, (
        "A flag key finding (the reviewer's check 17",
        "builds the change ungated or reuses the existing key",
        "never a question for the person",
        "the live ticket check refuses a ticket without them",
        'and its "Keys to see this work" block',
    ))
    hand_over = section(HANDOFF_SKILL.read_text(), "## 9. Hand it over")
    assert "the keys to see the work from the ticket's \"Keys to see this work\"" in hand_over
    assert "named exactly" in hand_over


def test_the_ticket_summary_and_pull_request_carry_the_keys_and_justifications() -> None:
    template = flat(TICKET_TEMPLATE.read_text())
    assert "then \"Keys to see this work\": per surface and host, every key that must be on" in template
    assert "its justification from the session record's `flagKeys`" in template
    summarizer = flat(agent("vibe-handoff-summarizer"))
    assert "the keys to see the work per surface and host from the record's `flagKeys`" in summarizer
    ticket = flat(agent("vibe-ticket-worker"))
    assert "The keys to see the work reach the ticket only through `ticket-sections`" in ticket
    environment = flat(agent("vibe-environment-worker"))
    assert "keys to see the work per surface and host, copied from the \"Keys to see this work\" block" in environment
    assert "citing the new key's recorded justification" in environment


def test_the_record_command_the_rule_names_exists_and_the_ticket_check_requires_its_block() -> None:
    script = SESSIONS_SCRIPT.read_text()
    assert 'case "flag-keys":' in script
    assert "flagKeys: listedFlagKeys(" in script
    assert '"lists no keys to see the work"' in TICKET_CHECK.read_text()
