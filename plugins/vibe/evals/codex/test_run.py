"""Regression coverage for parity, budgets and grading, with no paid calls."""

from __future__ import annotations

import importlib.util
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

import pytest

SPEC = importlib.util.spec_from_file_location(
    "vibe_codex_eval", Path(__file__).with_name("run.py")
)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def eval_case(source_name: str) -> dict:
    """Resolve one real case by its repository directory name."""
    return next(case for case in runner.cases() if case["source"].name == source_name)


def test_iss_13760_mapped_graders_use_shared_checker_and_nonmapped_regex_is_unchanged(
    tmp_path: Path, monkeypatch
) -> None:
    children = eval_case("pm-prd-children-are-scope")
    good = (
        "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; LINK: ISS-9000; "
        "COMMENT:ISS-9000_COORDINATOR\n"
        "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:ACTIVE_OTHER_OWNER\n"
        "UNCOVERED: ISS-9003; ACTION:LEAVE_UNCOVERED\n"
        "SUPERSEDE: None\n\nGraph:\n"
        "- ticket_detail ISS-9002: ISS-9002 active by another person"
    )
    bad = good.replace("ISS-9000_COORDINATOR", "ISS-9000_COORDINATOR_EXTRA")
    good_checks, _ = runner.deterministic(children, good, tmp_path, [])
    bad_checks, _ = runner.deterministic(children, bad, tmp_path, [])
    assert next(check for check in good_checks if check["grader"] == "claims-untouched")["passed"]
    assert not next(check for check in bad_checks if check["grader"] == "claims-untouched")["passed"]

    monkeypatch.setattr(runner, "run_reply_checker", lambda *args: (_ for _ in ()).throw(
        AssertionError("nonmapped grader invoked checker")))
    duplicate = eval_case("pm-review-duplicate-helper-copy")
    checks, _ = runner.deterministic(duplicate,
        "blocking | artifact-creation-dialog.tsx:504 | capitalize duplicates "
        "add-artifact-dialog.tsx:428 | same helper | Move capitalize into "
        "generic-artifact-surface and remove the duplicate function",
        tmp_path, [])
    assert next(check for check in checks if check["grader"] == "both-sites")["passed"]


@pytest.mark.parametrize("stdout,returncode,stderr", [
    ("not json", 0, ""),
    ('{"caseId":"wrong","graderName":"claims-untouched","passed":true,"reason":"x"}', 0, ""),
    ('{"caseId":"pm-prd-children-are-scope","graderName":"claims-untouched",'
     '"passed":true,"reason":"x"}', 2, "checker failed"),
])
def test_iss_13760_checker_protocol_fails_closed(
    monkeypatch, stdout: str, returncode: int, stderr: str
) -> None:
    monkeypatch.setattr(runner.CHECKER_ADAPTER.shutil, "which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(runner.CHECKER_ADAPTER.subprocess, "run", lambda *args, **kwargs:
        SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))
    with pytest.raises(RuntimeError, match="eval-checker-(?:execution-failed|output-invalid)"):
        runner.run_reply_checker(Path(__file__), "pm-prd-children-are-scope",
            "claims-untouched", "reply")


@pytest.mark.parametrize("entries", [
    [{"caseId": "pm-prd-children-are-scope", "graderName": "claims-untouched",
      "checker": "iss-13760-reply-format.mjs"}],
    [
        {"caseId": "pm-prd-children-are-scope", "graderName": "claims-untouched",
         "checker": "iss-13760-reply-format.mjs"},
        {"caseId": "pm-prd-children-are-scope", "graderName": "no-supersession",
         "checker": "iss-13760-reply-format.mjs"},
        {"caseId": "extra", "graderName": "extra", "checker": "iss-13760-reply-format.mjs"},
    ],
    [
        {"caseId": "pm-prd-children-are-scope", "graderName": "claims-untouched",
         "checker": "iss-13760-reply-format.mjs"},
        {"caseId": "pm-prd-children-are-scope", "graderName": "claims-untouched",
         "checker": "iss-13760-reply-format.mjs"},
    ],
])
def test_iss_13760_checker_manifest_requires_exact_mappings(
    tmp_path: Path, monkeypatch, entries: list[dict[str, str]]
) -> None:
    root = tmp_path / "checkers"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "entries": entries}))
    (root / "iss-13760-reply-format.mjs").write_text("process.stdout.write('{}')\n")
    monkeypatch.setattr(runner.CHECKER_ADAPTER, "EVALS", tmp_path)
    with pytest.raises(RuntimeError, match="eval-checker-manifest-invalid"):
        runner.reply_checker("pm-prd-children-are-scope", "claims-untouched")


@pytest.mark.parametrize("linked_component", ["evals", "checkers", "module"])
def test_iss_13760_checker_rejects_symlinked_path_components(
    tmp_path: Path, monkeypatch, linked_component: str
) -> None:
    real = tmp_path / "real"
    real.mkdir()
    real_evals = real / "evals"
    real_checkers = real_evals / "checkers"
    real_checkers.mkdir(parents=True)
    manifest = Path(__file__).parents[1] / "checkers/manifest.json"
    module = Path(__file__).parents[1] / "checkers/iss-13760-reply-format.mjs"
    (real_checkers / "manifest.json").write_bytes(manifest.read_bytes())
    (real_checkers / "iss-13760-reply-format.mjs").write_bytes(module.read_bytes())
    selected_evals = real_evals
    if linked_component == "evals":
        linked_root = tmp_path / "linked-root"
        linked_root.mkdir()
        (linked_root / "evals").symlink_to(real_evals, target_is_directory=True)
        selected_evals = linked_root / "evals"
    elif linked_component == "checkers":
        selected_evals = tmp_path / "linked-evals"
        selected_evals.mkdir()
        (selected_evals / "checkers").symlink_to(real_checkers, target_is_directory=True)
    else:
        real_module = real / "iss-13760-reply-format.mjs"
        (real_checkers / "iss-13760-reply-format.mjs").replace(real_module)
        (real_checkers / "iss-13760-reply-format.mjs").symlink_to(real_module)
    monkeypatch.setattr(runner.CHECKER_ADAPTER, "EVALS", selected_evals)
    with pytest.raises(RuntimeError, match="eval-checker-(?:root|module)-invalid"):
        runner.reply_checker("pm-prd-children-are-scope", "claims-untouched")


def test_iss_13760_checker_fault_is_not_a_model_failure(
    tmp_path: Path, monkeypatch
) -> None:
    case = eval_case("pm-prd-children-are-scope")
    output = tmp_path / "out"
    output.mkdir()
    def fake_command(*args, **kwargs) -> None:
        (output / case["name"] / "reply.txt").write_text("reply")
    monkeypatch.setattr(runner, "command", fake_command)
    monkeypatch.setattr(runner, "read_events", lambda *args: [])
    monkeypatch.setattr(runner, "trace_for", lambda *args: [])
    monkeypatch.setattr(runner, "reply_checker", lambda *args: Path(__file__))
    monkeypatch.setattr(runner, "run_reply_checker", lambda *args: (_ for _ in ()).throw(
        runner.CheckerInfrastructureError("eval-checker-output-invalid")))
    result = runner.run_case(case, output, {"CODEX_HOME": str(tmp_path)}, runner.Budget(10),
        "model", "grader", True)
    assert result["infrastructure_invalid"] == "eval-checker-output-invalid"
    assert not any(check["grader"] == "execution" for check in result["checks"])


