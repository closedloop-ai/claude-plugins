"""Contract checks for the 2026-10-20 operator rulings on feature flag sprawl and tech debt.

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
5. No agent creates or adds a flag on its own: the person approves each key
   in the session, after seeing the key, why, what it gates and the full
   stack; no answer means no flag.
6. Flags are one case of a general principle, no new tech debt without a
   cited reason, which the existing owners apply.
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
RULING = "operator ruling, 2026-10-20"
CANONICAL = '"Feature flags"'


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def test_the_canonical_rule_reads_the_target_repo_and_needs_a_human_source() -> None:
    rule = section(GUARDRAILS.read_text(), "## Feature flags")
    assert_all(rule, (
        "Operator rulings, 2026-10-20",
        "`branches-list-adapter-connected`",
        "The target repo's rule decides what may even be proposed, never this file.",
        "an existing key read in a new place counts",
        "read the rule from the checkout",
        "quote the sentence the key relies on",
        "is built ungated and never proposed",
        "One behavior, one key. Staged rollout states",
        "never more keys",
        "One key gates every host the surface exists on, web and Desktop",
        "Reuse first.",
        "`vibe-sessions.mjs list` for keys other sessions recorded on the same surface",
        "`flag-keys.mjs record --worktree <wt> --file <flag-keys.json>`",
        "the existing keys the changed code already sits behind included",
        "a second new key on one surface",
        "a read of a key the person has not approved",
        '"Keys to see this work"',
    ))


def test_the_closed_by_default_paragraph_points_at_the_repo_rule_instead_of_restating_it() -> None:
    text = flat(GUARDRAILS.read_text())
    assert "the target repo's own flag rule decides which keys the work may add or read" in text
    assert "net-new screen, surface, or navigation item ships behind a default-off PostHog flag" not in text
    labs = section(GUARDRAILS.read_text(), "## Labs")
    assert "the person approves each one, and `flag-keys.mjs record` keeps them" in labs


def test_the_writer_justifies_and_proposes_but_never_adds_a_flag_on_its_own() -> None:
    writer = paragraph(agent("vibe-change-worker"), "You never create or add a feature flag on your own")
    assert_all(writer, (
        CANONICAL,
        RULING,
        "quote the target repo's own flag rule from its `AGENTS.md`",
        "With no justification, build the change ungated and ask nothing.",
        "Never split one behavior across several keys",
        "Reuse the key that already gates the surface.",
        "A justified key is only a proposal",
        "return `NEEDS_FLAG_APPROVAL` naming the key",
        "Add the gate only after the orchestrator resumes you with the person's recorded yes for that key",
        "on a no or no answer, keep it ungated",
    ))
    assert "`NEEDS_FLAG_APPROVAL` names a proposed flag key the person must approve" in flat(agent("vibe-change-worker"))


def test_the_person_approves_each_key_after_seeing_why_what_it_gates_and_the_whole_stack() -> None:
    rule = section(GUARDRAILS.read_text(), "## Feature flags")
    assert_all(rule, (
        "So no agent creates or adds a feature flag on its own: the person approves each key in the session.",
        "the justification is the input to that question, never a substitute for it",
        "every other key the same work also sits behind there, so the person sees the whole stack",
        "Only an explicit yes from the person running the session lets the key be built",
        "which saves who and when and refuses an answer to any other question",
        "No answer, or a run with nobody to ask, leaves the key pending and builds no flag; never assume a yes.",
        "An approval covers one key and the exact proposal it answered",
    ))
    skill = section(VIBE_SKILL.read_text(), "## 7. Feature flags")
    assert_all(skill, (
        "When the writer returns `NEEDS_FLAG_APPROVAL` for a key",
        "`node scripts/flag-keys.mjs question --worktree \"<wt>\" --key <key>`",
        "in exactly those words through `session-questions.mjs`",
        "one key per question",
        "It skips the product research and precedent gate",
        "`approved` only for an explicit yes",
        "With no answer the key stays pending and nothing is gated.",
    ))
    assert "`NEEDS_FLAG_APPROVAL` (the writer proposed a feature flag key" in flat(VIBE_SKILL.read_text())
    questions = section(QUALITY.read_text(), "## Communication and product questions")
    assert "A feature flag key is the one technical choice the person always decides" in questions
    script = FLAG_KEYS_SCRIPT.read_text()
    assert 'case "approve":' in script
    assert "only the person running it can approve a flag key" in script


def test_tech_debt_is_one_principle_applied_by_the_existing_owners() -> None:
    rule = section(GUARDRAILS.read_text(), "## No new tech debt")
    assert_all(rule, (
        "Operator ruling, 2026-10-20: a change must not grow tech debt without a cited reason.",
        "flags (\"Feature flags\") are its concrete, tested case",
        "The simpler option that reuses what exists wins by default.",
        "`Debt: <kind>; added: <what>; reused instead: <what it checked>; reason: <source>`",
        "| A parallel code path",
        "| A compatibility shim, re-export, wrapper or code kept alive for a deprecated story",
        "| A second owner for the same behavior",
        "| A duplicated helper, hook, type, const object, validator, bound or copy string",
        "| New config: an env var, setting, option or threshold",
        "| A file grown toward the repo's size ceiling",
    ))
    writer = paragraph(agent("vibe-change-worker"), "Grow no tech debt without a cited reason")
    assert_all(writer, ('"No new tech debt"', "Your own rationale is not a reason.", "With none, build the reuse"))
    reviewer = section(agent("vibe-guardrails-reviewer"), "## Check, for added or changed lines only")
    assert_all(reviewer, (
        "Every check applies one principle: a change grows no tech debt without a cited reason",
        "a new schema whose limit differs from the constant the domain already exports is blocking",
        "one the session grew is blocking",
        "keep it only for a named live consumer",
        "each second path (a route, service, writer or store for a behavior an existing one already owns)",
    ))
    assert "A tech debt finding" in flat(HANDOFF_SKILL.read_text())


def test_the_guardrails_reviewer_checks_every_key_the_session_adds_or_depends_on() -> None:
    reviewer = agent("vibe-guardrails-reviewer")
    check = paragraph(reviewer, "17. Flag keys")
    assert_all(check, (
        CANONICAL,
        RULING,
        "read the target repo's flag rule from the checkout's `AGENTS.md` files yourself",
        "every existing key the changed code sits behind",
        "with no recorded approval from the person for its current proposal",
        "an approval of one key never covers another",
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
        "a justified key with no recorded approval: ask the person its approval question once",
        "Never treat a cited source as approval.",
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


def test_the_record_commands_the_rule_names_exist_and_the_ticket_check_requires_approval() -> None:
    script = FLAG_KEYS_SCRIPT.read_text()
    for command in ('case "record":', 'case "question":', 'case "approve":', 'case "show":'):
        assert command in script
    assert "flagKeys: listedFlagKeys(" in SESSIONS_SCRIPT.read_text()
    check = TICKET_CHECK.read_text()
    assert '"lists no keys to see the work"' in check
    assert "flagKeyProblems(record)" in check
