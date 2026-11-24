"""Writer self-review, parser matrices, browser-claim evidence, docs contracts and the live-ticket read (ISS-14374, ISS-14394)."""

from pathlib import Path

from skill_split import read
from vibe_contract_text import PROVIDER_REFERENCES, agent, flat, section

ROOT = Path(__file__).resolve().parents[2]
REFERENCES = ROOT / "skills" / "vibe" / "references"
CHANGE = agent("vibe-change-worker")
SELF_REVIEW = section(CHANGE, "### Self-review before `DONE`")


def test_writer_runs_the_reviewers_duplicate_and_contradiction_checks_before_review() -> None:
    assert "skills/handoff/scripts/guardrails-gate.mjs --worktree" in SELF_REVIEW
    assert "`duplicate-helper` and `owner-duplicates`" in SELF_REVIEW
    assert "includes untracked files" in SELF_REVIEW
    assert "repeats at more than one site, even under different names, also moves to one owner" in SELF_REVIEW
    assert "Fix a line your change contradicts" in SELF_REVIEW
    gate = (ROOT / "skills" / "handoff" / "scripts" / "guardrails-gate.mjs").read_text()
    assert "owner-duplicates" in gate and "--out" in gate
    loop = flat(read(REFERENCES / "quality-loop.md"))
    assert "Self-review: before `DONE`, the writer runs the reviewers' duplicate-helper and contradicting-text checks" in loop
    guardrails = flat(read(REFERENCES / "guardrails.md"))
    assert "the loop's only other checks are the writer's self-review of its own diff" in guardrails
    assert "the loop's only other check is the writer's" not in guardrails


def test_writer_sweeps_renames_sibling_commands_debt_lines_and_criterion_ids() -> None:
    assert "`rg` the old name across the repository, generated files and changelogs included" in SELF_REVIEW
    assert "names every sibling that reaches the same code path" in SELF_REVIEW
    assert "only as the exact `Debt:` line" in SELF_REVIEW
    assert "cites a criterion ID only once the ticket lists it" in SELF_REVIEW


def test_parser_changes_start_with_a_layout_matrix_and_a_base_reference_fuzz() -> None:
    assert "every input layout it can meet" in SELF_REVIEW
    assert "`git show <base>:<file>`" in SELF_REVIEW
    assert "re-derive the layouts, not only that case" in SELF_REVIEW
    assert "the table is incomplete" in flat(agent("vibe-adversarial-reviewer"))


def test_browser_observable_claims_wait_for_their_e2e_run() -> None:
    premises = flat(read(REFERENCES / "review-premises.md"))
    assert "not blocking on a code trace alone when an end-to-end run covering that exact line is queued or available" in premises
    assert "`blocking: false` until that run" in premises
    assert "browser-observable claim resting on a code trace alone" in flat(agent("vibe-adversarial-reviewer"))
    assert "review-premises.md" in agent("vibe-consolidated-reviewer")


def test_a_required_api_contract_update_is_routed_not_blocked() -> None:
    guardrails = flat(read(REFERENCES / "guardrails.md"))
    assert "is never blocked or dropped" in guardrails
    template = flat((PROVIDER_REFERENCES / "ticket-template.md").read_text())
    assert "`apps/web/content/docs/api-reference/openapi.json` as a `required contract update`" in template


def test_the_environment_worker_reads_the_live_ticket_through_the_inventory() -> None:
    env = flat((PROVIDER_REFERENCES / "agents" / "vibe-environment-worker.md").read_text())
    assert "--overlap --live-ticket`" in env
    assert "rerun it with `--body-only`" in env