def test_default_model_uses_shared_policy_at_low_effort(tmp_path: Path) -> None:
    """Direct runner invocations agree with the nightly without copying its ID."""
    policy = json.loads(Path(__file__).with_name("model-policy.json").read_text())
    assert runner.default_codex_model() == policy["codexModel"]
    args = runner.exec_args(runner.default_codex_model(), tmp_path, tmp_path / "reply.txt")
    assert args[args.index("-m") + 1] == policy["codexModel"]
    assert 'model_reasoning_effort="low"' in args


def test_iss_14112_ac_8_evals_run_on_the_switched_default(tmp_path: Path) -> None:
    """Operator ruling 2026-11-17 ("Switch evals too"): the runner's default Codex model is gpt-6.2-sol."""
    assert runner.default_codex_model() == "gpt-6.2-sol"
    args = runner.exec_args(runner.default_codex_model(), tmp_path, tmp_path / "reply.txt")
    assert args[args.index("-m") + 1] == "gpt-6.2-sol"


def test_active_process_cleanup_stops_nested_model_group(tmp_path: Path) -> None:
    """An outer interrupt can stop a model process started by a worker thread."""
    marker = tmp_path / "grandchild.pid"
    script = (
        "import pathlib, subprocess, sys, time; "
        "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
        f"pathlib.Path({str(marker)!r}).write_text(str(child.pid)); "
        "time.sleep(60)"
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(runner.command, [sys.executable, "-c", script], tmp_path,
            dict(os.environ), runner.Budget(60), 60, tmp_path / "events.jsonl")
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists()
        child_pid = int(marker.read_text())
        runner.stop_active_processes()
        with pytest.raises(RuntimeError):
            future.result(timeout=5)
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    assert not runner.ACTIVE_PROCESSES


def copied_identity_helper(output: Path) -> Path:
    """Place real runtime helper bytes in the fixture's installed payload (vibe's lib holds them)."""
    target = output / "market/plugins/vibe/lib/vibe/scripts"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("tested-head.mjs", "session-record.mjs", "test-state-isolation.mjs", "git-inventory.mjs"):
        (target / name).write_bytes((runner.IDENTITY_SCRIPTS / name).read_bytes())
    return target / "tested-head.mjs"


def test_receipts_use_copied_helper_after_live_helper_mutates(tmp_path: Path, monkeypatch) -> None:
    copied = copied_identity_helper(tmp_path)
    (tmp_path / "market/plugins/vibe").mkdir(exist_ok=True)
    (tmp_path / "market/plugins/closedloop-core").mkdir()
    (tmp_path / "suite").mkdir()
    live = tmp_path / "live"
    live_scripts = live / "vibe/lib/vibe/scripts"
    live_scripts.mkdir(parents=True)
    for name in ("tested-head.mjs", "session-record.mjs", "test-state-isolation.mjs", "git-inventory.mjs"):
        (live_scripts / name).write_bytes((copied.parent / name).read_bytes())
    monkeypatch.setattr(runner, "IDENTITY_SCRIPTS", live_scripts)
    monkeypatch.setattr(runner, "IDENTITY", live_scripts / "tested-head.mjs")
    before = runner.snapshot_metadata(tmp_path)
    (live_scripts / "tested-head.mjs").write_text('process.stdout.write(JSON.stringify({treeSha256:"forged-live-helper"}));')
    assert runner.snapshot_metadata(tmp_path) == before
    assert before["identity_helper"]["sha256"] == hashlib.sha256(copied.read_bytes()).hexdigest()


def test_install_freezes_receipt_helper_without_modifying_older_model_payload(tmp_path: Path, monkeypatch) -> None:
    plugins = tmp_path / "source/plugins"
    for name in ("vibe", "closedloop-core"):
        (plugins / name).mkdir(parents=True)
        (plugins / name / "input.md").write_text("older payload without identity CLI")
    (plugins / "vibe/evals/example").mkdir(parents=True)
    (plugins / "vibe/evals/example/prompt.md").write_text("---\ntags: []\n---\nfixture\n")
    subprocess.run(["git", "init", "--quiet", str(plugins.parent)], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "add", "."], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], check=True)
    output = tmp_path / "output"
    output.mkdir()
    auth_home = tmp_path / "fixture-auth"
    auth_home.mkdir()
    auth = auth_home / "auth.json"
    auth.write_text('{"token":"fixture"}')
    monkeypatch.setattr(runner, "command", lambda *args: None)
    installed = runner.install(output, plugins / "vibe", {"CODEX_HOME": str(auth_home)}, runner.Budget(60))
    linked_auth = Path(installed["CODEX_HOME"]) / "auth.json"
    assert linked_auth.is_symlink()
    assert linked_auth.resolve() == auth.resolve()
    linked_auth.unlink()
    assert auth.read_text() == '{"token":"fixture"}'
    Path(installed["CODEX_HOME"]).rmdir()
    assert not (output / "market/plugins/vibe/skills/vibe/scripts/tested-head.mjs").exists()
    receipt_helper = output / "receipt-helper/tested-head.mjs"
    assert receipt_helper.is_file()
    receipt = json.loads((output / "snapshot.json").read_text())
    assert receipt["identity_helper"]["sha256"] == hashlib.sha256(receipt_helper.read_bytes()).hexdigest()


def test_private_dirs_are_real_paths_when_the_temp_root_is_a_symlink(tmp_path: Path, monkeypatch) -> None:
    """macOS's temp root is under the /var symlink; node and Codex report real paths, so the run's dirs must be real."""
    real = tmp_path / "private-var"
    real.mkdir()
    linked = tmp_path / "var"
    linked.symlink_to(real, target_is_directory=True)
    monkeypatch.setattr(runner.tempfile, "tempdir", str(linked))
    plugins = tmp_path / "source/plugins"
    for name in ("vibe", "closedloop-core"):
        (plugins / name).mkdir(parents=True)
        (plugins / name / "input.md").write_text("payload")
    (plugins / "vibe/evals/example").mkdir(parents=True)
    (plugins / "vibe/evals/example/prompt.md").write_text("---\ntags: []\n---\nfixture\n")
    subprocess.run(["git", "init", "--quiet", str(plugins.parent)], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "add", "."], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], check=True)
    monkeypatch.setattr(runner, "command", lambda *args: None)
    monkeypatch.setattr(runner, "snapshot_metadata", lambda *args: {})
    output = tmp_path / "output"
    output.mkdir()
    env = runner.install(output, plugins / "vibe", {"CODEX_HOME": str(tmp_path / "auth")}, runner.Budget(60))
    home = Path(env["CODEX_HOME"])
    assert home.parent == real.resolve(), "CODEX_HOME is named by its real path, not through the link"
    assert str(home) == os.path.realpath(home)
    output_dir = runner.private_dir("vibe-codex-eval-")
    assert output_dir.parent == real.resolve(), "the default output dir is named by its real path too"


