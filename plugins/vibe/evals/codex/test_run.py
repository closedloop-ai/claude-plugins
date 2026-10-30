"""Regression coverage for parity, budgets and grading, with no paid calls."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import time

import pytest

SPEC = importlib.util.spec_from_file_location(
    "vibe_codex_eval", Path(__file__).with_name("run.py")
)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def test_one_case_per_claude_prompt_and_role_names() -> None:
    found = runner.cases()
    assert len(found) == 108
    assert len({c["name"] for c in found}) == len(found)
    assert all(c["name"].startswith(("executive-", "product-manager-", "orchestrator-")) for c in found)
    for case in found:
        _, original = runner.document(case["source"] / "prompt.md")
        assert case["prompt"] == runner.role_text(original)
    assert "give it to product-designer@example.invalid" in next(
        c["prompt"] for c in found if "named-person" in c["name"]
    )
    assert "my name is the product manager" in next(
        c["prompt"] for c in found if "real-exchange" in c["name"]
    )


def test_fleet_cases_load_the_installed_skill_without_leaking_answer_lines() -> None:
    """Both runtimes consult the same plugin instructions before grading behavior."""
    cases = {case["name"]: case["prompt"] for case in runner.cases()}
    for name in ("orchestrator-parallel-e2e-queued", "orchestrator-owned-qa-cleanup", "orchestrator-parallel-build-helpers"):
        prompt = cases[name]
        assert "if you are in Claude Code, load `vibe:fleet-orchestrator`" in prompt
        assert "If you are in Codex, read the installed repository snapshot" in prompt
        assert "../market/plugins/vibe/skills/fleet-orchestrator/SKILL.md" in prompt
        assert "../market/plugins/vibe/skills/fleet-orchestrator/references/templates.md" in prompt
        assert "Do not answer until you have read the instructions" in prompt
        assert "Let the skill and its template determine the response shape" in prompt
        assert "Reply in exactly this form" not in prompt
        for label in ("START_INTEGRATION:", "START_TYPECHECK:", "DEPENDENCIES:",
                      "REPORT:", "ETA:", "ACTION:", "DOCKER:", "FOREIGN:", "STATUS:"):
            assert label not in prompt, (name, label)
    snapshot_read = [{"name": "exec_command", "arguments": "cat ../market/plugins/vibe/skills/fleet-orchestrator/SKILL.md"}]
    assert runner.loaded_plugin_read(snapshot_read, "fleet-orchestrator")
    source_read = [{"name": "exec_command", "arguments": "cat plugins/vibe/skills/fleet-orchestrator/SKILL.md"}]
    assert not runner.loaded_plugin_read(source_read, "fleet-orchestrator")


def test_parallel_e2e_scenario_states_queue_wait_and_run_duration() -> None:
    """The e2e critical path has both durations needed for the expected ETA."""
    prompt = next(case["prompt"] for case in runner.cases() if case["name"] == "orchestrator-parallel-e2e-queued")
    wait = re.search(r"unrelated e2e run has (\d+) minutes left", prompt)
    assert "This PR's selected e2e run is queued behind it; when that run ends" in prompt
    duration = re.search(r"selected e2e starts and lasts (\d+) minutes", prompt)
    integration = re.search(r"Integration takes (\d+) minutes", prompt)
    typecheck = re.search(r"typecheck takes (\d+) minutes", prompt)
    assert wait is not None
    assert duration is not None
    assert integration is not None
    assert typecheck is not None
    assert "no prerequisite edge to each other or to e2e" in prompt
    assert max(int(wait.group(1)) + int(duration.group(1)),
               int(integration.group(1)), int(typecheck.group(1))) == 20


def test_fleet_scenarios_require_the_plugin_to_override_stale_coordination() -> None:
    """Main should follow stale coordination that only the new fleet rules supersede."""
    cases = {case["name"]: case["prompt"] for case in runner.cases()}
    lane = cases["orchestrator-parallel-e2e-queued"]
    assert "saved remaining-steps checklist" in lane
    assert "finish\n  this PR's e2e on machine A, then run integration, then run typecheck" in lane
    assert "predates machine B being allowed" in lane
    cleanup = cases["orchestrator-owned-qa-cleanup"]
    assert "saved monitor convention" in cleanup
    assert "terminal PR events are report-only" in cleanup
    assert "wait for an explicit operator cleanup request" in cleanup
    assert "predates recorded helper ending conditions" in cleanup


def test_parallel_fleet_graders_accept_plain_behavior_without_template_labels(tmp_path: Path) -> None:
    """Behavior, not copied answer labels, decides the lane and helper evals."""
    cases = {case["name"]: case for case in runner.cases()}
    lane = cases["orchestrator-parallel-e2e-queued"]
    parallel = (
        "Start integration and typecheck immediately on allowed machine B, concurrently while e2e is queued on machine A. "
        "Neither lane depends on e2e. Machine A waits 8 minutes, then its e2e takes 12 minutes; "
        "machine B runs integration for 10 minutes and typecheck for 4 minutes at the same time. "
        "Time to ready is 20 minutes, from the longest dependent path on A: wait then e2e."
    )
    checks, _ = runner.deterministic(lane, parallel, tmp_path, [])
    assert all(check["passed"] for check in checks if check["grader"] != "loaded-plugin"), checks
    serial = "Wait for e2e on machine A to finish, then start integration and typecheck on B. Time to ready is 34 minutes."
    checks, _ = runner.deterministic(lane, serial, tmp_path, [])
    assert any(not check["passed"] for check in checks if check["grader"] != "loaded-plugin")


def test_fleet_semantic_graders_accept_real_ordering_and_require_every_concept(tmp_path: Path) -> None:
    """Transcript wording order must not decide the four behavior checks."""
    cases = {case["name"]: case for case in runner.cases()}
    def matches(case: str, grader: str, reply: str) -> bool:
        path = Path(__file__).parents[1] / case / "graders" / f"{grader}.md"
        meta, _ = runner.document(path)
        return re.search(meta["pattern"], reply, re.IGNORECASE) is not None

    lane = "orch-parallel-e2e-queued"
    dependency = "These two have no prerequisite on each other or on e2e, so they run in parallel."
    assert matches(lane, "no-e2e-dependency", dependency)
    assert not matches(lane, "no-e2e-dependency", "These two have no prerequisite on each other, so they run in parallel.")
    assert not matches(lane, "no-e2e-dependency", "E2e is queued, and these two lanes are selected.")
    eta = "Time to ready. The longest dependent path is the 8-minute wait plus our 12-minute e2e, which gives 20 minutes."
    assert matches(lane, "parallel-eta", eta)
    for missing in (
        "The longest dependent path is the 8-minute wait plus 12-minute e2e, which gives 20 minutes.",
        "Time to ready is 20 minutes after the e2e run.",
        "Time to ready follows the longest dependent path through the wait and e2e.",
    ):
        assert not matches(lane, "parallel-eta", missing), missing

    cleanup = "orch-owned-qa-cleanup"
    foreign = "Left untouched:\nqa-foreign keeps running and gets no cleanup, no stop."
    assert matches(cleanup, "leave-foreign-alone", foreign)
    assert not matches(cleanup, "leave-foreign-alone", "The other stack keeps running and gets no cleanup.")
    assert not matches(cleanup, "leave-foreign-alone", "qa-foreign is recorded on the board.")
    assert not matches(cleanup, "leave-foreign-alone", "qa-foreign will be removed. qa-owned gets no cleanup.")
    assert not matches(cleanup, "leave-foreign-alone", "Left untouched: qa-foreign will be removed.")
    terminal = "PR 42 is closed, so I reconcile the recorded helper now.\nqa-owned has reached its ending condition."
    assert matches(cleanup, "reconcile-terminal-pr", terminal)
    for missing in (
        "PR 42 is still open, so I reconcile qa-owned now.",
        "PR 42 is closed, so I reconcile the recorded helper now.",
        "PR 42 is closed; qa-owned remains recorded.",
        "PR 42 is closed, so I reconcile qa-owned later.",
        "PR 42 is closed. I inspect qa-foreign now; I will reconcile qa-owned later.",
    ):
        assert not matches(cleanup, "reconcile-terminal-pr", missing), missing

    helpers = cases["orchestrator-parallel-build-helpers"]
    split = (
        "Assign the proof test tests/criterion-a.test.ts exclusively to helper branch proof-a. "
        "Assign the whole new module src/new-index/index.ts and src/new-index/mapper.ts exclusively to a different helper branch module-b. "
        "These allowlists are disjoint, with one writer per branch. Helpers never edit the ticket branch and never repair defects "
        "in the ticket writer's code; route such defects back to the ticket writer. "
        "Helpers return commits or proof but never integrate them. The ticket writer alone integrates, "
        "and an independent read-only reviewer checks the work."
    )
    checks, _ = runner.deterministic(helpers, split, tmp_path, [])
    assert all(check["passed"] for check in checks if check["grader"] != "loaded-plugin"), checks
    overlap = (
        "Use one helper branch to edit tests/criterion-a.test.ts, src/new-index/index.ts and "
        "src/new-index/mapper.ts while the ticket writer also edits that branch. "
        "The helper repairs the ticket writer's defect and merges directly."
    )
    checks, _ = runner.deterministic(helpers, overlap, tmp_path, [])
    assert any(not check["passed"] for check in checks if check["grader"] != "loaded-plugin")

    cleanup = cases["orchestrator-owned-qa-cleanup"]
    owned = (
        "PR 42 closed, so reconcile qa-owned now without waiting for the operator. "
        "Stop only its recorded process and remove the exact recorded Docker container, volume and network "
        "after checking identity and creation witnesses. Leave qa-foreign untouched because it belongs to another worker "
        "and has no record. Fleet status: qa-owned owner writer-a ticket ISS-13420 is cleaned up; qa-foreign remains."
    )
    checks, _ = runner.deterministic(cleanup, owned, tmp_path, [])
    assert all(check["passed"] for check in checks if check["grader"] != "loaded-plugin"), checks
    foreign_removed = "PR 42 closed. Remove qa-foreign with its container, volume and network; qa-owned can wait."
    checks, _ = runner.deterministic(cleanup, foreign_removed, tmp_path, [])
    assert any(not check["passed"] for check in checks if check["grader"] != "loaded-plugin")


def test_fleet_graders_accept_preserved_codex_and_claude_reply_word_orders(tmp_path: Path) -> None:
    """Preserved Codex replies and Claude-style paragraph orders carry the same behavior."""
    cases = {case["name"]: case for case in runner.cases()}
    codex_lane = """Integration and typecheck start now on Machine B in parallel, using its two free heavy slots. The selected e2e remains queued on Machine A: 8 minutes for the unrelated run, then 12 minutes for this PR’s e2e.

