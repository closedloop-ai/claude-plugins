"""Contract checks for the 2026-10-19 operator ruling on vibe session plans and links.

The live ticket links back to the document the session started from (source
PRODUCES ticket), and the session's local plan is published as one
implementation plan document (PLN) that the ticket produces, kept current,
recorded on the session next to the live ticket, and moved from DRAFT to
APPROVED to EXECUTED as the work does. The old rule that a plan is never
uploaded is retired everywhere it appeared.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from vibe_contract_text import agent, flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
QUALITY = REFERENCES / "quality-loop.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
README = PLUGIN_ROOT / "README.md"
SESSIONS = VIBE / "scripts" / "vibe-sessions.mjs"
RULING = "operator ruling, 2026-10-19"

RETIRED_PHRASES = (
    "Never upload or insert a technical plan",
    "never upload private plans",
    "Never upload it, paste it into the ticket",
    "never upload them, paste their body",
    "upload it as an attachment/implementation-plan document",
    "never upload the local technical plan",
    "Never upload a technical plan",
    "Never upload a local technical",
    "never upload them or include their body",
    "outside commits, publications, and ticket uploads",
)


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def plan_rules() -> str:
    return section(agent("vibe-ticket-worker"), "## Source link and session plan")


def test_the_never_upload_the_plan_rule_is_gone_everywhere() -> None:
    files = [*PLUGIN_ROOT.joinpath("agents").glob("*.md"), *VIBE.rglob("*.md"),
             *PLUGIN_ROOT.joinpath("skills", "handoff").rglob("*.md"), README]
    for path in files:
        text = flat(path.read_text())
        for phrase in RETIRED_PHRASES:
            assert phrase not in text, f"{path.name}: {phrase}"


def test_the_source_document_produces_the_live_ticket_after_a_listing() -> None:
    rules = plan_rules()
    assert RULING in rules
    source = rules[rules.index("A. Source link."):rules.index("B. Render the plan")]
    assert_all(source, (
        "the record's `ticket`",
        "`list-artifact-links` with `artifactId: <live ticket>`, `direction: \"source\"`, `linkType: \"PRODUCES\"`",
        "`create-artifact-link` with `sourceId: <source>`, `targetId: <live ticket>`, `linkType: \"PRODUCES\"`",
    ))
    assert source.index("list-artifact-links") < source.index("create-artifact-link")
    create = section(agent("vibe-ticket-worker"), "## Create mode")
    assert "Link the source document to the ticket" in create and "step A" in create


def test_the_plan_is_one_pln_in_the_tickets_project_and_assignee_linked_and_versioned() -> None:
    rules = plan_rules()
    assert_all(rules, (
        "ONE implementation plan document (PLN)",
        "session-plan.mjs --worktree",
        "`type: IMPLEMENTATION_PLAN`",
        "the ticket's `projectId` and `assigneeId`",
        "an implementation plan among the targets is the session's PLN",
        "record it instead of creating another",
        "--live-plan <PLN slug>",
        "`current: false` is a material change",
        "`create-document-version`",
        "Never create a second PLN",
        "`create-artifact-link` with `sourceId: <live ticket>`, `targetId: <PLN slug>`, `linkType: \"PRODUCES\"`",
    ))
    assert rules.index("list-artifact-links` with `artifactId: <live ticket>`, `direction: \"target\"`") < rules.index(
        "`create-document` with `type: IMPLEMENTATION_PLAN`")


def test_the_plan_follows_the_ticket_safety_rules_and_a_refusal_goes_to_the_writer() -> None:
    rules = plan_rules()
    assert_all(rules, (
        "the live ticket's safety rules",
        "a local absolute path, the local username, a personal email, a secret or credential, or a private session input is refused",
        "publish nothing and return `NEEDS_CHANGE`",
        "for the SAME writer to fix its local plan",
    ))
    template = flat(TICKET_TEMPLATE.read_text())
    assert "This body and the PLN follow the same safety rules" in template
    planning = section(QUALITY.read_text(), "## Local plan")
    assert_all(planning, (RULING, "repo-relative paths only", "`scripts/session-plan.mjs`",
                          "a refusal comes back to this same writer"))
    writer = flat(agent("vibe-change-worker"))
    assert "the ticket worker publishes it as the session's PLN" in writer


def test_pln_status_follows_the_work_with_stale_write_guards() -> None:
    rules = plan_rules()
    status = rules[rules.index("F. Status."):]
    assert_all(status, (
        "`DRAFT` while its latest plan is not built yet",
        "`APPROVED` once the session has written and checked the code for it",
        "at the latest when handoff opens the pull request",
        "`EXECUTED` once the session's pull request merged",
        "`expectedStatus: <the status get-document just returned>`",
        "Never move an `EXECUTED` PLN back",
    ))
    plan = section(agent("vibe-ticket-worker"), "## Plan mode")
    assert_all(plan, ("`APPROVED` with `built: true`", "`DRAFT` with `built: false`", "`mergeCheck: true`",
                      "--state merged", "set `EXECUTED`"))
    worker = agent("vibe-ticket-worker")
    for line in worker.splitlines():
        if "`update-document`" in line and "never" not in line.lower():
            block = flat(worker[worker.index(line):worker.index(line) + 400])
            assert "expectedStatus" in block, line


def test_handoff_verifies_and_repairs_both_links_and_leaves_the_pln_approved() -> None:
    handoff = section(agent("vibe-ticket-worker"), "## Handoff mode")
    assert_all(handoff, (
        "Run \"Source link and session plan\" A to F",
        "step F leaves the PLN `APPROVED`",
        "The ticket is not complete until the source link",
        "repair whatever is missing or stale here",
    ))
    assert handoff.index("Source link and session plan\" A to F") < handoff.index("live-ticket-check.mjs")
    skill = section(HANDOFF_SKILL.read_text(), "## 8. Choose who picks it up, then check the ticket")
    assert_all(skill, ("verifies the source link (source PRODUCES ticket)", "its link (ticket PRODUCES PLN)",
                       "leaves the PLN `APPROVED` before a pull request opens",
                       "refuses a session with local plans and no `APPROVED` PLN recorded"))


def test_assign_mode_hands_over_the_pln_with_the_ticket() -> None:
    assign = section(agent("vibe-ticket-worker"), "## Assign mode")
    assert "The PLN follows its ticket" in assign
    assert "same `assigneeId` and `expectedStatus: <the PLN status you read>`" in assign


def test_the_vibe_skill_publishes_the_plan_after_each_request_and_links_the_source_at_start() -> None:
    skill = flat(VIBE_SKILL.read_text())
    assert "links the originating document (a PRD, an ISS or another document) to the ticket" in skill
    assert "dispatch `vibe-ticket-worker` in plan mode in its own record turn, with `built: true`" in skill
    assert "with `mergeCheck: true`" in skill
    assert "Keep technical plans private." not in skill


def test_the_session_record_has_the_pln_next_to_the_live_ticket(tmp_path: Path) -> None:
    worktree = tmp_path / "session"
    worktree.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "vibe/plan-field", str(worktree)], check=True)
    record = {"slug": "plan-field", "branch": "vibe/plan-field", "status": "active", "liveTicket": "ISS-1"}
    (worktree / ".git" / "vibe-session.json").write_text(json.dumps(record))
    result = subprocess.run(
        ["node", str(SESSIONS), "touch", "--worktree", str(worktree), "--live-plan", "PLN-2", "--live-plan-status", "DRAFT"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    session = json.loads(result.stdout)["session"]
    assert (session["liveTicket"], session["livePlan"], session["livePlanStatus"]) == ("ISS-1", "PLN-2", "DRAFT")