@pytest.mark.parametrize("escape", ["absolute", "parent", "ignored"])
def test_codex_install_uses_selected_safe_snapshot_inputs(tmp_path: Path, monkeypatch, escape: str) -> None:
    plugins = tmp_path / "source/plugins"
    for name in ("vibe", "closedloop-core"):
        (plugins / name).mkdir(parents=True)
        (plugins / name / "input.md").write_text("selected")
    (plugins / "vibe/evals/example").mkdir(parents=True)
    (plugins / "vibe/evals/example/prompt.md").write_text("---\ntags: []\n---\nfixture\n")
    source = plugins.parent
    (source / ".gitignore").write_text(".env\n")
    subprocess.run(["git", "init", "--quiet", str(source)], check=True)
    subprocess.run(["git", "-C", str(source), "add", "."], check=True)
    subprocess.run(["git", "-C", str(source), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], check=True)
    secret = plugins / ".env"
    secret.write_text("PRIVATE=never-copy")
    if escape != "ignored":
        (plugins / "vibe/leak.md").symlink_to(secret if escape == "absolute" else "../.env")
    else:
        (plugins / "vibe/.env").write_text("PRIVATE=never-copy")
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.setattr(runner, "command", lambda *args: None)
    monkeypatch.setattr(runner, "snapshot_metadata", lambda *args: {})
    if escape != "ignored":
        with pytest.raises(subprocess.CalledProcessError):
            runner.install(output, plugins / "vibe", {"CODEX_HOME": str(tmp_path / "fixture-auth")}, runner.Budget(60))
    else:
        runner.install(output, plugins / "vibe", {"CODEX_HOME": str(tmp_path / "fixture-auth")}, runner.Budget(60))
        assert not (output / "market/plugins/vibe/.env").exists()


def test_copied_payload_receipt_survives_live_source_edits(tmp_path: Path) -> None:
    """Codex metadata names the installed copy, not a later live SKILL read."""
    payload = tmp_path / "market/plugins/vibe/skills/vibe"
    payload.mkdir(parents=True)
    (payload / "SKILL.md").write_text("grader revision 19")
    core = tmp_path / "market/plugins/closedloop-core"
    core.mkdir(parents=True)
    (core / "core.md").write_text("core payload")
    (tmp_path / "suite").mkdir()
    (tmp_path / "suite/graders.md").write_text("frozen grader contract")
    copied_identity_helper(tmp_path)
    receipt = runner.snapshot_metadata(tmp_path)
    assert re.fullmatch(r"[a-f0-9]{64}", receipt["payloads"]["vibe"]["treeSha256"])
    (payload / "SKILL.md").write_text("concurrent edit")
    assert runner.snapshot_metadata(tmp_path) != receipt
    changed_payload = runner.snapshot_metadata(tmp_path)
    (tmp_path / "suite/graders.md").write_text("concurrent grader tweak")
    assert runner.snapshot_metadata(tmp_path) != changed_payload


def test_claude_eval_uses_an_identified_uncommitted_snapshot(tmp_path: Path) -> None:
    """The shared CLI freezes Claude inputs before starting the native eval runner."""
    plugins = tmp_path / "source/plugins"
    for name in ("vibe", "closedloop-core"):
        target = plugins / name
        target.mkdir(parents=True)
        (target / "input.md").write_text("base")
    subprocess.run(["git", "init", "--quiet", str(plugins.parent)], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "add", "."], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "base"], check=True)
    (plugins / "vibe/input.md").write_text("uncommitted grader revision 19")
    out = tmp_path / "out"
    script = runner.PLUGIN / "skills/vibe/scripts/tested-head.mjs"
    run = subprocess.run(["node", str(script), "snapshot", str(plugins), str(out)], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    receipt = json.loads((out / "snapshot.json").read_text())
    assert receipt["payloads"]["vibe"]["treeSha256"]
    assert (out / "plugins/vibe/input.md").read_text() == "uncommitted grader revision 19"
    assert json.loads(run.stdout) == receipt


def test_one_case_per_claude_prompt_and_role_names() -> None:
    found = runner.cases()
    assert len(found) == 125
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


def test_takeover_prompts_rewrite_the_installed_codex_skill() -> None:
    prompts = sorted(runner.EVALS.glob("orch-pr-takeover-*/prompt.md"))
    assert len(prompts) == 6
    for path in prompts:
        original = path.read_text()
        assert "(`vibe:pr-takeover`)" in original, path
        converted = runner.rewrite_skill_invocations(original)
        assert "(`$pr-takeover`)" in converted, path
        assert "(`vibe:pr-takeover`)" not in converted, path


def test_run_source_identity_comes_from_the_copied_vibe_payload() -> None:
    copied = {"payloads": {"vibe": {"treeSha256": "a" * 64}}}
    assert runner.copied_source(copied) == {"treeSha256": "a" * 64}


@pytest.mark.parametrize("checkpoint", [False, True])
def test_pr369_nineteen_revision_replay_rejects_intermediate_commits(tmp_path: Path, checkpoint: bool) -> None:
    """The native Claude regex graders and Codex's grader reject a real intermediate commit."""
    case = next(c for c in runner.cases() if c["name"] == "orchestrator-push-ready-grader-loop")
    assert case["meta"]["scaffold_script"] == "scaffold.sh"
    subprocess.run(["bash", str(case["source"] / case["meta"]["scaffold_script"])], cwd=tmp_path, check=True)
    repo = tmp_path / "session"
    base = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    for revision in range(1, 20):
        (repo / "grader.txt").write_text(str(revision) + "\n")
        subprocess.run(["node", str(repo / "check.mjs"), str(revision)], check=True, capture_output=True)
        if checkpoint and revision == 7:
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qam", "grader tweak"], check=True)
    grades, _ = runner.deterministic(case, "Awaiting independent acceptance", tmp_path, [])
    assert all(g["passed"] for g in grades) is not checkpoint, grades
    if not checkpoint:
        assert subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip() == base
        assert len({line.split()[2] for line in (repo / ".git/grader-runs").read_text().splitlines()}) == 19


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
    assert "is the current working sequence" in lane
    cleanup = cases["orchestrator-owned-qa-cleanup"]
    assert "saved monitor convention" in cleanup
    assert "terminal PR events are report-only" in cleanup
    assert "wait for an explicit operator cleanup request" in cleanup
    assert "current working convention" in cleanup
    assert "action the monitor-event handler\ntakes as it processes this event" in cleanup
    assert "Do not substitute a pending state" in cleanup


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
    assert matches(lane, "no-e2e-dependency", "E2e is queued. Nothing waits on a true prerequisite; all three lanes are independent.")
    assert matches(lane, "no-e2e-dependency", "E2e is queued. No lane has a true prerequisite; the checks run independently.")
    assert not matches(lane, "no-e2e-dependency", "These two have no prerequisite on each other, so they run in parallel.")
    assert not matches(lane, "no-e2e-dependency", "E2e is queued, and these two lanes are selected.")
    eta = "Time to ready. The longest dependent path is the 8-minute wait plus our 12-minute e2e, which gives 20 minutes."
    assert matches(lane, "parallel-eta", eta)
    assert matches(lane, "parallel-eta", "Time to ready is 20 minutes, set by the e2e path.")
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
    assert matches(cleanup, "reconcile-terminal-pr", "Reconcile qa-owned now for acme/app#42 after PR closure.")
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
    codex_lane_with_rejected_history = (
        "The saved checklist says to wait for e2e before integration and typecheck. "
        "That serial order is superseded. " + codex_lane
    )
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
        "After checking exact identity and creation witnesses, remove its exact recorded containers, volumes and network. "
        "Left untouched: qa-foreign keeps running and gets no cleanup or stop. "
        "Final status gives owner writer-a and ticket ISS-13420."
    )
    codex_cleanup_plain = (
        "PR 42 closed, so reconcile qa-owned now. After rechecking its PID birth identity and Docker creation witnesses, "
        "the handler removes only its recorded qa-owned container, volumes and network. Leave qa-foreign untouched. "
        "Final status: writer-a and ISS-13420 are reconciled."
    )
    codex_cleanup_match = (
        "Reconcile qa-owned now for writer-a and ISS-13420 after PR closure on acme/app#42. "
        "Remove the exact recorded container, volumes and network whose creation witnesses match qa-owned. "
        "Leave qa-foreign untouched. Final status: qa-owned is cleaned up."
    )
    for name, replies in (("orchestrator-parallel-e2e-queued", (codex_lane, codex_lane_with_rejected_history, claude_lane)),
                          ("orchestrator-owned-qa-cleanup", (codex_cleanup, codex_cleanup_plain, codex_cleanup_match, claude_cleanup))):
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
        (
            "remove-owned-docker",
            codex_cleanup
            .replace("Recheck its PID birth identity and creation witnesses, then ", "")
            .replace(" Refuse removal if any recorded identity or witness no longer matches.", ""),
        ),
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