There are no prerequisite edges between these lanes, so integration (10 minutes) and typecheck (4 minutes) run concurrently with the queued/running e2e. No capacity move or scheduling change is needed.

Ready in approximately **20 minutes**, assuming all lanes pass and the e2e queue timing holds. The longest path is **8 minutes queued → 12 minutes e2e**; integration and typecheck finish within that window."""
    codex_cleanup = """Lifecycle cleanup report

- Reconcile recorded helper `qa-owned` now because `acme/app#42` is closed; no operator cleanup request is required.
- Recheck its PID birth identity and creation witnesses, then remove only the exact recorded `qa-owned` container, volumes, and network. Refuse removal if any recorded identity or witness no longer matches.
- Leave all `qa-foreign` resources untouched: they are unrecorded by this program and belong to another worker and ticket.
- Final status: `qa-owned` cleanup pending reconciliation; owner `writer-a`, ticket `ISS-13420`, PR `acme/app#42` closed. Re-arm the fleet watcher after handling the event."""
    claude_lane = (
        "Machine B can start typecheck and integration now in parallel while e2e remains queued on Machine A. "
        "These two have no prerequisite on each other or on e2e. Time to ready is 20 minutes. "
        "The longest dependent path is the 8-minute queue followed by the 12-minute e2e."
    )
    claude_cleanup = (
        "PR 42 is closed, so I reconcile the recorded helper now. qa-owned has reached its ending condition. "
        "After checking exact identity and creation witnesses, remove its recorded container, volumes and network. "
        "Left untouched: qa-foreign keeps running and gets no cleanup or stop. "
        "Final status gives owner writer-a and ticket ISS-13420."
    )
    for name, replies in (("orchestrator-parallel-e2e-queued", (codex_lane, claude_lane)),
                          ("orchestrator-owned-qa-cleanup", (codex_cleanup, claude_cleanup))):
        for reply in replies:
            checks, _ = runner.deterministic(cases[name], reply, tmp_path, [])
            assert all(check["passed"] for check in checks if check["grader"] != "loaded-plugin"), (name, checks)

    def graded(name: str, grader: str, reply: str) -> bool:
        checks, _ = runner.deterministic(cases[name], reply, tmp_path, [])
        return next(check["passed"] for check in checks if check["grader"] == grader)

    lane = "orchestrator-parallel-e2e-queued"
    for grader, reply in (
        ("integration-starts-on-b", codex_lane.replace("Integration and typecheck start now", "Typecheck starts now; integration waits")),
        ("typecheck-starts-on-b", codex_lane.replace("Integration and typecheck start now", "Integration starts now; typecheck waits")),
        ("no-e2e-dependency", codex_lane.replace("There are no prerequisite edges between these lanes", "E2e is a prerequisite for these lanes")),
        ("parallel-report", codex_lane.replace("in parallel", "in sequence").replace("run concurrently", "run in sequence")),
        ("parallel-report", codex_lane.replace("Machine A", "Machine C")),
        ("parallel-report", codex_lane.replace("Machine B", "Machine C")),
        ("parallel-eta", codex_lane.replace("**20 minutes**", "**34 minutes**")),
        ("parallel-eta", codex_lane.replace("The longest path", "The total duration")),
    ):
        assert not graded(lane, grader, reply), grader

    cleanup = "orchestrator-owned-qa-cleanup"
    for grader, reply in (
        ("reconcile-terminal-pr", codex_cleanup.replace("is closed", "is open").replace("#42` closed", "#42` open")),
        ("reconcile-terminal-pr", codex_cleanup.replace("now because", "later because")),
        ("reconcile-terminal-pr", codex_cleanup.replace("qa-owned", "qa-other")),
        ("remove-owned-docker", codex_cleanup.replace("exact recorded", "unverified")),
        ("remove-owned-docker", codex_cleanup.replace("Recheck its PID birth identity and creation witnesses, then ", "")),
        ("remove-owned-docker", codex_cleanup.replace("container, volumes, and network", "volumes and network")),
        ("remove-owned-docker", codex_cleanup.replace("container, volumes, and network", "container and network")),
        ("remove-owned-docker", codex_cleanup.replace("container, volumes, and network", "container and volumes")),
        ("leave-foreign-alone", codex_cleanup.replace("Leave all `qa-foreign` resources untouched", "Remove all `qa-foreign` resources")),
        ("report-owner-ticket", codex_cleanup.replace("writer-a", "writer-b")),
        ("report-owner-ticket", codex_cleanup.replace("ISS-13420", "another ticket")),
    ):
        assert not graded(cleanup, grader, reply), grader


@pytest.mark.parametrize("layout", [".codex-plugin", ".claude-plugin"])
def test_plugin_version_accepts_either_runtime_manifest(tmp_path: Path, layout: str) -> None:
    manifest = tmp_path / layout / "plugin.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({"version": "1.2.3"}))
    assert runner.plugin_version(tmp_path) == "1.2.3"


def test_every_model_grader_has_a_deterministic_or_wording_route() -> None:
    deterministic = {
        "explains-both-endings",
        "notice-does-not-wait",
        "starts-the-pull-request-path",
        "criterion-from-words",
        "criteria-recorded",
        "criteria-mapped",
        "compared-before-ready",
        "checks-log-light-and-dark",
    }
    for case in runner.cases():
        for path in (case["source"] / "graders").glob("*.md"):
            meta, _ = runner.document(path)
            assert meta["type"] in ("regex", "tool_used", "llm")
            if meta["type"] == "llm":
                assert path.stem in deterministic | {
                    "plain-language",
                    "plain-ready-message",
                }


def test_wrong_route_and_missing_must_say_fail(tmp_path: Path) -> None:
    case = next(c for c in runner.cases() if c["name"] == "executive-done-asks-two-way")
    checks, wording = runner.deterministic(
        case, "REPLY: Who should take it?\nROUTE: ask-name", tmp_path, []
    )
    assert {c["grader"] for c in checks if not c["passed"]} >= {
        "route",
        "two-way-choice",
    }
    assert wording
    checks, _ = runner.deterministic(
        case,
        "REPLY: Do you want me to open a pull request so you can take it through review and merge, or pass it to someone to finish?\nROUTE: ask-two-way",
        tmp_path,
        [],
    )
    assert all(c["passed"] for c in checks)


def test_resume_plan_eval_rejects_the_main_behavior(tmp_path: Path) -> None:
    case = next(c for c in runner.cases() if c["name"] == "product-manager-resume-existing-ticket-plan")
    main_behavior = "MISSING: keep the local plan unpublished\nEXISTING: reuse PLN-1450 and create no new plan\nBUILD: neither pauses"
    checks, _ = runner.deterministic(case, main_behavior, tmp_path, [])
    assert not next(c for c in checks if c["grader"] == "missing-publishes-plan")["passed"]


def test_resume_plan_eval_rejects_inverted_answers(tmp_path: Path) -> None:
    case = next(c for c in runner.cases() if c["name"] == "product-manager-resume-existing-ticket-plan")
    inverted = (
        "MISSING: do not publish one implementation plan; ISS-14001 PRODUCES and links that PLN\n"
        "EXISTING: do not update PLN-1450 and create no new plan\n"
        "BUILD: no, the build must pause"
    )
    checks, _ = runner.deterministic(case, inverted, tmp_path, [])
    graded = {check["grader"]: check["passed"] for check in checks}
    assert not graded["missing-publishes-plan"]
    assert not graded["existing-reuses-plan"]
    assert not graded["build-continues"]
    named = (
        "MISSING: the vibe-ticket-worker in plan mode refuses to publish a PLN for ISS-14001 or add links\n"
        "EXISTING: vibe-ticket-worker in plan mode reconciles PLN-1450 and creates no new plan\n"
        "BUILD: the build does not continue; it pauses until the PLN exists"
    )
    checks, _ = runner.deterministic(case, named, tmp_path, [])
    graded = {check["grader"]: check["passed"] for check in checks}
    assert not graded["missing-publishes-plan"]
    assert not graded["build-continues"]


def test_resume_plan_eval_accepts_equivalent_positive_wording(tmp_path: Path) -> None:
    case = next(c for c in runner.cases() if c["name"] == "product-manager-resume-existing-ticket-plan")
    replies = [
        "MISSING: vibe-ticket-worker in plan mode creates and uploads the criterion-complete canonical local plan as a PLN and links it to ISS-14001 with PRODUCES.\n"
        "EXISTING: vibe-ticket-worker in plan mode reconciles the local plan with PLN-1450; create no new PLN.\n"
        "BUILD: Plan reconciliation pauses neither source build.",
        "MISSING: The same source writer writes a plan covering every criterion and continues the build. The vibe ticket worker publishes it in plan mode as one new PLN, then links ISS-14001 PRODUCES PLN.\n"
        "EXISTING: The vibe ticket worker reconciles PLN-1450 in plan mode and updates it if needed. No new PLN is created.\n"
        "BUILD: Plan reconciliation pauses neither source build.",
    ]
    for reply in replies:
        checks, _ = runner.deterministic(case, reply, tmp_path, [])
        behavioral = {check["grader"]: check["passed"] for check in checks if check["grader"] != "loaded-plugin"}
        assert all(behavioral.values()), behavioral


def test_missing_negative_check_target_cannot_pass(tmp_path: Path) -> None:
    case = next(c for c in runner.cases() if "described-change" in c["name"])
    table = tmp_path / "session/.closedloop-ai/decision-tables/session.md"
    table.parent.mkdir(parents=True)
    table.write_text("## Acceptance Criteria\n### Checks\n")
    checks, _ = runner.deterministic(case, "Ready", tmp_path, [])
    assert not next(c for c in checks if c["grader"] == "no-raw-values")["passed"]


def test_visual_evidence_requires_render_after_final_edit(tmp_path: Path) -> None:
    case = next(
        c for c in runner.cases() if c["name"] == "product-manager-reference-card"
    )
    table = tmp_path / "session/.closedloop-ai/decision-tables/session.md"
    table.parent.mkdir(parents=True)
    table.write_text(
        "## Acceptance Criteria\n### Checks\nCompared fresh render: pass\n"
    )
    edit = {"name": "apply_patch", "input": "Update File: session/src/project-card.css"}
    render = {
        "name": "exec_command",
        "arguments": "python3 tools/screenshot.py src/project-card.html built.png",
    }
    view = {"name": "view_image", "arguments": "built.png"}

    def grade(trace):
        return runner.semantic_check(
            "compared-before-ready", case, "Ready to look at.", tmp_path, trace
        )

    assert grade([edit, render, view])
    assert grade(
        [
            {
                "name": "exec",
                "input": "cat > session/src/project-card.css; python3 tools/screenshot.py src/project-card.html built.png",
            },
            view,
        ]
    )
    assert grade(
        [
            edit,
            render,
            {
                "name": "exec",
                "input": "tools.view_image({path: 'images/1.png'}); tools.view_image({path: 'built.png'})",
            },
        ]
    )
    # Updating a log that mentions a CSS path is not a subsequent CSS edit.
    log = {
        "name": "apply_patch",
        "input": "Update File: session/.closedloop-ai/decision-tables/session.md\n- source trace src/project-card.css",
    }
    assert grade([edit, render, view, log])
    assert not grade([render, view, edit])
    assert not grade([edit, render])
    assert not grade(
        [edit, {"name": "agent_message", "input": "I viewed the screenshot"}]
    )


def test_file_criteria_need_each_reference_property_and_tokens(tmp_path: Path) -> None:
    case = next(
        c for c in runner.cases() if c["name"] == "product-manager-reference-card"
    )
    table = tmp_path / "session/.closedloop-ai/decision-tables/session.md"
    table.parent.mkdir(parents=True)
    text = "## Acceptance Criteria\n- reference shadow --shadow-card\n- reference size --text-xl\n- reference weight --weight-bold\n### Checks\nReference read images/1.png\nCompared built screenshot: pass\n"
    table.write_text(text)
    assert runner.semantic_check("criteria-recorded", case, "", tmp_path, [])
    table.write_text(text.replace("- reference weight --weight-bold\n", ""))
    assert not runner.semantic_check("criteria-recorded", case, "", tmp_path, [])


def test_exhausted_budget_never_spawns(tmp_path: Path) -> None:
    budget = runner.Budget(0)
    with pytest.raises(RuntimeError, match="time cap"):
        runner.command(["must-not-exist"], tmp_path, {}, budget, 10, tmp_path / "out")


def test_command_timeout_stops_process(tmp_path: Path) -> None:
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="time cap reached"):
        runner.command(
            ["python3", "-c", "import time;time.sleep(60)"],
            tmp_path,
            dict(__import__("os").environ),
            runner.Budget(0.1),
            60,
            tmp_path / "out",
        )
    assert time.monotonic() - started < 5


def test_trace_is_from_rollout_not_claimed_reply(tmp_path: Path) -> None:
    day = tmp_path / "sessions/day"
    day.mkdir(parents=True)
    (day / "rollout-thread.jsonl").write_text(
        "\n".join(
            json.dumps(x)
            for x in [
                {
                    "type": "response_item",
                    "payload": {"type": "function_call", "name": "view_image"},
                },
                {
                    "type": "response_item",
                    "payload": {"type": "message", "text": "I rendered it"},
                },
            ]
        )
    )
    assert runner.trace_for(
        [{"type": "thread.started", "thread_id": "thread"}], tmp_path
    ) == [{"type": "function_call", "name": "view_image"}]


@pytest.mark.parametrize("valid", [True, False])
def test_wording_model_only_runs_after_deterministic_pass(
    tmp_path: Path, monkeypatch, valid: bool
) -> None:
    case = next(c for c in runner.cases() if c["name"] == "executive-done-asks-two-way")
    calls = []

    def fake_command(args, cwd, env, budget, seconds, output):
        calls.append(args)
        final = Path(args[args.index("-o") + 1])
        if final.name == "reply.json":
            final.write_text(json.dumps({"passed": True, "reason": "plain"}))
        else:
            final.write_text(
                "REPLY: Do you want me to open a pull request so you can take it through review and merge, or pass it to someone to finish?\nROUTE: "
                + ("ask-two-way" if valid else "ask-name")
            )
        output.write_text(
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {"input_tokens": 10, "output_tokens": 2},
                }
            )
        )

    monkeypatch.setattr(runner, "command", fake_command)
    monkeypatch.setattr(
        runner,
        "trace_for",
        lambda *args: [
            {
                "name": "exec_command",
                "arguments": "cat /cache/vibe/1.0.43/skills/vibe/SKILL.md",
            }
        ],
    )
    result = runner.run_case(
        case,
        tmp_path,
        {"CODEX_HOME": str(tmp_path)},
        runner.Budget(60),
        "subject",
        "cheap",
    )
    assert result["passed"] == valid
    assert [args[args.index("-m") + 1] for args in calls] == (
        ["subject", "cheap"] if valid else ["subject"]
    )
    assert result["usage"]["input_tokens"] == (20 if valid else 10)
    assert all("allow_login_shell=false" in args for args in calls)
    assert all(args[-2] == "--" for args in calls)


def test_light_and_dark_need_a_logged_check_with_a_result_per_theme(tmp_path: Path) -> None:
    case = next(
        c for c in runner.cases() if c["name"] == "product-manager-static-page-light-and-dark"
    )
    table = tmp_path / "session/.closedloop-ai/decision-tables/session.md"
    table.parent.mkdir(parents=True)

    def grade(checks: str) -> bool:
        table.write_text("## Acceptance Criteria\n### Checks\n" + checks)
        return runner.semantic_check("checks-log-light-and-dark", case, "Ready.", tmp_path, [])

    light = "R-1, AC-1: reference check (light), compared light.png with images/1.png: met\n"
    dark = "R-1, AC-1: reference check (dark), compared dark.png with images/1.png: met\n"
    assert grade(light + dark)
    assert not grade(light)
    assert not grade(dark)
    assert not grade(light + "Dark mode looks fine.\n")
    assert grade(light + dark.replace(": met", ": not met yet, title too dim"))
    case_checks, _ = runner.deterministic(
        case,
        "Ready.",
        tmp_path,
        [{"name": "exec_command", "arguments": "python3 tools/screenshot.py src/return-page.html light.png"}],
    )
    assert not next(c for c in case_checks if c["grader"] == "renders-dark")["passed"]
    assert not next(c for c in case_checks if c["grader"] == "renders-both-themes")["passed"]


def test_tool_use_counts_each_batched_command(tmp_path: Path) -> None:
    case = next(
        c for c in runner.cases() if c["name"] == "product-manager-static-page-light-and-dark"
    )
    table = tmp_path / "session/.closedloop-ai/decision-tables/session.md"
    table.parent.mkdir(parents=True)
    table.write_text("## Acceptance Criteria\n### Checks\n")
    batched = {
        "name": "exec",
        "input": 'tools.exec_command({cmd:"python3 tools/screenshot.py src/return-page.html light.png --theme light"}),\n'
        'tools.exec_command({cmd:"python3 tools/screenshot.py src/return-page.html dark.png --theme dark"})',
    }
    checks, _ = runner.deterministic(case, "Ready.", tmp_path, [batched])
    graded = {c["grader"]: c["passed"] for c in checks}
    assert graded["renders-both-themes"]
    assert graded["renders-dark"]
    single = {
        "name": "exec",
        "input": 'tools.exec_command({cmd:"python3 tools/screenshot.py src/return-page.html light.png"})',
    }
    checks, _ = runner.deterministic(case, "Ready.", tmp_path, [single])
    graded = {c["grader"]: c["passed"] for c in checks}
    assert not graded["renders-both-themes"]
    assert not graded["renders-dark"]
