"""Contract coverage for the pull request facts gate.

Vibe pull request bodies listed overlaps from memory, left flipped and deleted
assertions unnamed, attributed changes to files whose diff did not make them,
and opened while device runs were still pending. `pr-facts.mjs` computes those
facts from the diff, and every path that creates or refreshes a body runs its
check first.
"""

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
HANDOFF = PLUGIN / "skills" / "handoff"
SCRIPT = HANDOFF / "scripts" / "pr-facts.mjs"


def test_script_has_every_subcommand_and_the_stacked_statement() -> None:
    text = SCRIPT.read_text()
    for subcommand in ("overlap", "assertions", "contracts", "asks", "lanes", "evidence", "cite-check", "facts", "check"):
        assert f'"{subcommand}"' in text, subcommand
    assert "export const STACKED_BASE_STATEMENT" in text
    assert "export const SERVER_ONLY_LINE" in text


def test_handoff_classifies_server_only_and_gates_creation_on_evidence_and_facts() -> None:
    checklist = section((HANDOFF / "SKILL.md").read_text(), "## 1. Internal checklist")
    assert "scripts/pr-facts.mjs lanes" in checklist
    assert "`serverOnly: true`" in checklist
    assert "skip step 4, the Desktop build and Desktop control runs, visual QA" in checklist
    hand_over = section((HANDOFF / "SKILL.md").read_text(), "## 9. Hand it over")
    assert "vibe-pr-evidence.json" in hand_over
    assert "scripts/pr-facts.mjs evidence" in hand_over
    assert "A pending, running or missing lane, or one run on another commit, blocks creation" in hand_over
    assert "it is never deferred as a test gap" in hand_over
    assert "`scripts/pr-facts.mjs check` passes on that body" in hand_over
    changes = section((HANDOFF / "SKILL.md").read_text(), "## 10. Changes on the open pull request")
    assert "`scripts/pr-facts.mjs check` on the refreshed body" in changes


def test_environment_worker_builds_from_facts_and_refuses_a_failing_check() -> None:
    mode = section(agent("vibe-environment-worker"), "## Pull-request mode")
    assert "pr-facts.mjs facts" in mode
    for fact in ("`overlap`", "`assertions`", "`contracts`", "`asks`", "`refusals`", "`requiredStatements`"):
        assert fact in mode, fact
    assert "`refusals` and `contracts` are empty" in mode
    assert "Right before `gh pr create`, run `node ../skills/handoff/scripts/pr-facts.mjs check" in mode
    assert "Exit 1 creates nothing: return `NEEDS_CHANGE`" in mode
    assert "Never drop a cited fact" in mode
    assert "with the `pr-facts.mjs check` passing on the refreshed body" in mode


def test_summarizer_lists_every_fact_and_resolves_every_ruling() -> None:
    text = flat(agent("vibe-handoff-summarizer"))
    assert "pr-facts.mjs facts --worktree <wt>" in text
    assert "every flipped or removed assertion, added skip and deleted test file" in text
    assert "every removed or changed guard, short-circuit, gesture, selection or gate predicate" in text
    assert "`pr-facts.mjs cite-check` accepts" in text
    assert "a `TRIAGE` or draft ticket is not a ruling" in text
    assert "Never call the change additive, presentation-only or non-breaking" in text


def test_requirements_overlap_covers_imports_dependencies_and_write_paths() -> None:
    text = flat(agent("vibe-requirements-worker"))
    assert "pr-facts.mjs overlap --worktree <repo path> --files" in text
    assert "change a module those files import" in text
    assert '"Roadmap N"' in text
    assert "before any plan designs it" in text


def test_verify_worker_records_lane_evidence_for_the_gate() -> None:
    text = flat(agent("vibe-verify-worker"))
    assert "vibe-pr-evidence.json" in text
    for lane in ("web-host", "desktop-host", "webkit-iphone", "chromium-pixel", "storybook-plays", "e2e"):
        assert f"`{lane}`" in text, lane
    assert "A run is `passed` only when it finished and passed on that commit" in text