def test_split_keys_blocking_grader_honors_multiline_flag(tmp_path: Path) -> None:
    case = next(
        c for c in runner.cases() if c["name"] == "product-manager-flag-key-sprawl-blocked"
    )
    reply = (
        "REPLY: This is the review result.\n"
        "blocking | branches-list.tsx | use one behavior key instead of three split rollout states"
    )
    checks, _ = runner.deterministic(case, reply, tmp_path, [])
    split_keys = next(check for check in checks if check["grader"] == "split-keys-blocking")
    assert split_keys["passed"]


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


@pytest.mark.parametrize("valid", [True, False])
def test_deterministic_only_skips_paid_wording_but_keeps_route_grade(
    tmp_path: Path, monkeypatch, valid: bool
) -> None:
    case = next(c for c in runner.cases() if c["name"] == "executive-done-asks-two-way")
    calls = []

    def fake_command(args, cwd, env, budget, seconds, output):
        calls.append(args)
        Path(args[args.index("-o") + 1]).write_text(
            "REPLY: Do you want me to open a pull request so you can take it through review and merge, or pass it to someone to finish?\nROUTE: "
            + ("ask-two-way" if valid else "ask-name")
        )
        output.write_text(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10}}))

    monkeypatch.setattr(runner, "command", fake_command)
    monkeypatch.setattr(
        runner,
        "trace_for",
        lambda *args: [{"name": "exec_command", "arguments": "cat /cache/vibe/1.0.43/skills/vibe/SKILL.md"}],
    )
    result = runner.run_case(
        case, tmp_path, {"CODEX_HOME": str(tmp_path)}, runner.Budget(60),
        "subject", "cheap", deterministic_only=True,
    )
    assert result["passed"] == valid
    assert result["skipped_graders"] == [
        {"grader": "plain-language", "reason": "deterministic-only"}
    ]
    assert len(calls) == 1
    assert result["usage"]["input_tokens"] == 10
    assert ("route" in {c["grader"] for c in result["checks"]})


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
    # "Count renders" (ISS-14162, 2026-11-14): renders-both-themes is the light check; the
    # pair with renders-dark is what means both themes ran, so a light-only run fails the pair.
    assert not next(c for c in case_checks if c["grader"] == "renders-dark")["passed"]
    assert next(c for c in case_checks if c["grader"] == "renders-both-themes")["passed"]


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
    # "Count renders" (ISS-14162, 2026-11-14): a light-only run passes the light check and
    # fails the pair, because renders-dark fails.
    assert graded["renders-both-themes"]
    assert not graded["renders-dark"]


def test_no_payload_installs_a_separate_provider_plugin(tmp_path: Path) -> None:
    for name in ("vibe", "closedloop-core", "vibe-core", "vibe-closedloop-provider"):
        (tmp_path / name).mkdir()
    assert runner.payload_plugins(tmp_path) == ["vibe", "closedloop-core", "vibe-core"], "an older payload's provider stays out"
    (tmp_path / "vibe-core").rmdir()
    assert runner.payload_plugins(tmp_path) == ["vibe", "closedloop-core"], "an older payload has no vibe-core"
    with pytest.raises(ValueError):
        runner.install(tmp_path, tmp_path / "vibe", {}, runner.Budget(60), arm="other")


def test_generic_cases_cover_the_walk_and_load_no_provider() -> None:
    generic = [case for case in runner.cases() if runner.case_arm(case) == "generic"]
    assert {case["source"].name for case in generic} >= {
        "exec-generic-repo-start-describes-change", "pm-generic-repo-checks-from-agents-md",
        "pm-generic-repo-gates-not-shipped", "orch-generic-repo-fleet-without-graph"}
    for case in generic:
        assert not any("provider" in plugin for plugin in case["meta"]["plugins"]), case["name"]
        assert (case["source"] / "graders" / "no-provider-names.md").is_file(), case["name"]
    assert any(runner.case_arm(case) == "provider" for case in runner.cases())


