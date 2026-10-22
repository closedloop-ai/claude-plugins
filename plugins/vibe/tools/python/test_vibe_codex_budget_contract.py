"""Contract checks for the 2026-10-19 operator ruling on Codex budget, after vibe sessions exhausted two
accounts' weekly Codex limits.

1. Codex workers default to reasoning effort `high`; `xhigh` only when raised explicitly.
2. Model by role from one policy per harness: Codex explorers on `gpt-5.6-terra`, writers, reviewers and
   verifiers on the existing `gpt-6-sol` (`skills/cl-sweep/scripts/model-policy.mjs`, read through
   `skills/vibe/scripts/worker-model.mjs`); Claude Code explorers on sonnet in agent frontmatter.
3. Targeted validation: the tests `code_tests_for` returns per changed file plus typecheck and lint, never a
   broad or full local suite.
4. One containerized e2e stack per machine, through `skills/vibe/scripts/e2e-lock.mjs`, running only the
   specs the change needs.
5. Usage awareness: stop and tell the person when a usage limit is reached, unless they allowed credits.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILLS = PLUGIN_ROOT / "skills"
VIBE_SKILL = SKILLS / "vibe" / "SKILL.md"
REFERENCES = SKILLS / "vibe" / "references"
HANDOFF_SKILL = SKILLS / "handoff" / "SKILL.md"
SEED_SKILL = SKILLS / "vibe-seed-refresh" / "SKILL.md"
CHECKS_SOURCE = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src" / "main-sync-checks.ts"
WHOLE_STORYBOOK_SUITE = re.compile(r"`pnpm --filter storybook test`(?! suite)")


def harness_notes() -> str:
    return section(VIBE_SKILL.read_text(), "## Harness notes")


def test_codex_spawns_take_model_and_effort_from_the_policy() -> None:
    notes = harness_notes()
    assert "node scripts/worker-model.mjs codex <name>" in notes
    assert "`gpt-5.6-terra`" in notes and "`gpt-6-sol`" in notes
    assert "Never pass `xhigh` unless the person asked for it" in notes
    for skill in (HANDOFF_SKILL, SEED_SKILL):
        assert "worker-model.mjs codex <name>" in flat(skill.read_text()), skill.name


def test_usage_limits_stop_both_harnesses_unless_credits_were_allowed() -> None:
    notes = harness_notes()
    assert "node scripts/codex-usage.mjs check" in notes
    assert "when a worker turn stalls" in notes
    assert "Pass `--allow-credits` only after the person explicitly said to use credits" in notes
    assert "`unknown` is not a stop" in notes
    assert "`USAGE_LIMIT_REACHED`" in notes
    assert '`"allowCredits": true`' in notes


def test_verify_worker_runs_only_targeted_tests() -> None:
    text = agent("vibe-verify-worker")
    checks = section(text, "## Existing checks")
    assert "Only the tests closedloop-graph's `code_tests_for` returns for each changed file" in checks
    assert "Never run `pnpm test`, `pnpm verify`, `pnpm test:affected`" in checks
    assert "## Full-suite mode" not in text
    assert "`full-suite`" not in text


def test_no_vibe_text_asks_for_a_whole_suite() -> None:
    sources = {
        "guardrails": (REFERENCES / "guardrails.md").read_text(),
        "quality-loop": (REFERENCES / "quality-loop.md").read_text(),
        "closedloop-graph": (REFERENCES / "closedloop-graph.md").read_text(),
        "handoff": HANDOFF_SKILL.read_text(),
        "primitive": agent("vibe-primitive-worker"),
        "decomposer": agent("vibe-storybook-decomposer"),
        "environment": agent("vibe-environment-worker"),
    }
    for name, text in sources.items():
        flattened = flat(text)
        assert "full-suite" not in flattened, name
        assert "the whole suite and" not in flattened, name
        assert "existing test suite" not in flattened, name
        assert not WHOLE_STORYBOOK_SUITE.search(flattened), name
        assert 'pnpm turbo test --filter="...[<since>]"' not in flattened, name


def test_handoff_recipe_runs_no_test_suite() -> None:
    source = CHECKS_SOURCE.read_text()
    recipe = source[source.index("export function checkRecipe") : source.index("/** Runs the fixed matrix")]
    for command in ('"test:affected"', '"turbo", "test"', '["pnpm", "verify"]', '["pnpm", "test"]', '"test:lint"',
                    '"test:skills"', '"test:renderer"', '"storybook", "test"', "lanes.commands"):
        assert command not in recipe, command
    assert '"typecheck:affected"' in recipe


def test_e2e_runs_one_stack_per_machine_and_only_needed_specs() -> None:
    checks = section(agent("vibe-verify-worker"), "## Existing checks")
    assert "node ../skills/vibe/scripts/e2e-lock.mjs run --head <sha> <the e2e command>" in checks
    assert "only those specs, never the whole e2e suite" in checks
    assert "never start the stack around the lock" in checks
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "and no other spec" in handoff
    assert "one stack per machine through `../vibe/scripts/e2e-lock.mjs`" in handoff
