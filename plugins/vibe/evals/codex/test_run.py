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