def test_iss_14116_a_selection_naming_both_arms_is_refused_and_each_arm_accepts_its_own(
    monkeypatch, capsys
) -> None:
    """The nightly passed every ordinary case to one provider-arm run; the driver now splits them by arm."""
    names = {arm: [c["name"] for c in runner.cases() if runner.case_arm(c) == arm] for arm in ("provider", "generic")}
    assert names["provider"] and names["generic"]

    def listed(arm: str, selection: list[str]) -> int:
        argv = ["run.py", "--list", "--arm", arm] + [x for name in selection for x in ("--case", name)]
        monkeypatch.setattr(sys, "argv", argv)
        try:
            return runner.main()
        except SystemExit as stop:
            return stop.code if isinstance(stop.code, int) else 1

    assert listed("provider", names["provider"] + names["generic"]) == 2
    assert "unknown or empty case selection" in capsys.readouterr().err
    for arm in ("provider", "generic"):
        assert listed(arm, names[arm]) == 0
        assert sorted(capsys.readouterr().out.split()) == sorted(names[arm])


def _tree_bytes(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def _source_payload(plugins: Path, vibe_name: str = "vibe") -> None:
    """A committed source tree with the generic vibe, the built folder, and an older payload's provider plugin."""
    for name in ("vibe", "vibe-closedloop", "closedloop-core", "vibe-core", "vibe-closedloop-provider"):
        (plugins / name).mkdir(parents=True)
        (plugins / name / "input.md").write_text(f"{name} text\n> Provider `recipes` (block `x` of `y.md`)\n")
    for relative in runner.MANIFESTS:
        manifest = plugins / "vibe" / relative
        manifest.parent.mkdir()
        manifest.write_text('{"name": "%s", "version": "9.9.9"}' % vibe_name)
        built = plugins / "vibe-closedloop" / relative
        built.parent.mkdir()
        built.write_text('{ "name": "vibe",\n  "version": "9.9.9" }')
    (plugins / "vibe-closedloop/provider").mkdir()
    (plugins / "vibe-closedloop/provider/provider.json").write_text('{"name": "vibe-closedloop-provider"}')
    (plugins / "vibe/evals/example").mkdir(parents=True)
    (plugins / "vibe/evals/example/prompt.md").write_text("---\ntags: []\n---\nfixture\n")
    subprocess.run(["git", "init", "--quiet", str(plugins.parent)], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "add", "."], check=True)
    subprocess.run(["git", "-C", str(plugins.parent), "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], check=True)


def _install_recording(tmp_path: Path, monkeypatch, plugins: Path, arm: str) -> tuple[Path, dict[str, str], list[str], list[list[str]]]:
    added: list[str] = []
    monkeypatch.setattr(runner, "command", lambda args, *rest: added.append(args[3]) if args[1:3] == ["plugin", "add"] else None)
    monkeypatch.setattr(runner, "snapshot_metadata", lambda *args: {})
    spawned: list[list[str]] = []
    real_check_output = subprocess.check_output

    def recording(args, *rest, **kwargs):
        spawned.append(list(args))
        return real_check_output(args, *rest, **kwargs)

    monkeypatch.setattr(runner.subprocess, "check_output", recording)
    output = tmp_path / ("installed-" + arm)
    output.mkdir()
    env = runner.install(output, plugins / "vibe", {"CODEX_HOME": str(tmp_path / "auth"), "HOME": "/the-person"},
                         runner.Budget(60), arm=arm)
    return output, env, added, spawned


@pytest.mark.parametrize("arm", ["provider", "provider-installed"])
def test_a_provider_arm_installs_the_committed_built_folder_as_vibe_untouched(tmp_path: Path, monkeypatch, arm: str) -> None:
    plugins = tmp_path / "source/plugins"
    _source_payload(plugins)
    output, env, added, spawned = _install_recording(tmp_path, monkeypatch, plugins, arm)
    assert _tree_bytes(output / "market/plugins/vibe") == _tree_bytes(plugins / "vibe-closedloop"), \
        "the market's vibe is the built folder, byte for byte, with nothing the harness wrote"
    assert added == [f"{name}@vibe-eval" for name in ("vibe", "closedloop-core", "vibe-core")], "no provider plugin is installed"
    assert not (output / "market/plugins/vibe-closedloop-provider").exists()
    catalog = json.loads((output / "market/.agents/plugins/marketplace.json").read_text())
    assert [entry["name"] for entry in catalog["plugins"]] == ["vibe", "closedloop-core", "vibe-core"]
    assert all(args[:2] == ["node", str(runner.IDENTITY)] and args[2] == "copy" for args in spawned), \
        f"the harness assembles nothing: {spawned}"
    if arm == "provider-installed":
        assert Path(env["HOME"]) == Path(env["CODEX_HOME"]) / "home" and Path(env["HOME"]).is_dir()
    else:
        assert env["HOME"] == "/the-person", "only the realistic arm moves HOME"


def test_an_older_payload_without_a_built_folder_installs_its_own_vibe(tmp_path: Path, monkeypatch) -> None:
    plugins = tmp_path / "source/plugins"
    _source_payload(plugins)
    subprocess.run(["git", "-C", str(plugins.parent), "rm", "-rq", "plugins/vibe-closedloop"], check=True)
    output, _, added, _ = _install_recording(tmp_path, monkeypatch, plugins, "provider")
    assert _tree_bytes(output / "market/plugins/vibe") == _tree_bytes(plugins / "vibe")
    assert added == [f"{name}@vibe-eval" for name in ("vibe", "closedloop-core", "vibe-core")]


@pytest.mark.parametrize("source_name", ["vibe", "vibe-generic"])
def test_the_generic_arm_installs_plugins_vibe_named_vibe(tmp_path: Path, monkeypatch, source_name: str) -> None:
    plugins = tmp_path / "source/plugins"
    _source_payload(plugins, source_name)
    source_manifests = {relative: (plugins / "vibe" / relative).read_bytes() for relative in runner.MANIFESTS}
    output, env, added, spawned = _install_recording(tmp_path, monkeypatch, plugins, "generic")
    market_vibe = output / "market/plugins/vibe"
    installed, source = _tree_bytes(market_vibe), _tree_bytes(plugins / "vibe")
    assert installed.keys() == source.keys()
    for relative in runner.MANIFESTS:
        manifest = json.loads(installed.pop(relative))
        assert manifest == {**json.loads(source.pop(relative)), "name": "vibe"}, "Codex needs the entry's name in the manifest"
    assert installed == source, "everything but the manifest names is plugins/vibe as committed"
    assert {relative: (plugins / "vibe" / relative).read_bytes() for relative in runner.MANIFESTS} == source_manifests, \
        "only the snapshot is renamed, never the source"
    if source_name == "vibe":
        assert _tree_bytes(market_vibe) == _tree_bytes(plugins / "vibe"), "a manifest already named vibe is left byte for byte"
    assert added == [f"{name}@vibe-eval" for name in ("vibe", "closedloop-core", "vibe-core")]
    assert all(args[2] == "copy" for args in spawned) and env["HOME"] == "/the-person"


@pytest.mark.parametrize("arm", ["provider", "provider-installed", "generic"])
def test_a_provider_arm_case_folder_holds_the_opt_in_before_the_bind_and_the_model(tmp_path: Path, monkeypatch, arm: str) -> None:
    case = next(c for c in runner.cases() if c["name"] == (
        "executive-generic-repo-start-describes-change" if arm == "generic" else "executive-done-asks-two-way"))
    _eval_market(tmp_path)
    codex_home = tmp_path / "codex-home"
    env = {"CODEX_HOME": str(codex_home), "HOME": str(codex_home / "home")}
    work = tmp_path / case["name"]
    seen: list[tuple[str, str | None]] = []

    def fake_command(args, cwd, env, budget, seconds, output):
        opt_in = work / runner.OPT_IN_FILE
        seen.append(("check" if "--latest-base" in args else "model", opt_in.read_bytes().decode() if opt_in.exists() else None))
        if "--latest-base" in args:
            output.write_text(json.dumps({"provider": {"state": "bound"}}))
        else:
            Path(args[args.index("-o") + 1]).write_text("reply")
            output.write_text("")

    monkeypatch.setattr(runner, "command", fake_command)
    monkeypatch.setattr(runner, "trace_for", lambda *args: [])
    runner.run_case(case, tmp_path, env, runner.Budget(60), "subject", "cheap", deterministic_only=True, arm=arm)
    expected = None if arm == "generic" else '{ "schema": 1, "provider": "vibe-closedloop-provider" }\n'
    assert seen[0] == ("check" if arm == "provider-installed" else "model", expected), seen
    assert all(opt_in == expected for _, opt_in in seen)
    assert not (case["source"] / ".closedloop-ai").exists(), "the source case folder is never written"


def test_the_provider_installed_arm_runs_the_provider_cases() -> None:
    provider = {case["name"] for case in runner.cases() if runner.runs_case("provider", case)}
    assert provider
    assert {case["name"] for case in runner.cases() if runner.runs_case("provider-installed", case)} == provider
    assert not any(runner.runs_case("provider-installed", case) for case in runner.cases() if runner.case_arm(case) == "generic")


def _eval_market(output: Path) -> None:
    catalog = output / "market/.agents/plugins/marketplace.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text(json.dumps({"name": "vibe-eval", "plugins": []}))


@pytest.mark.parametrize("bound", [True, False])
def test_the_provider_installed_arm_binds_through_the_real_check_before_the_model_starts(
    tmp_path: Path, monkeypatch, bound: bool
) -> None:
    import urllib.request
    case = next(c for c in runner.cases() if c["name"] == "executive-done-asks-two-way")
    _eval_market(tmp_path)
    codex_home = tmp_path / "codex-home"
    env = {"CODEX_HOME": str(codex_home), "HOME": str(codex_home / "home")}
    calls: list[tuple[list[str], Path, dict[str, str], str | None]] = []

    def fake_command(args, cwd, env, budget, seconds, output):
        base = args[args.index("--latest-base") + 1] if "--latest-base" in args else None
        catalog = None
        if base:
            with urllib.request.urlopen(f"{base}/.agents/plugins/marketplace.json", timeout=5) as response:
                catalog = json.loads(response.read())["name"]
            output.write_text(json.dumps({"provider": {"state": "bound" if bound else "bound-disconnected", "reason": "not answered"}}))
        else:
            Path(args[args.index("-o") + 1]).write_text("REPLY: Do you want me to open a pull request so you can take it through review and merge, or pass it to someone to finish?\nROUTE: ask-two-way")
            output.write_text(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10}}))
        calls.append((args, cwd, env, catalog))

    monkeypatch.setattr(runner, "command", fake_command)
    monkeypatch.setattr(runner, "trace_for", lambda *args: [{"name": "exec_command", "arguments": "cat /cache/vibe/1.0.43/skills/vibe/SKILL.md"}])
    result = runner.run_case(case, tmp_path, env, runner.Budget(60), "subject", "cheap", deterministic_only=True,
                             codex_binary="/bin/codex-fixture", arm="provider-installed")
    check_args, check_cwd, check_env, catalog = calls[0]
    assert check_args[0] == "node" and check_args[1].endswith("/market/plugins/vibe/skills/vibe/scripts/plugin-version.mjs")
    assert check_args[2:] == ["check", "--runtime", "codex", "--codex", "/bin/codex-fixture", "--closedloop", "connected",
                              "--graph", "connected",
                              "--latest-base", check_args[-1]]
    assert check_cwd == tmp_path / case["name"], "the check runs in the folder the model works in"
    assert check_env == env, "under the HOME and CODEX_HOME the model's shell sees"
    assert catalog == "vibe-eval", "the release catalog comes from the eval marketplace, not GitHub"
    assert json.loads((tmp_path / "provider-checks" / f"{case['name']}.json").read_text())["provider"]["state"] == ("bound" if bound else "bound-disconnected")
    if bound:
        assert result["passed"], result
        assert calls[1][0][:2] == ["/bin/codex-fixture", "exec"] and calls[1][2] == env
    else:
        assert not result["passed"]
        assert len(calls) == 1, "the model never starts when the check did not bind"
        assert any("did not bind the provider: not answered" in check["reason"] for check in result["checks"])


