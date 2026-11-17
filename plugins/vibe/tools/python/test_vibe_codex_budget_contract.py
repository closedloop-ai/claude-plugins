"""Contract checks for the 2026-10-19 operator ruling on Codex budget, after vibe sessions exhausted two
accounts' weekly Codex limits.

1. Codex workers default to reasoning effort `high`; `xhigh` only when raised explicitly.
2. Model by role from one policy per harness: Codex explorers on `gpt-5.6-terra`, writers, reviewers and
   verifiers on the existing `gpt-6-sol` (`skills/cl-sweep/scripts/model-policy.mjs`, read through
   `skills/vibe/scripts/worker-model.mjs`); Claude Code explorers on sonnet in agent frontmatter. Since
   ISS-14109 these are defaults a person can override (`skills/vibe/scripts/agent-models.mjs`).
3. Targeted validation: the tests `code_tests_for_changes` returns for the diff plus typecheck and lint, never a
   broad or full local suite.
4. Targeted E2E uses the strongest capable container, native or remote tier and the repository's lock.
5. Usage awareness: stop and tell the person when a usage limit is reached, unless they allowed credits.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from vibe_contract_text import PROVIDER_REFERENCES, agent, flat, section
import skill_split


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parents[1]
SKILLS = PLUGIN_ROOT / "skills"
VIBE_SKILL = SKILLS / "vibe" / "SKILL.md"
REFERENCES = SKILLS / "vibe" / "references"
HANDOFF_SKILL = SKILLS / "handoff" / "SKILL.md"
SEED_SKILL = SKILLS / "vibe-seed-refresh" / "SKILL.md"
CHECKS_SOURCE = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src" / "main-sync-checks.ts"
WHOLE_STORYBOOK_SUITE = re.compile(r"`pnpm --filter storybook test`(?! suite)")


def test_cloud_eval_rule_is_mirrored_with_runtime_and_evidence_boundaries() -> None:
    required = (
        "codex cloud exec --env claude-plugins --branch <branch>",
        "plugins/vibe/evals/codex/run.py",
        "results.json",
        "failed-run rollouts",
        "never `auth.json`",
        "codex cloud diff",
        "Everything inside that task is Codex",
        "Claude evals run in a Claude cloud session",
        "Never mix runtimes",
        "chatgpt.com",
        "api.openai.com",
        "Run Codex vibe evals as a Codex cloud task",
    )
    for instructions in (REPO_ROOT / "AGENTS.md", REPO_ROOT / "CLAUDE.md"):
        text = instructions.read_text()
        for phrase in required:
            assert phrase in text, f"{instructions.name}: {phrase}"


def harness_notes() -> str:
    return section(skill_split.read(VIBE_SKILL), "## Harness notes")


def test_codex_spawns_take_model_and_effort_from_the_policy() -> None:
    notes = harness_notes()
    assert "node scripts/worker-model.mjs codex <name>" in notes
    assert "`gpt-5.6-terra`" in notes and "`gpt-6-sol`" in notes
    assert "Never pass `xhigh` unless the person asked for it" in notes
    for skill in (HANDOFF_SKILL, SEED_SKILL):
        assert "worker-model.mjs codex <name>" in flat(skill_split.read(skill)), skill.name


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
    assert "Only the tests closedloop-graph's `code_tests_for_changes` returns for the whole diff" in checks
    assert "Never run `pnpm test`, `pnpm verify`, `pnpm test:affected`" in checks
    assert "## Full-suite mode" not in text
    assert "`full-suite`" not in text


def test_provider_wires_whole_diff_graph_selection_to_writer_and_gate() -> None:
    contract = json.loads(skill_split.read(PROVIDER_REFERENCES.parents[2] / "provider.json"))
    assert "code_tests_for_changes" in contract["data"]["graph"]["operations"]
    assert contract["data"]["recipes"]["prEvidence"]["graphSelector"] == "code_tests_for_changes"
    writer = flat(agent("vibe-change-worker"))
    assert "`code_tests_for_changes` on the whole diff" in writer
    assert "including unedited importers" in writer
    assert "E2E uses lanes/behavior refs" in writer


def test_no_vibe_text_asks_for_a_whole_suite() -> None:
    sources = {
        "guardrails": skill_split.read(REFERENCES / "guardrails.md"),
        "quality-loop": skill_split.read(REFERENCES / "quality-loop.md"),
        "closedloop-graph": skill_split.read(PROVIDER_REFERENCES / "closedloop-graph.md"),
        "handoff": skill_split.read(HANDOFF_SKILL),
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
    source = skill_split.read(CHECKS_SOURCE)
    recipe = source[source.index("export function checkRecipe") : source.index("/** Runs the fixed matrix")]
    for command in ('"test:affected"', '"turbo", "test"', '["pnpm", "verify"]', '["pnpm", "test"]', '"test:lint"',
                    '"test:skills"', '"test:renderer"', '"storybook", "test"', "lanes.commands"):
        assert command not in recipe, command
    # The matrix itself is the provider repository's recipe; its handoff steps run no suite either.
    contract = json.loads(skill_split.read(PROVIDER_REFERENCES.parents[2] / "provider.json"))
    checks = contract["data"]["recipes"]["mainSync"]["checks"]
    handoff = [" ".join(step["argv"]) for purpose in ("handoff", "final") for step in checks[purpose] if "argv" in step]
    for command in ("test:affected", "turbo test", "pnpm verify", "pnpm test", "test:lint", "test:skills", "test:renderer", "storybook test"):
        assert not any(command in line.split("--")[0] for line in handoff if line != "pnpm typecheck:affected"), command
    assert "pnpm typecheck:affected" in handoff


def test_e2e_uses_a_capability_tier_and_only_needed_specs() -> None:
    checks = section(agent("vibe-verify-worker"), "## Existing checks")
    assert "Tier A:" in checks
    assert "Tier B:" in checks
    assert "Tier C:" in checks
    assert "Run only those specs through the chosen tier" in checks
    assert "git config --bool vibe.noNativeE2e" in checks
    handoff = flat(skill_split.read(HANDOFF_SKILL))
    assert "and no other spec" in handoff
    assert "one stack per machine through `../vibe/scripts/e2e-lock.mjs`" in handoff


def test_fleet_reads_failed_evidence_before_reruns_and_suppresses_duplicate_relays() -> None:
    fleet = flat(skill_split.read(SKILLS / "fleet-orchestrator" / "SKILL.md"))
    assert "Before approving a rerun, read the failed run's kept session or trace and current code" in fleet
    assert "Do not relay an idle or turn-end notification that adds no fact" in fleet


def test_remote_e2e_and_heavy_work_share_the_fleet_slot_owner() -> None:
    verifier = flat(agent("vibe-verify-worker"))
    assert "fleet.sh <orchDir> remote slot heavy <owner> <runnerWorktree> <command...>" in verifier
    assert "machine-local legacy slot scripts are not a Vibe execution path" in verifier
    assert "vibe-remote/e2e-slot.sh" not in verifier
