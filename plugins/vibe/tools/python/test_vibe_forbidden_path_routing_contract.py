"""Contract checks for forbidden-path routing and the Storybook allowance in vibe sessions.

1. When a request genuinely needs a change in a path a vibe session may never
   edit (`scripts/**`, `.github/**`, an `AGENTS.md`), the writer leaves the path
   untouched, builds no substitute in an allowed path, logs the need as
   `Engineering needed (forbidden path): <path or area>; why: <need>`, and keeps
   building the allowed parts. It never blocks the session or reaches the person.
2. The ticket worker places each logged need once, as an unchecked item at the
   end of the live ticket's Engineering checklist.
3. A needed fix to vibe's own tooling still stops the session; the two rules
   stay distinct.
4. All of `apps/storybook/**` is allowed, explicitly including the `.storybook/`
   config, `TAXONOMY.md` and `apps/storybook/scripts/`, while the Never
   column's `scripts/**` stays the repo-root folder.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
VIBE_SKILL = VIBE / "SKILL.md"
GUARDRAILS = VIBE / "references" / "guardrails.md"
TICKET_TEMPLATE = VIBE / "references" / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
README = PLUGIN_ROOT / "README.md"
LOG_SHAPE = "`Engineering needed (forbidden path): <path or area>; why: <need>`"
CHECKLIST_SHAPE = "`- [ ] Engineering needed (forbidden path): <path or area>; why: <need>`"
TAG = "`Engineering needed (forbidden path)`"


def routing_rule() -> str:
    return paragraph(GUARDRAILS.read_text(), "genuinely needs a change in a Never path")


def test_the_guardrails_route_a_forbidden_path_need_to_engineering_without_stopping() -> None:
    rule = routing_rule()
    assert rule in section(GUARDRAILS.read_text(), "## What may change")
    for required in (
        "(a source gate under `scripts/**`, a workflow under `.github/**`, a rule in an `AGENTS.md`), that part is engineering's.",
        "The writer never edits the path and never builds a substitute for it in an allowed path",
        f"It logs the need in the session change log as {LOG_SHAPE} and keeps building every allowed part of the request.",
        "The need is not `BLOCKED`, not a question for the person, and never stops the session;",
        "the ticket worker carries each one to the live ticket's Engineering checklist (`ticket-template.md`, \"Engineering needed\")",
    ):
        assert required in rule, required


def test_the_tooling_fix_rule_stays_a_stop_and_stays_distinct() -> None:
    rule = routing_rule()
    assert "A fix to vibe's own tooling is different and still stops the session (\"Plugins and tooling\", above)." in rule
    tooling = section(GUARDRAILS.read_text(), "## Plugins and tooling")
    assert "When continuing needs a fix to the vibe tooling, stop." in tooling
    assert "Engineering needed" not in tooling


def test_the_writer_logs_the_need_builds_the_rest_and_never_blocks() -> None:
    writer = paragraph(agent("vibe-change-worker"), "When part of a request needs a change in a path you may never edit")
    for required in (
        "(`../skills/vibe/references/guardrails.md`, \"What may change\": the Never column, such as `scripts/**`, `.github/**` or any `AGENTS.md`)",
        "leave that path untouched and build no substitute for it in an allowed path.",
        f"Log {LOG_SHAPE} in the change log and keep building every allowed part.",
        "It is never `BLOCKED` or `NEEDS_PERSON`.",
    ):
        assert required in writer, required
    skill = paragraph(VIBE_SKILL.read_text(), "A part that needs a path the writer may never edit")
    assert f"is logged as {TAG} for the live ticket's Engineering checklist while the writer builds the rest" in skill
    assert "it never stops the request and is never a question for the person." in skill


def test_the_template_places_each_need_once_as_an_unchecked_engineering_item() -> None:
    template = TICKET_TEMPLATE.read_text()
    rule = paragraph(template, "- Engineering needed:")
    for required in (
        f"each {TAG} entry the change log records (`guardrails.md`, \"What may change\") goes once at the end of the Engineering checklist as {CHECKLIST_SHAPE}",
        "the same path or area logged again is the same item.",
        "Never in the Handoff section, and never routed to the person running the session.",
    ):
        assert required in rule, required
    assert "| Engineering checklist | `vibe-ticket-worker` | session start; handoff appends engineering conflicts, forbidden-path needs, compile-only v1.0 repairs and engineering decisions |" in template
    assert "Engineering needed" not in section(template, "## Handoff")


def test_the_ticket_worker_and_handoff_carry_each_need_to_the_checklist() -> None:
    ticket = flat(agent("vibe-ticket-worker"))
    assert (
        f"Place each {TAG} entry in the change log once, as an unchecked item at the end of the Engineering "
        "checklist in its logged shape (`../skills/vibe/references/ticket-template.md`, \"Engineering needed\")."
    ) in ticket
    guardrail = section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    assert (
        f"A `forbidden` or outside-allowed path the request genuinely needed is removed and logged as {TAG} "
        "(`../vibe/references/guardrails.md`, \"What may change\"), and the ticket worker puts it on the Engineering checklist."
    ) in guardrail


def test_all_of_apps_storybook_is_explicitly_allowed() -> None:
    allowed = section(GUARDRAILS.read_text(), "## What may change")
    # operator ruling, 2026-10-16: the row's Never cell now names apps/desktop/scripts/** explicitly.
    assert "| `*.stories.tsx` anywhere above, and all of `apps/storybook/**` (below) | `apps/desktop/scripts/**`" in allowed
    assert "story wiring |" not in allowed
    wiring = paragraph(GUARDRAILS.read_text(), "All of `apps/storybook/**` is Storybook wiring")
    for required in (
        "the `.storybook/` config (`main.ts`, `preview.tsx`, `manager.ts`, decorators, toolbar globals), `TAXONOMY.md`, and `apps/storybook/scripts/`",
        "(catalog sync and the taxonomy classification sets \"Missing primitives\" below has the writer edit)",
        "Its `AGENTS.md` and `CLAUDE.md` stay off limits like every other,",
        "its story validators are checks (\"Checks\", below)",
        "The `scripts/**` in the Never column is the repo-root `scripts/` folder, never `apps/storybook/scripts/`.",
    ):
        assert required in wiring, required
    assert "| `packages/design-system/**` (primitives, tokens, stories) | `scripts/**` (one exception below) |" in allowed
    assert "`apps/storybook/scripts/taxonomy-classification.mjs`" in section(GUARDRAILS.read_text(), "## Missing primitives")


def test_the_readme_states_both_rules() -> None:
    readme = paragraph(README.read_text(), "The writer may edit all of `apps/storybook/**`")
    for required in (
        "including its `.storybook/` config, `TAXONOMY.md` and `apps/storybook/scripts/`.",
        "such as the repo-root `scripts/**`, `.github/**` or an `AGENTS.md`",
        f"builds no substitute elsewhere, logs it as {TAG} and builds the rest;",
        "handoff puts each one on the live ticket's Engineering checklist.",
    ):
        assert required in readme, required