def test_installed_version_script_is_the_copy_codex_installed(tmp_path: Path) -> None:
    market = tmp_path / "market"
    assert runner.installed_version_script(tmp_path / "codex", market) == market / "plugins/vibe/skills/vibe/scripts/plugin-version.mjs"
    installed = tmp_path / "codex/plugins/cache/vibe-eval/vibe/9.9.9/skills/vibe/scripts/plugin-version.mjs"
    installed.parent.mkdir(parents=True)
    installed.write_text("")
    assert runner.installed_version_script(tmp_path / "codex", market) == installed


def test_the_real_check_binds_the_provider_and_writes_under_the_run_home(tmp_path: Path) -> None:
    import shutil
    plugins = runner.PLUGIN.parent
    output = tmp_path / "run"
    market = output / "market/plugins"
    ignore = shutil.ignore_patterns("node_modules", "evals", "*.test.mjs", "__pycache__", "tools")
    shutil.copytree(plugins / "vibe-closedloop", market / "vibe", ignore=ignore)
    shutil.copytree(plugins / "vibe-core", market / "vibe-core", ignore=ignore)
    (output / "market/.agents/plugins").mkdir(parents=True)
    (output / "market/.agents/plugins/marketplace.json").write_text(json.dumps({"name": "vibe-eval", "plugins": []}))
    codex = tmp_path / "codex"
    codex.write_text("#!/bin/sh\necho '{\"installed\":[]}'\n")
    codex.chmod(0o755)
    codex_home = tmp_path / "codex-home"
    home = codex_home / "home"
    home.mkdir(parents=True)
    work = tmp_path / "case"
    work.mkdir()
    subprocess.run(["git", "init", "--quiet", str(work)], check=True)
    runner.write_opt_in(work)
    env = {**{key: value for key, value in os.environ.items() if key not in ("CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID")},
           "CODEX_HOME": str(codex_home), "HOME": str(home)}
    checked = runner.bind_installed_provider("case", work, output, env, runner.Budget(120), str(codex))
    assert checked["provider"]["state"] == "bound", checked["provider"]
    assert checked["provider"]["name"] == "vibe-closedloop-provider"
    assert checked["provider"].get("bundled") or checked["provider"]["root"].endswith("/market/plugins/vibe/provider"), \
        "the built folder's own provider binds, not a separate plugin"
    assert "recipes" in checked["provider"]["capabilities"], "the arm's opt-in file is the one the provider accepts"
    assert (home / ".codex/vibe/plugin-version").is_dir(), "the binding is recorded under the HOME the model sees"


