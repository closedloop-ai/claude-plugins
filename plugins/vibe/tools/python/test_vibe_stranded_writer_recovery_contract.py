"""Contract checks for recovering a vibe writer turn stranded by a mid-turn plugin install.

A human can install a vibe release while the session's writer turn runs. That
removes the cache root the writer was registered with, so `release-record`
for the writer's own record continuation fails with ENOENT and the grant stays
retained. The session ROOT recovers it itself through `writer-state.mjs
migrate` with `retainedRecord`, internally, never sending the person to
engineering, and every later publication or ticket record takes fresh grants
and fresh validation.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"
GUARDRAILS = VIBE / "references" / "guardrails.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
CHANGE_WORKER = PLUGIN_ROOT / "agents" / "vibe-change-worker.md"
WRITER_STATE = VIBE / "scripts" / "dist" / "writer-state.mjs"
BLOCK_REASON = "recorded-definition-removed"


def migration() -> str:
    return section(QUALITY_LOOP.read_text(), "### Recorded definition migration")


def test_root_recovers_a_stranded_turn_internally_without_sending_the_person_to_engineering() -> None:
    text = migration()
    for required in (
        "**A turn stranded by a plugin upgrade.**",
        "`release-record` for the writer's own record continuation then fails with `ENOENT`",
        "same supported migration, not a tooling fix",
        "ROOT recovers it immediately, internally and without asking the person running the session",
        "never tells the person to message engineering about it",
    ):
        assert required in text, required


def test_only_a_machine_readable_removed_definition_block_migrates() -> None:
    text = migration()
    assert f'"blockReason": "{BLOCK_REASON}"' in text
    assert "the command refuses that reason while the recorded definition is present" in text
    assert "Every other `BLOCKED` is stored with reason `other` and stays unmigratable." in text
    assert "Migration rejects `BLOCKED` (except a removed definition, below)" in text
    assert "Never migrate around a refusal or to create parallel authors." in text


def test_the_retained_grant_is_released_atomically_under_strict_owner_equality() -> None:
    text = migration()
    for required in (
        '"retainedRecord": { "lease": "<record lease>", "stoppedTurn": {',
        '"state": "<completed|failed|canceled>"',
        "Never retry `release-record` under another root; owner equality stays exact.",
        "issued under the exact recorded `binding.agentRoot` whose definition is absent",
        "releases that grant and migrates in one atomic ledger update",
        "never the lease",
        "Another actor's grant, any other root, a present definition (use `release-record`), a running lease, "
        "missing or mismatched evidence and stale identity are refused with nothing changed.",
    ):
        assert required in text, required


def test_a_writer_blocked_before_block_reasons_existed_needs_the_retained_grant_as_proof() -> None:
    text = migration()
    assert "A writer blocked before block reasons existed has no `blockReason`." in text
    assert "accepts it only with that retained grant under an absent definition" in text


def test_recovered_writer_uses_fresh_grants_and_validation_never_old_witnesses() -> None:
    text = migration()
    assert "All authority is fresh" in text
    assert "source `progress`, publisher, ticket `handoff` and `assign`" in text
    assert "Never reuse an old grant, lease or validation witness." in text
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "uses the same command with `retainedRecord`" in handoff
    assert "publication, the ticket update and assignment take fresh grants and fresh validation" in handoff
    assert "never ask the person running the session about it or send them to engineering" in handoff


def test_the_guardrail_keeps_stranded_recovery_inside_allowed_migration() -> None:
    rule = section(GUARDRAILS.read_text(), "## Plugins and tooling")
    assert "including a turn stranded by a plugin upgrade" in rule
    assert "It is recovery, not a tooling fix: never stop or send the person to engineering for it." in rule


def test_codex_release_failure_and_the_writer_point_at_the_recovery() -> None:
    vibe = flat(VIBE_SKILL.read_text())
    assert "fails with `ENOENT` because a plugin install removed its recorded root" in vibe
    assert "`migrate` with `retainedRecord`, internally, never a question or a message to engineering" in vibe
    worker = flat(CHANGE_WORKER.read_text())
    assert "return `BLOCKED` saying the recorded definition was removed" in worker
    assert "never an engineering escalation or a question for the person" in worker
    assert "Never migrate yourself" in worker


def test_the_prose_names_the_shipped_command_contract() -> None:
    bundle = WRITER_STATE.read_text()
    assert f'"{BLOCK_REASON}"' in bundle
    assert "retainedRecord" in bundle
    assert "verifyStrandedRecordGrant" in bundle
