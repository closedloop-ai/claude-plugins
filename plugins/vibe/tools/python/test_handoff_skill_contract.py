"""Contract checks for how the handoff skill routes the person's answers (ISS-12135).

A handoff answer that decides what the product does must reach the change worker,
and the checks, reviews, and redeploy must follow, before the ticket is finished.
The ticket goes to the user the person names as the next owner, never to a
built-in default.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import PROVIDER_REFERENCES, flat, section
import skill_split


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
TICKET_TEMPLATE = PROVIDER_REFERENCES / "ticket-template.md"
TICKET_WORKER = PLUGIN_ROOT / "agents" / "vibe-ticket-worker.md"
CHANGE_WORKER = PLUGIN_ROOT / "agents" / "vibe-change-worker.md"
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"
# A built-in default owner reads as an assignment to a capitalized full name.
FIXED_ASSIGNEE = re.compile(r"\bassign(?:s|ed)?\b[^.\n]{0,40}?\bto [A-Z][a-z]+ [A-Z][a-z]+\b")


def test_final_publication_keeps_input_readiness_distinct_from_coverage() -> None:
    upload = section(skill_split.read(HANDOFF_SKILL), "## 7. Upload the last changes")
    for required in ("main-sync-inputs", "mainSyncValidation", "same actor", "retained reports",
                     "requiredE2eComplete", "not test authority"):
        assert required in upload, required


def test_behavior_answers_go_to_the_change_worker_before_the_ticket() -> None:
    answers = section(skill_split.read(HANDOFF_SKILL), "## Answers from the person")

    assert "**Behavior**" in answers
    assert "**Wording**" in answers
    assert "when you are unsure" in answers
    assert "A behavior answer resumes the SAME `vibe-change-worker`" in answers
    for rerun in ("step 3", "step 4", "step 5", "step 6", "step 7"):
        assert rerun in answers, rerun
    assert "Only then does the answer go to `vibe-ticket-worker`." in answers
    assert "A wording answer goes straight to `vibe-ticket-worker`." in answers
    assert "`built`" in answers
    assert "`already met`" in answers


def test_step_eight_routes_answers_and_blocks_finalizing_until_reruns_finish() -> None:
    step_eight = section(skill_split.read(HANDOFF_SKILL), "## 8. Choose who picks it up, then check the ticket")

    assert "`NEEDS_PERSON`" in step_eight
    assert "`NEEDS_CHANGE`" in step_eight
    assert "Missing behavior criteria should have failed candidate preflight" in step_eight
    assert "Environment base commit from the current inventory" in step_eight
    assert "Never go on to step 9 while a behavior answer" in step_eight


def test_summary_corrections_that_change_behavior_are_routed_too() -> None:
    step_two = section(skill_split.read(HANDOFF_SKILL), "## 2. Summarize internally")

    assert "Answers from the person" in step_two
    assert "goes to the change worker now" in step_two


def test_ticket_worker_refuses_unbuilt_behavior_and_rederives_dependent_sections() -> None:
    handoff = section(skill_split.read(TICKET_WORKER), "## Handoff mode")

    assert "handoff-inventory.mjs --worktree" in handoff
    assert "it must be the inventory's `baseCommit`" in handoff
    assert "return `NEEDS_CHANGE`" in handoff
    assert "re-derive every section that depends on" in handoff
    for dependent in ("What this is", "Scope and acceptance criteria", "Handoff"):
        assert dependent in handoff, dependent
    assert "--base-commit <inventory baseCommit>" in handoff
    assert "marked `behavior`" in handoff


def test_change_worker_checks_a_handoff_answer_against_the_code() -> None:
    worker = skill_split.read(CHANGE_WORKER)
    answers = section(skill_split.read(HANDOFF_SKILL), "## Answers from the person")
    assert "findings or product answer" in worker
    assert "same active request and writer ID" in worker
    assert "`already met`" in answers
    assert "`built`" in answers
    assert "It checks the code against the answer on every screen" in answers


def test_step_eight_reuses_a_named_owner_or_asks_without_defaulting() -> None:
    step_eight = section(skill_split.read(HANDOFF_SKILL), "## 8. Choose who picks it up, then check the ticket")

    assert "Who should I pass it to? A name or email is fine." in step_eight
    assert "`vibe-ticket-worker` in lookup mode" in step_eight
    assert "use a next owner the person already named" in step_eight
    assert "never re-ask that settled choice" in step_eight
    assert "Keep the assignment progress internal" in step_eight
    assert "report the next owner at completion" in step_eight
    assert "`<full name> (<email>)`" in step_eight
    assert "ask the question again" in step_eight
    assert "never fall back to anyone by default" in step_eight
    assert "the next owner (full name and email)" in step_eight


def test_lookup_matches_through_the_script_and_assign_uses_its_user() -> None:
    worker = skill_split.read(TICKET_WORKER)
    lookup = section(worker, "## Lookup mode")
    assign = section(worker, "## Assign mode")

    assert "until `hasMore` is false" in lookup
    assert "match-assignee.mjs" in lookup
    assert "Never match by eye" in lookup
    assert "choose none" in lookup
    assert "the next owner's id as `assigneeId`" in assign
    assert "`expectedStatus: IN_PROGRESS`; never change the status" in assign
    assert "never assign anyone by default" in assign


def test_no_next_owner_is_hardcoded() -> None:
    next_line = section(skill_split.read(TICKET_TEMPLATE), "## Handoff")
    for text in (skill_split.read(HANDOFF_SKILL), skill_split.read(TICKET_WORKER), next_line):
        assert not FIXED_ASSIGNEE.search(text), FIXED_ASSIGNEE.search(text)
    assert "- Next: <the next owner the person chose at handoff, by full name>" in next_line


def test_template_grading_block_follows_handoff_with_the_seven_item_checklist() -> None:
    template = skill_split.read(TICKET_TEMPLATE)
    grading = section(template, "## Grading")

    assert template.index("## Handoff") < template.index("## Grading") < template.index("## Engineering checklist")
    for text in ("`Design grade`", "`Eng grade`", "Custom Fields", "it starts collapsed", "before changing anything"):
        assert text in grading, text
    for item in (
        "1. Followed our codebase rules.",
        "2. Reused existing components.",
        "3. Storybook is right.",
        "4. Extended the existing pattern.",
        "5. Backend is wired correctly.",
        "6. No invented copy.",
        "7. What we had to fix before merge.",
    ):
        assert item in grading, item
    assert not FIXED_ASSIGNEE.search(grading), FIXED_ASSIGNEE.search(grading)


def test_ticket_worker_fills_grading_at_handoff_and_never_rederives_it() -> None:
    worker = skill_split.read(TICKET_WORKER)
    create = section(worker, "## Create mode")
    handoff = section(worker, "## Handoff mode")

    assert "Handoff, Design Review, and Grading" in create
    assert "Grading is never re-derived: it stays the template's text." in handoff
    assert "template's Grading section copied unchanged" in handoff
    assert "adding the section after Handoff when the ticket has none" in handoff


def test_check_weight_follows_whether_the_session_changed_backend_code() -> None:
    skill = skill_split.read(HANDOFF_SKILL)
    task_list = section(skill, "## 1. Internal checklist")
    checks = section(skill, "## 5. Checks and the missing tests list")
    reviews = section(skill, "## 6. Independent integrated review")

    assert "handoff-inventory.mjs --worktree" in task_list
    assert "`backendChanged`" in task_list
    assert "use the backend checks from then on" in task_list
    assert "Read-only verify checks mode runs the same targeted checks whether or not backend changed" in checks
    assert "Backend changes add the two review passes, not a wider test run" in checks
    assert "Lighter: repo `review-soul`" in reviews
    assert "`vibe-adversarial-reviewer`" in reviews
    assert "parallel, read-only" in reviews
    assert "Backend: named core `workflow-code-review`" in reviews
    assert "two existing review passes" in reviews


def test_draft_scope_is_retired() -> None:
    for path in (HANDOFF_SKILL, VIBE_SKILL, TICKET_TEMPLATE, TICKET_WORKER, CHANGE_WORKER):
        text = skill_split.read(path)
        for retired in ("draft scope", "full scope", "--scope", "vibe-stub", "stubs.md", "api-requirements"):
            assert retired not in text.lower(), (path.name, retired)
    assert not (PLUGIN_ROOT / "skills" / "vibe" / "references" / "stubs.md").exists()
    assert not (PLUGIN_ROOT / "agents" / "vibe-api-requirements-writer.md").exists()


def test_vibe_sends_pure_mockups_to_prototype() -> None:
    starting_new = section(skill_split.read(VIBE_SKILL), "## 2. Start or resume")
    build_loop = section(skill_split.read(VIBE_SKILL), "## 5. Build loop")

    # Operator ruling: vibe invokes the canonical workflow itself.
    assert "`new-prototype`" in starting_new
    assert "without an app data mode" in starting_new
    assert "`<repo-root>/.claude/skills/prototype/SKILL.md`" in starting_new
    assert "canonical Vercel sharing" in starting_new
    assert "Do not spawn a separate prototype source writer" in starting_new
    assert "Pure mockups still use canonical `$prototype` guidance through this writer" in build_loop
    assert "`$prototype`" in build_loop


def test_owned_prototypes_keep_handoff_assignment_and_canonical_transitions() -> None:
    skill = skill_split.read(HANDOFF_SKILL)
    worker = skill_split.read(PLUGIN_ROOT / "agents" / "vibe-prototype-worker.md")
    assert "next-owner lookup and ticket assignment stay intact" in section(skill, "### Owned prototype sessions")
    assert "the missing tests list in its same context, writing no tests" in section(skill, "### Owned prototype sessions")
    assert "PrototypeStatus.HandedOff remains owned by prototype-approve" in skill
    assert "No PR is opened" in worker
    assert "canonical share-on-Vercel procedure on this exact branch" in worker
    assert "prototype-result --worktree" in worker
    assert "immutable URL selection" in worker


def test_prototype_preflight_mode_survives_setup_worker_repairs() -> None:
    setup_worker = skill_split.read(PLUGIN_ROOT / "agents" / "vibe-setup-worker.md")
    preflight = skill_split.read(PLUGIN_ROOT / "skills" / "vibe" / "references" / "preflight.md")
    assert "selected preflight arguments" in skill_split.read(VIBE_SKILL)
    assert "Keep `--prototype` during common/prototype repair" in setup_worker
    assert "replace the `--repo` path but preserve `--prototype`" in preflight


def test_handoff_verifies_coverage_from_the_whole_session_table() -> None:
    checks = section(skill_split.read(HANDOFF_SKILL), "## 5. Checks and the missing tests list")
    for required in ("whole session decision table", "all requests", "stable row IDs",
                     "Required Tests", "negative", "cross-request interactions"):
        assert required in checks, required
    review = section(skill_split.read(HANDOFF_SKILL), "## 6. Independent integrated review")
    assert "whole session decision table" in review
    assert "Final Alignment Status: Aligned" in review
    assert "blocks final handoff" in review
    ticket = section(skill_split.read(HANDOFF_SKILL), "## 8. Choose who picks it up, then check the ticket")
    assert "required session decision table" in ticket
    assert "decision tables in `.closedloop-ai/decision-tables/` if any" not in ticket
    worker = section(skill_split.read(CHANGE_WORKER), "## Tests: repair, don't author")
    assert "whole session decision table" in worker and "row IDs" in worker
    assert "planned" in worker and "executed" in worker


def test_table_attachments_preserve_private_plan_and_truthful_final_evidence() -> None:
    ticket = section(skill_split.read(TICKET_WORKER), "## Handoff mode")
    assert "required session decision table" in ticket
    assert "attach each decision table" in ticket
    assert "never include the local plan folder" in ticket
    assert "Final Alignment Status: Aligned" in ticket
    assert "required coverage gaps" in ticket


def test_design_review_is_pending_at_creation_and_populated_at_handoff() -> None:
    create = section(skill_split.read(TICKET_WORKER), "## Create mode")
    handoff = section(skill_split.read(TICKET_WORKER), "## Handoff mode")
    assert "Design Review" in create and "Pending." in create
    assert "Design Review" in handoff and "verified final diff" in handoff
    assert "only at handoff" in handoff
    assert "technical plan" in handoff and "never" in handoff


def test_design_review_template_contains_every_grading_evidence_family() -> None:
    design = section(skill_split.read(TICKET_TEMPLATE), "## Design Review")
    for required in ("App and Storybook previews", "deployed commit", "protection",
                     "scope, screens, hosts and states", "added/changed/removed",
                     "IDs and direct links", "controls, Docs and plays",
                     "ID/category moves and sidebar folds", "footprint", "catalog",
                     "advisories", "reports and screenshots", "viewports",
                     "source-only", "unverified", "known gaps", "remaining design decisions"):
        assert required in design, required
    assert "source-backed" in design and "no invented" in design.lower()


def test_design_review_callers_preserve_actual_inspection_and_detailed_inventory() -> None:
    handoff = skill_split.read(HANDOFF_SKILL)
    for required in ("Design Review", "verified final diff", "detailed design evidence",
                     "looks good", "Storybook correct", "actual inspection",
                     "source-only", "unverified", "no technical approval"):
        assert required in handoff, required
    for name in ("vibe-handoff-summarizer", "vibe-verify-worker", "vibe-storybook-decomposer"):
        text = skill_split.read(PLUGIN_ROOT / "agents" / f"{name}.md")
        assert "Design Review" in text and "evidence" in text, name
    summary = skill_split.read(PLUGIN_ROOT / "agents" / "vibe-handoff-summarizer.md")
    assert "detailed" in summary and "do not truncate" in summary


def test_handoff_production_impact_is_conditional_and_production_only() -> None:
    handoff = section(skill_split.read(TICKET_TEMPLATE), "## Handoff")
    for required in ("Production impact", "if merged", "production-only",
                     "added/changed/removed", "paths and effects", "shared parent",
                     "consumers", "web/Desktop", "not already shipped",
                     "story/test/prototype-only"):
        assert required in handoff, required
    assert "Production impact" in section(skill_split.read(HANDOFF_SKILL), "## 8. Choose who picks it up, then check the ticket")


def test_handoff_flags_separate_delta_gates_and_evidence_classes() -> None:
    handoff = section(skill_split.read(TICKET_TEMPLATE), "## Handoff")
    for required in ("Flag changes and gates", "exact keys", "new", "existing modified",
                     "removed", "owning source paths", "entry points", "reads",
                     "mutations", "host gates", "source defaults", "verified production",
                     "timestamp", "evidence", "local QA", "No new flags",
                     "existing gates", "unavailable or stale", "never guess"):
        assert required in handoff, required
    assert "Labs flag keys" not in skill_split.read(PLUGIN_ROOT / "agents" / "vibe-handoff-summarizer.md")


def test_handoff_open_questions_require_research_and_exclude_settled_answers() -> None:
    handoff = section(skill_split.read(TICKET_TEMPLATE), "## Handoff")
    for required in ("Open Questions", "graph", "live ClosedLoop", "sources checked",
                     "context", "decision needed", "Product/Design/Scope",
                     "answered or settled", "engineering limitations", "None",
                     "technical approval"):
        assert required in handoff, required
    worker = section(skill_split.read(TICKET_WORKER), "## Handoff mode")
    assert "Open Questions" in worker
    assert "quality-loop.md" in worker
    assert "None" in worker


def test_handoff_metadata_preserves_snapshot_headings_and_phase() -> None:
    template = skill_split.read(TICKET_TEMPLATE)
    body = template.split("````markdown", 1)[1].split("````", 1)[0]
    assert re.findall(r"^## (.+)$", body, re.MULTILINE) == [
        "What this is", "Scope and acceptance criteria", "Environment", "Progress",
        "Backend built", "Backend still missing", "Production flag snapshot",
        "Sessions", "Handoff", "Design Review", "Grading", "Engineering checklist",
    ]
    rules = section(template, "## Rules for every worker that edits it")
    assert "sections are never written by hand" in rules
    assert "ticket-sections" in rules
    handoff = section(template, "## Handoff")
    assert "without overwriting the machine-generated snapshot" in handoff
    assert "Filled at handoff" in handoff
    create = section(skill_split.read(TICKET_WORKER), "## Create mode")
    assert "Handoff, Design Review, and Grading" in create and "Pending." in create


def test_pull_request_body_and_evidence_are_gated_by_the_inventory() -> None:
    hand_over = section(skill_split.read(HANDOFF_SKILL), "## 9. Hand it over")
    assert "`blocking.prBody` and `blocking.prEvidence`" in hand_over
    mode = section(skill_split.read(PLUGIN_ROOT / "agents" / "vibe-environment-worker.md"), "## Pull-request mode")
    for required in ("--phase pull-request --overlap --live-ticket", "`assertionChanges`", "`refusals`",
                     "false creates nothing (`NEEDS_CHANGE`)", "fresh PostHog evaluation"):
        assert required in mode, required
    assert "`serverOnly` true skips step 4" in section(skill_split.read(HANDOFF_SKILL), "## 1. Internal checklist")


def test_input_readiness_runs_once_after_the_committed_merge() -> None:
    """The pre-capture readiness pass was cut: capture checks parity only, readiness runs once after the merge."""
    agents = PLUGIN_ROOT / "agents"
    docs = [HANDOFF_SKILL, VIBE_SKILL, *(PLUGIN_ROOT / "skills" / "vibe" / "references").glob("*.md"), *agents.glob("*.md")]
    for path in docs:
        text = flat(skill_split.read(path))
        for stale in ("`main-sync-inputs` before", "main-sync-inputs` record turn as", "Run `main-sync-inputs` again",
                      "Before publisher preparation, resume the SAME registered source actor"):
            assert stale not in text, f"{path.name}: {stale}"
    environment = flat(skill_split.read(PLUGIN_ROOT / "skills" / "vibe" / "references" / "environment.md"))
    assert "once, after this exact committed merge/fix result" in environment
    assert "no readiness pass precedes capture" in environment
    assert "fix that cause rather than rerunning into the same bound" in environment
    handoff = flat(skill_split.read(HANDOFF_SKILL))
    assert "`main-sync-inputs`" in handoff
    assert "`commit-worktree.mjs --worktree \"<wt>\" --amend`" in handoff
    assert "still-unpushed commit" in handoff