def test_failed_case_keeps_only_its_resumable_session_and_never_auth(tmp_path: Path) -> None:
    home = tmp_path / "home"
    sessions = home / "sessions/2026/11/16"
    sessions.mkdir(parents=True)
    (home / "auth.json").write_text("secret")
    (sessions / "rollout-thread-failed.jsonl").write_text('{"type":"session_meta"}\n')
    (sessions / "rollout-thread-passed.jsonl").write_text('{"type":"session_meta"}\n')
    output = tmp_path / "output"
    output.mkdir()
    failed = {"case": "failed-case", "passed": False, "session_id": "thread-failed"}
    passed = {"case": "passed-case", "passed": True, "session_id": "thread-passed"}

    runner.retain_failed_sessions(output, home, [failed, passed])

    kept = output / "failed-sessions/failed-case/sessions/2026/11/16/rollout-thread-failed.jsonl"
    assert kept.read_text() == '{"type":"session_meta"}\n'
    assert not (output / "failed-sessions/passed-case").exists()
    assert not list((output / "failed-sessions").rglob("auth.json"))
    assert failed["retained_session"] == {
        "id": "thread-failed",
        "path": "failed-sessions/failed-case/sessions",
        "resume_command": "codex resume thread-failed",
    }


def _graded(name: str, reply: str, tmp_path: Path, trace: list | None = None) -> dict[str, bool]:
    case = next(c for c in runner.cases() if c["name"] == name)
    checks, _ = runner.deterministic(case, reply, tmp_path, trace or [])
    return {check["grader"]: check["passed"] for check in checks}


# Ruled grader changes (operator, ISS-14162, 2026-11-14): Q-14162-5 contractions and await
# wording, the Asana case fix, "Count renders" and the resume pattern fix.
def test_iss14162_card_touch_accepts_contractions(tmp_path: Path) -> None:
    name = "product-manager-card-touch-device-coverage"
    for line in ("Keyboard and Chromium `hasTouch` alone don't count.",
                 "The keyboard and hasTouch evidence doesn’t verify an iPhone tap."):
        assert _graded(name, line, tmp_path)["current-evidence-insufficient"], line
    assert not _graded(name, "The card tap doesn't count on iPhone.", tmp_path)["current-evidence-insufficient"]


def test_iss14162_story_play_accepts_contractions_and_await_wording(tmp_path: Path) -> None:
    name = "product-manager-story-play-real-browser"
    assert _graded(name, "The jsdom test and a successful build don't count as play evidence.", tmp_path)["jsdom-insufficient"]
    assert not _graded(name, "The jsdom test passed and the build is green.", tmp_path)["jsdom-insufficient"]
    for line in ("Fails: the play calls `userEvent.click(button)` without `await`.",
                 "The play check fails: `userEvent.click(button)` has no await."):
        assert _graded(name, line, tmp_path)["unawaited-fails"], line
    assert not _graded(name, "The play check fails on the selected state.", tmp_path)["unawaited-fails"]


def test_iss14162_asana_case_asks_the_recorded_question(tmp_path: Path) -> None:
    name = "executive-asana-lacks-flow-checks-another-app"
    case = next(c for c in runner.cases() if c["name"] == name)
    assert '`session-questions.mjs ask --key github-connect-cancel --question "<that question>" --worktree "<wt>"` returned `{"ask":true}`' in case["prompt"]
    asks = ("REPLY: Asana has no comparable flow. If someone cancels on GitHub's authorization screen, "
            "what should the settings page show when they come back?\nROUTE: ask-question\nNEXT: none")
    assert _graded(name, asks, tmp_path)["asks-about-cancel"]
    for reply in ("REPLY: NONE\nROUTE: wait-for-answer\nNEXT: none",
                  "REPLY: I'm checking how another app handles a canceled connection.\nROUTE: research-further\nNEXT: none"):
        assert not _graded(name, reply, tmp_path)["asks-about-cancel"], reply


def test_iss14162_static_page_counts_a_light_render_in_one_call_or_two(tmp_path: Path) -> None:
    # Only the two render graders: the case's file graders need a scaffolded session.
    case = next(c for c in runner.cases() if c["name"] == "product-manager-static-page-light-and-dark")
    only = tmp_path / "case"
    (only / "graders").mkdir(parents=True)
    for grader in ("renders-both-themes.md", "renders-dark.md"):
        shutil.copy(case["source"] / "graders" / grader, only / "graders" / grader)

    def _graded(_name: str, reply: str, _tmp: Path, trace: list) -> dict[str, bool]:
        checks, _ = runner.deterministic(dict(case, source=only), reply, tmp_path, trace)
        return {check["grader"]: check["passed"] for check in checks}

    name = case["name"]
    page = "python3 tools/screenshot.py src/return-page.html"
    call = lambda command: {"name": "exec", "arguments": command}  # noqa: E731
    light_only = [call(f"{page} light.png")]
    graded = _graded(name, "", tmp_path, light_only)
    assert graded["renders-both-themes"] and not graded["renders-dark"]
    both = {
        "chained light && dark": [call(f"{page} light.png && {page} dark.png --theme dark")],
        "two calls": [call(f"{page} light.png --theme light"), call(f"{page} dark.png --theme=dark")],
        "loop $t": [call(f"for t in light dark; do {page} $t.png --theme $t; done")],
        'loop "$t"': [call(f'for t in light dark; do {page} "$t.png" --theme "$t"; done')],
        "loop ${t}": [call(f"for theme in light dark; do {page} out.png --theme ${{theme}}; done")],
    }
    for label, trace in both.items():
        graded = _graded(name, "", tmp_path, trace)
        assert graded["renders-both-themes"] and graded["renders-dark"], label
    dark_loop = [call(f"for t in dark; do {page} $t.png --theme $t; done")]
    graded = _graded(name, "", tmp_path, dark_loop)
    assert graded["renders-dark"] and not graded["renders-both-themes"]
    for trace in ([call(f"{page} dark.png --theme dark")], [call("sed -n 1,80p tools/screenshot.py")]):
        assert not _graded(name, "", tmp_path, trace)["renders-both-themes"], trace


