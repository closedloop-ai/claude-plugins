"""Contract checks for compile-only repairs to frozen v1.0 story files (design ruling, 2026-10-15).

1. A v1.0 story file stays frozen except for a compile-only repair: only
   mechanical changes (prop renames, imports, types), no story added or
   removed, no title, story ID or tag change and no visual change. The freeze
   protects what its stories show and their links, not the code wording. The
   placement owner states it in full; guardrails, design pass, handoff and the
   README carry a one-liner.
2. The writer never avoids a rename to protect a v1.0 story file; it repairs
   the file within those limits and logs the repair.
3. The guardrails reviewer confirms each repair is purely mechanical with no
   visual change and blocks anything else.
4. The handoff inventory lists the repairs under `compileOnlyV1Repairs`
   without blocking (its node tests prove the check), and the ticket worker
   places each one once as an unchecked Engineering checklist item.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
GUARDRAILS = VIBE / "references" / "guardrails.md"
DESIGN_PASS = VIBE / "references" / "design-pass.md"
TICKET_TEMPLATE = VIBE / "references" / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
README = PLUGIN_ROOT / "README.md"
EXCEPTION = (
    "The one exception is a compile-only repair after a rename elsewhere: only mechanical changes (prop renames, "
    "imports, types), no story added or removed, no title, story ID or tag change and no visual change, since the "
    "freeze protects what its stories show and their links, not the code wording."
)
CHECKLIST_SHAPE = (
    "`- [ ] Check compile-only repair to v1.0: <file>; confirm only prop, import or type changes and no visual change`"
)


def test_the_placement_owner_states_the_exception_in_full_once() -> None:
    order = paragraph(agent("vibe-storybook-decomposer"), "4. Decide in this order")
    assert EXCEPTION in order
    assert order.index("is frozen and never edited, not even to add a story") < order.index(EXCEPTION)
    assert "- First: a change to an existing component" in order
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if EXCEPTION in flat(path.read_text())]
    assert holders == ["vibe-storybook-decomposer.md"]


def test_guardrails_design_pass_handoff_and_readme_carry_the_one_liner() -> None:
    guardrails = flat(GUARDRAILS.read_text())
    assert (
        "A v1.0 story file (under a `<Level> v1.0/` root or tagged `deprecated`) is never edited beyond a "
        "compile-only repair (prop renames, imports, types; no story, title, tag or visual change)"
    ) in guardrails
    assert (
        "A compile-only repair of a v1.0 file does not block; it is listed under `compileOnlyV1Repairs` for the "
        "Engineering checklist."
    ) in guardrails
    assert "which is never edited beyond a compile-only repair" in paragraph(DESIGN_PASS.read_text(), "6. Placement:")
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert "a v1.0 story file is never edited beyond a compile-only repair" in storybook
    assert (
        "Its `compileOnlyV1Repairs` do not; the ticket worker puts each on the Engineering checklist."
    ) in storybook
    readme = flat(README.read_text())
    assert "A v1.0 story file (under a `<Level> v1.0/` root or tagged `deprecated`) is never edited beyond a compile-only repair" in readme
    assert "handoff blocks any other edit of a v1.0 story file except a compile-only repair" in readme
    assert "handoff blocks any other edit of a v1.0 file," not in readme


def test_the_writer_never_avoids_a_rename_and_logs_the_repair() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert (
        "Never avoid a rename to protect a v1.0 story file; when a rename breaks one, repair it with only prop "
        "renames, imports and types, no story added or removed and no title, story ID, tag or visual change, and "
        "log `Compile-only repair to v1.0: <file>` in the change log."
    ) in writer


def test_the_reviewer_confirms_each_repair_is_mechanical() -> None:
    check = paragraph(agent("vibe-guardrails-reviewer"), "10. Storybook taxonomy")
    assert (
        "Confirm each of the inventory's `compileOnlyV1Repairs` is purely mechanical (prop renames, imports, "
        "types) with no visual change; anything else in one is blocking."
    ) in check
    assert "any edit or move of a story file that is v1.0 on main (the inventory's `v1Stories`, reason `frozen`)" in check


def test_the_inventory_reports_repairs_without_blocking_on_them() -> None:
    inventory = INVENTORY.read_text()
    blocking = inventory[inventory.index("const blocking = {") : inventory.index("};", inventory.index("const blocking = {"))]
    assert "compileOnlyV1Repairs" not in blocking
    assert "storiesInV2Taxonomy: v1Stories.length === 0," in blocking
    result = inventory[inventory.index("const result = {") :]
    assert "  compileOnlyV1Repairs,\n" in result
    assert "function keepsStoryIdentity(base, source)" in inventory


def test_the_ticket_worker_places_each_repair_once_on_the_engineering_checklist() -> None:
    template = TICKET_TEMPLATE.read_text()
    rule = paragraph(template, "- Compile-only v1.0 repairs:")
    assert (
        "each file in the handoff inventory's `compileOnlyV1Repairs` goes once at the end of the Engineering "
        f"checklist as {CHECKLIST_SHAPE}."
    ) in rule
    assert (
        "| Engineering checklist | `vibe-ticket-worker` | session start; handoff appends engineering conflicts, "
        "forbidden-path needs, compile-only v1.0 repairs, engineering decisions and known main failures |"
    ) in template
    assert "compile-only" not in section(template, "## Handoff")
    handoff_mode = section(agent("vibe-ticket-worker"), "## Handoff mode")
    assert (
        "Place each file in the inventory's `compileOnlyV1Repairs` once, as an unchecked item at the end of the "
        "Engineering checklist in the template's shape (`../skills/vibe/references/ticket-template.md`, "
        "\"Compile-only v1.0 repairs\")."
    ) in handoff_mode
