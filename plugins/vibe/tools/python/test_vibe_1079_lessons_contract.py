"""Contract coverage for the vibe 1.0.79 prevention lessons."""

from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"


def test_shared_scope_plans_name_one_owner_and_every_inheriting_consumer() -> None:
    worker = flat((PLUGIN / "agents" / "vibe-change-worker.md").read_text())
    design = flat((VIBE / "references" / "design-pass.md").read_text())
    assert '"across all"' in worker and 'the person says "shared"' in worker
    assert "one owning parent component" in worker
    assert "every consumer that inherits it" in worker
    for field in ("Shared capability:", "Owner:", "Consumers:", "Prototype routes:"):
        assert field in design, field


def test_guardrails_reject_parallel_page_composition_of_one_capability() -> None:
    reviewer = flat((PLUGIN / "agents" / "vibe-guardrails-reviewer.md").read_text()).lower()
    rules = (PLUGIN / "skills" / "handoff" / "scripts" / "diff-rules.mjs").read_text()
    assert "shared-capability-owner" in rules
    assert "same capability component" in reviewer
    assert "two or more page-level adapters" in reviewer
    assert "one shared parent" in reviewer


def test_handoff_compares_each_consumer_with_its_prototype_route() -> None:
    verifier = flat((PLUGIN / "agents" / "vibe-verify-worker.md").read_text())
    handoff = flat((PLUGIN / "skills" / "handoff" / "SKILL.md").read_text())
    quality = flat((VIBE / "references" / "quality-loop.md").read_text())
    required = "each consumer page against that page's approved prototype route"
    for text in (verifier, handoff, quality):
        assert required in text
        assert "present in the prototype but missing in production" in text


def test_worker_rules_forbid_credential_workarounds_and_force_push_everywhere() -> None:
    hook_manifest = (PLUGIN / "hooks" / "hooks.json").read_text()
    worker_preamble = flat(
        (PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md").read_text()
    )
    vibe = flat((VIBE / "SKILL.md").read_text())
    assert "shell-safety-guard.mjs" in hook_manifest
    for text in (worker_preamble, vibe):
        assert "first authentication failure" in text
        assert "CI logs or the API" in text
        assert "every remote" in text
        assert "proof/<sha>-<n>" in text


def test_message_less_watchers_use_the_watched_event_mailbox() -> None:
    fleet = flat((PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md").read_text())
    watch = (PLUGIN / "skills" / "codex-fleet-monitor" / "scripts" / "watch.sh").read_text()
    assert "cannot SendMessage" in fleet
    assert "<orchDir>/events/" in fleet
    assert "events" in watch and "event" in watch


def test_main_sync_has_a_bounded_no_grant_fallback() -> None:
    environment = flat((VIBE / "references" / "environment.md").read_text())
    assert "cannot mint a supported publisher grant" in environment
    assert "git merge --no-commit --no-ff origin/main" in environment
    assert "commit-worktree.mjs" in environment