def test_iss14162_resume_accepts_no_plan_premise_and_rejects_not_publishing(tmp_path: Path) -> None:
    name = "product-manager-resume-existing-ticket-plan"
    premise = ("MISSING: It finds no `livePlan` and no outgoing `PRODUCES` PLN, so the vibe-ticket-worker in plan mode "
               "creates one PLN for ISS-14001 and links it with PRODUCES.")
    assert _graded(name, premise, tmp_path)["missing-publishes-plan"]
    for refusal in ("MISSING: the vibe-ticket-worker in plan mode publishes no PLN for ISS-14001 and adds no PRODUCES links.",
                    "MISSING: no PLN is published; the vibe-ticket-worker in plan mode leaves ISS-14001 without PRODUCES links."):
        assert not _graded(name, refusal, tmp_path)["missing-publishes-plan"], refusal


# Ruled grader changes (operator, ISS-14162, 2026-11-15, Q-14162-6 (a) to (e)): run.py's own
# regex flags accept the correct reply's format or wording.
def test_iss14162_q6_lockfile_graders_accept_correct_wording(tmp_path: Path) -> None:
    name = "product-manager-owned-lockfile-recovery"
    reply = (
        "A_PROOF: Three things establish that the check's install owns the change.\n"
        "- The session's own snapshot showed the file clean right before the check.\n"
        "- The check's owned command receipt shows the install wrote the lockfile.\n"
        "A_NEXT: Rerun the install on the committed file to confirm it reproduces the change.\n"
        "B_NEXT: Leave `pnpm-lock.yaml` exactly as it is, restore nothing, and ask the person about it.\n"
        "C_NEXT: Keep both `package.json` and the updated `pnpm-lock.yaml`, restore nothing, and include both,"
        " because the lockfile change comes from the manifest edit."
    )
    graded = _graded(name, reply, tmp_path)
    for grader in ("owned-change-proof", "no-permission-for-own-change", "preserves-person-edit",
                   "no-restore-intended-lockfile"):
        assert graded[grader], grader
    graded = _graded(name, "A_REPLY: Please confirm I can restore it.\nC_NEXT: Restore `pnpm-lock.yaml`.", tmp_path)
    assert not graded["no-permission-for-own-change"] and not graded["no-restore-intended-lockfile"]


def test_iss14162_q6_story_missing_tests_handover_and_defaults(tmp_path: Path) -> None:
    story = "product-manager-story-play-real-browser"
    assert _graded(story, "Fails, and neither the jsdom story test nor the build counts as play evidence.",
                   tmp_path)["jsdom-insufficient"]
    assert _graded(story, "The only evidence is a jsdom test and a build; neither of those is play evidence.",
                   tmp_path)["jsdom-insufficient"]
    missing = "product-manager-missing-tests-host-adapters"
    graded = _graded(missing, "Missing tests:\n- Desktop host-adapter test for `PRD-42 AC-3`, in the `desktop-e2e` lane.\n"
                     "The writer's `Missing tests: None` doesn't hold.", tmp_path)
    assert graded["owning-lane"] and graded["desktop-entry"] and graded["not-none"]
    assert not _graded(missing, "Missing tests: None", tmp_path)["not-none"]
    handover = "product-manager-real-engineering-blocker-handover"
    assert _graded(handover, "REPLY: The work is saved and pushed. Who should I pass it to? A name or email is fine.",
                   tmp_path)["offers-pushed-work"]
    defaults = "product-manager-fleet-defaults-not-asked"
    assert _graded(defaults, "RECORD: I open the resume log:\n- `config.env` was missing, so I wrote the defaults.",
                   tmp_path)["defaults-written"]
    assert not _graded(defaults, "RECORD: I open the resume log.\nREPLY: I wrote config.env.", tmp_path)["defaults-written"]



# Ruled grader changes (operator, ISS-14162, 2026-11-15, Q-14162-10 (D) under Q-14162-6): run.py's
# own regex flags read plural adapters and a shared test that doesn't count, and hand as a verb.
def test_iss14162_q10_both_host_rule_and_hand_verb(tmp_path: Path) -> None:
    missing = "product-manager-missing-tests-host-adapters"
    for line in ("`None` needs executed coverage through both the real web and real Desktop host adapters.",
                 ("`None` needs both the real web and Desktop host adapters, and a shared unit test doesn't count "
                  "as Desktop coverage.")):
        assert _graded(missing, line, tmp_path)["both-host-rule"], line
    assert not _graded(missing, "Desktop doesn't need adapter coverage because the web adapter test passed.",
                       tmp_path)["both-host-rule"]
    handover = "product-manager-real-engineering-blocker-handover"
    assert _graded(handover, "NEXT: Hand the saved, pushed work to a next owner now.", tmp_path)["uses-handover"]
    assert not _graded(handover, "NEXT: Handle the saved, pushed work later.", tmp_path)["uses-handover"]

_CARD_HEIGHT_SCRIPT = r"""
import importlib.util, json, sys
from pathlib import Path
from PIL import Image, ImageFont

session, variants = Path(sys.argv[1]), json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("screenshot", session / "tools" / "screenshot.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
tool.font = lambda size, weight: ImageFont.load_default(size)
css, png = session / "src" / "signed-in-page.css", session / "card.png"
heights = {}
for label, text in variants.items():
    css.write_text(text)
    tool.render(session / "src" / "signed-in-page.html", png, 640, None)
    image = Image.open(png).convert("RGB")
    surface = (255, 255, 255)
    column = next(x for x in range(image.width) if image.getpixel((x, 200)) == surface) + 14
    heights[label] = sum(1 for y in range(image.height) if image.getpixel((column, y)) == surface)
print(json.dumps(heights))
"""


def test_iss14162_heading_size_and_weight_keep_the_stand_in_card_height(tmp_path: Path) -> None:
    """Ruled fixture change: a heading's size or weight never changes the rendered card's height."""
    case = eval_case("pm-two-screenshot-page")
    subprocess.run(["bash", str(case["source"] / "scaffold.sh")], cwd=tmp_path, check=True)
    session = tmp_path / "session"
    css = (session / "src" / "signed-in-page.css").read_text()
    title = "  font-size: var(--text-md);\n  font-weight: var(--weight-regular);\n"
    assert css.count(title) == 1
    variants = {
        "drafted": css,
        "xl bold": css.replace(title, "  font-size: var(--text-xl);\n  font-weight: var(--weight-bold);\n"),
        "lg medium": css.replace(title, "  font-size: var(--text-lg);\n  font-weight: var(--weight-medium);\n"),
        "tap target": css.replace(".signed-in-button {\n", ".signed-in-button {\n  min-height: var(--tap-target);\n"),
    }
    # The fixture renderer needs Pillow, which the test environment does not carry.
    rendered = subprocess.run(
        ["uv", "run", "--no-project", "--with", "Pillow==12.3.0", "python", "-c", _CARD_HEIGHT_SCRIPT,
         str(session), json.dumps(variants)],
        check=True, capture_output=True, text=True, timeout=600,
    )
    heights = json.loads(rendered.stdout)
    assert heights["xl bold"] == heights["lg medium"] == heights["drafted"], heights
    assert heights["tap target"] > heights["drafted"], heights
