"""Contract coverage for the review gates encoded from symphony-alpha #8947 to #8967.

Repeated lessons (activity capture, Desktop sync lanes, shared paths, dropped
why-comments, Storybook placement) are enforced by `diff-rules.mjs`; these
tests pin that the writer, handoff and every reviewer run it and act on its
result, and that each judgment rule is owned by the agent that applies it.
"""

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
HANDOFF = PLUGIN / "skills" / "handoff"
GATES = PLUGIN / "skills" / "vibe" / "references" / "review-gates.md"
SCRIPT = HANDOFF / "scripts" / "diff-rules.mjs"
SCRIPT_RULES = (
    "migration-order",
    "migration-precedent",
    "migration-backfill",
    "activity-capture",
    "tx-result-after-write",
    "desktop-sync-lane",
    "artifact-link-delete",
    "ticketed-comment",
    "shared-path",
    "story-outcome",
    "story-entry",
)


def test_every_documented_rule_is_implemented_by_the_script() -> None:
    gates = GATES.read_text()
    script = SCRIPT.read_text()
    for rule in SCRIPT_RULES:
        assert f"| `{rule}` |" in gates, rule
        assert f'"{rule}"' in script, rule


def test_the_writer_clears_blocking_findings_before_done() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert "`review-gates.md`" in section(agent("vibe-change-worker"), "## Read first")
    assert "diff-rules.mjs --worktree" in writer
    assert "clear every `blocking` finding" in writer
    assert "never a placeholder to get past the script" in writer
    assert "carry every why-comment of a moved symbol with it" in writer


def test_handoff_blocks_on_the_script_and_runs_its_required_tests() -> None:
    guardrail = section((HANDOFF / "SKILL.md").read_text(), "## 3. Guardrail check")
    checks = section((HANDOFF / "SKILL.md").read_text(), "## 5. Checks and the missing tests list")
    assert "node scripts/diff-rules.mjs --worktree" in guardrail
    assert "stop the checklist like `blocking.forbiddenPaths`" in guardrail
    assert "runs again until `blocking` is empty" in guardrail
    assert "`requiredTests` entry and `requiredChecks` command" in checks


def test_recorded_exceptions_are_verified_not_accepted_unread() -> None:
    reviewer = section(agent("vibe-guardrails-reviewer"), "## Check, for added or changed lines only")
    assert "17. Review gates" in reviewer
    for prefix in (
        "Migration precedent:",
        "Activity capture:",
        "Synchronizing-susan:",
        "Comment removed:",
        "Shared path:",
        "Story outcome unchanged:",
        "Story entry:",
    ):
        assert prefix in reviewer, prefix
        assert prefix in GATES.read_text(), prefix
    assert "A line whose citation does not hold is blocking" in reviewer
    assert "computed by calling production code is blocking as it is in a new test" in reviewer
    assert "never a waiver it accepts unread" in flat(GATES.read_text())


def test_required_tests_compose_with_targeted_validation() -> None:
    verify = flat(agent("vibe-verify-worker"))
    gates = flat(GATES.read_text())
    assert "whatever `code_tests_for` returns" in verify
    assert "one not run is a gap, never a pass" in verify
    assert "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts" in gates
    assert "*-host-capability-parity.test.ts" in gates
    assert "untagged spec does not run on the pull request" in gates
    assert "pnpm check:destructive-migrations" in gates


def test_each_judgment_rule_has_an_owner_that_applies_it() -> None:
    backend = flat(agent("vibe-backend-worker"))
    adversarial = section(agent("vibe-adversarial-reviewer"), "## Attack surface")
    decomposer = flat(agent("vibe-storybook-decomposer"))
    verify = flat(agent("vibe-verify-worker"))
    assert "judgment rules 1 to 15, which you own" in backend
    assert "last three migrations touching it" in backend
    assert "call the same canonical capture on the same transaction" in backend
    assert "12. Review gates" in adversarial
    assert "13. Shared paths" in adversarial
    assert "a five-level chain, a cycle, a foreign kind" in adversarial
    assert "rule 28" in decomposer and "rule 29" in decomposer and "rule 30" in decomposer
    assert "never synthetic `dispatchEvent` pointer events" in verify
    assert "through the real hook and `QueryClient` across two fetches" in verify


def test_story_rename_follows_the_taxonomy_release_rule_not_a_bump_per_edit() -> None:
    gates = flat(GATES.read_text())
    assert "A story whose asserted outcome flipped is renamed, and a rename is a release" in gates
    assert "a surface reachable only behind a default-off flag is not live" in gates
