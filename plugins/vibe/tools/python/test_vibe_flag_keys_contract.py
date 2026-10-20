"""Contract checks for the 2026-10-20 operator rulings on feature flag sprawl and tech debt.

About 14 symphony-alpha vibe sessions each added PostHog keys and nothing
challenged them: one gated a single Branches list redesign behind three keys,
writers gated edits to shipped surfaces, and no handoff said which keys to
turn on. The rules are stated once in `guardrails.md` ("No new tech debt",
"Feature flags"); every other owner points there in a line, and
`flag-keys.mjs` carries the procedure in its own messages:

1. The target repo's own flag rule decides, one behavior gets one key, and an
   existing key is reused.
2. No agent creates or adds a flag on its own: the person approves each key
   after seeing the key, why, what it gates and the full stack; no answer
   means no flag.
3. The guardrails reviewer and the live ticket check fail an unapproved key.
4. The ticket, handoff and the pull request carry the keys to see the work.
5. Flags are one case of the principle that a change grows no tech debt
   without a cited reason.
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
FLAG_KEYS_SCRIPT = VIBE / "scripts" / "flag-keys.mjs"
QUALITY = VIBE / "references" / "quality-loop.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
TICKET_CHECK = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "live-ticket-check.mjs"
CANONICAL = '"Feature flags"'


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def test_the_canonical_rule_reads_the_target_repo_and_needs_a_human_source() -> None:
    rule = section(GUARDRAILS.read_text(), "## Feature flags")
    assert_all(rule, (
        "Operator rulings, 2026-10-20",
        "No agent creates or adds a flag on its own.",
        "only for what the target repo's own flag rule allows, quoted from its `AGENTS.md`, with a human source",
        "what that rule ships directly is built ungated",
        "One behavior gets one key (rollout states are its values), one key covers web and Desktop",
        "in another session's `vibe-sessions.mjs list` entry, is reused",
        "every key the work sits behind with `scripts/flag-keys.mjs record`",
        '"Keys to see this work"',
        "An agent never adds or edits a flag registration attestation",
    ))


def test_the_closed_by_default_paragraph_points_at_the_repo_rule_instead_of_restating_it() -> None:
    text = flat(GUARDRAILS.read_text())
    assert "the target repo's flag rule decides which keys it may add (\"Feature flags\")" in text
    assert "net-new screen, surface, or navigation item ships behind a default-off PostHog flag" not in text
    labs = section(GUARDRAILS.read_text(), "## Labs")
    assert 'both keys follow "Feature flags"' in labs


def test_the_writer_justifies_and_proposes_but_never_adds_a_flag_on_its_own() -> None:
    writer = paragraph(agent("vibe-change-worker"), "Never add a flag key or read yourself")
    assert_all(writer, (CANONICAL, "propose it and return `NEEDS_FLAG_APPROVAL`", '"No new tech debt"'))
    script = FLAG_KEYS_SCRIPT.read_text()
    assert_all(script, (
        "has no justification: reason must be one of",
        "with none of them, build the change ungated",
        "one behavior gets one key, and staged rollout states are values or a rollout of that key, never more keys",
        "already gates these surfaces (reuse it if one does), build the rest without the gate, and return NEEDS_FLAG_APPROVAL",
    ))


def test_the_person_approves_each_key_after_seeing_why_what_it_gates_and_the_whole_stack() -> None:
    rule = section(GUARDRAILS.read_text(), "## Feature flags")
    assert_all(rule, (
        "The person approves each key: ask the exact words `flag-keys.mjs question` prints (the key, why, what it gates, the whole stack)",
        "Only an explicit yes builds the key; no answer or nobody to ask builds nothing.",
    ))
    skill = section(VIBE_SKILL.read_text(), "## 7. Feature flags")
    assert_all(skill, ("On `NEEDS_FLAG_APPROVAL`", "in the exact words `scripts/flag-keys.mjs question` prints", "skipping the product research gate"))
    assert "`NEEDS_FLAG_APPROVAL` (ask the person, section 7)" in flat(VIBE_SKILL.read_text())
    assert "and so does each flag key's approval" in section(QUALITY.read_text(), "## Communication and product questions")
    script = FLAG_KEYS_SCRIPT.read_text()
    assert_all(script, (
        'case "approve":',
        "only the person running it can approve a flag key",
        "one key per question, with no research or precedent gate",
        "--decision approved only for an explicit yes, otherwise declined",
        "With no answer, the key stays pending and nothing is gated.",
        "To see the work there, these switches would also have to be on:",
    ))


def test_tech_debt_is_one_principle_applied_by_the_existing_owners() -> None:
    rule = section(GUARDRAILS.read_text(), "## No new tech debt")
    assert_all(rule, (
        "Operator ruling, 2026-10-20: a change grows no tech debt without a cited reason.",
        "a parallel path (a second route, service, writer or store for a behavior one already owns)",
        "a shim, re-export or code kept only for a deprecated story, a second owner",
        "a duplicated helper, type, constant, validator or bound, new config, or growth of a file near the repo's size ceiling",
        "needs a human source or a quoted repo rule; otherwise reuse what exists",
        "`Debt: <kind>; added: <what>; reused instead: <what>; reason: <source>`",
        "its own rationale is never the reason",
    ))


def test_the_guardrails_reviewer_checks_every_key_the_session_adds_or_depends_on() -> None:
    reviewer = agent("vibe-guardrails-reviewer")
    check = paragraph(reviewer, "17. Tech debt and flag keys")
    assert_all(check, (
        '"No new tech debt"',
        CANONICAL,
        "each item of a kind that section lists with no `Debt:` reason is blocking",
        "a type, constant, validator or bound that differs from or copies the canonical one",
        "an export or component whose only importers are tests or deprecated stories",
        "growth of a file near the repo's size ceiling",
        "Read the repo's flag rule yourself",
        "every key the diff adds, newly reads or sits behind",
        "`flag-keys.mjs show --worktree <wt>`",
        "Any `problems`, a read the record lacks",
        "split keys, a gate on a change the rule ships directly",
        "A cited source is not approval.",
    ))
    assert "blocking" in check
    description = reviewer.split("\n", 4)[2]
    assert "tech debt and flag keys without a cited reason or the person's approval" in description


def test_handoff_routes_flag_findings_to_the_writer_and_tells_the_person_the_keys() -> None:
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "A flag key without the person's recorded yes gets its approval question once" in handoff
    assert "with no yes the writer removes the gate" in handoff
    hand_over = section(HANDOFF_SKILL.read_text(), "## 9. Hand it over")
    assert 'the ticket\'s "Keys to see this work"' in hand_over


def test_the_ticket_summary_and_pull_request_carry_the_keys_and_justifications() -> None:
    template = flat(TICKET_TEMPLATE.read_text())
    assert 'and "Keys to see this work" (`guardrails.md`, "Feature flags")' in template
    environment = flat(agent("vibe-environment-worker"))
    assert 'with the live ticket\'s slug and its "Keys to see this work"' in environment


def test_the_record_commands_the_rule_names_exist_and_the_ticket_check_requires_approval() -> None:
    script = FLAG_KEYS_SCRIPT.read_text()
    for command in ('case "record":', 'case "question":', 'case "approve":', 'case "show":'):
        assert command in script
    assert "flagKeys: listedFlagKeys(" in SESSIONS_SCRIPT.read_text()
    check = TICKET_CHECK.read_text()
    assert '"lists no keys to see the work"' in check
    assert "flagKeyProblems(record)" in check
