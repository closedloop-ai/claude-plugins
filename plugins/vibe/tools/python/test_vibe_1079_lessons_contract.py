"""Contract coverage for the vibe 1.0.79 prevention lessons."""

from pathlib import Path

from vibe_contract_text import flat, hook_guard_routed
import skill_split


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"


def test_shared_scope_plans_name_one_owner_and_every_inheriting_consumer() -> None:
    worker = flat(skill_split.read(PLUGIN / "agents" / "vibe-change-worker.md"))
    design = flat(skill_split.read(VIBE / "references" / "design-pass.md"))
    assert '"across all"' in worker and 'the person says "shared"' in worker
    assert "one owning parent component" in worker
    assert "every consumer that inherits it" in worker
    for field in ("Shared capability:", "Owner:", "Consumers:", "Prototype routes:"):
        assert field in design, field


def test_guardrails_reject_parallel_page_composition_of_one_capability() -> None:
    reviewer = flat(skill_split.read(PLUGIN / "agents" / "vibe-guardrails-reviewer.md")).lower()
    rules = skill_split.read(PLUGIN / "skills" / "handoff" / "scripts" / "diff-rules.mjs")
    assert "shared-capability-owner" in rules
    assert "same capability component" in reviewer
    assert "two or more page-level adapters" in reviewer
    assert "one shared parent" in reviewer


def test_handoff_compares_each_consumer_with_its_prototype_route() -> None:
    verifier = flat(skill_split.read(PLUGIN / "agents" / "vibe-verify-worker.md"))
    handoff = flat(skill_split.read(PLUGIN / "skills" / "handoff" / "SKILL.md"))
    quality = flat(skill_split.read(VIBE / "references" / "quality-loop.md"))
    required = "each consumer page against that page's approved prototype route"
    for text in (verifier, handoff, quality):
        assert required in text
        assert "present in the prototype but missing in production" in text


def test_worker_rules_forbid_credential_workarounds_and_force_push_everywhere() -> None:
    worker_preamble = flat(
        skill_split.read(PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md")
    )
    vibe = flat(skill_split.read(VIBE / "SKILL.md"))
    assert hook_guard_routed(PLUGIN, "PreToolUse", "shell-safety-guard", tool="Bash")
    for text in (worker_preamble, vibe):
        assert "first authentication failure" in text
        assert "CI logs or the API" in text
        assert "every remote" in text
        assert "proof/<sha>-<n>" in text


def test_message_less_watchers_use_the_watched_event_mailbox() -> None:
    fleet = flat(skill_split.read(PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"))
    watch = skill_split.read(PLUGIN / "skills" / "codex-fleet-monitor" / "scripts" / "watch.sh")
    assert "cannot SendMessage" in fleet
    assert "<orchDir>/events/" in fleet
    assert "events" in watch and "event" in watch


def test_main_sync_has_a_bounded_no_grant_fallback() -> None:
    environment = flat(skill_split.read(VIBE / "references" / "environment.md"))
    assert "cannot mint a supported publisher grant" in environment
    assert "git merge --no-commit --no-ff origin/main" in environment
    assert "commit-worktree.mjs" in environment
