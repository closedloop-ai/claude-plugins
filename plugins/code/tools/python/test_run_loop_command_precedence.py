"""Tests for resolve_closedloop_command() in run-loop.sh.

Precedence rule (highest first):
  1. Pre-set CLOSEDLOOP_COMMAND from the parent process — used by
     closedloop-electron to propagate the websocket request command
     (PLAN, EXECUTE, …) to the harness.
  2. PROMPT_NAME from the --prompt CLI flag.
  3. Literal "interactive" fallback.
"""

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_LOOP = REPO_ROOT / "plugins" / "code" / "scripts" / "run-loop.sh"


def resolve(preset: str, prompt_name: str) -> str:
    """Source run-loop.sh and call the helper with the given args.

    `set --` clears the calling shell's positional args before sourcing so
    run-loop.sh's top-level CLI parser doesn't try to interpret our test
    values as flags. The helper's args are passed explicitly via $PRESET /
    $PROMPT_NAME_VAL env vars to avoid shell-quoting fragility.
    """
    result = subprocess.run(
        [
            "bash",
            "-c",
            f'set --; source "{RUN_LOOP}"; resolve_closedloop_command "$PRESET" "$PROMPT_NAME_VAL"',
        ],
        text=True,
        capture_output=True,
        check=True,
        env={
            "PATH": __import__("os").environ.get("PATH", ""),
            "PRESET": preset,
            "PROMPT_NAME_VAL": prompt_name,
        },
    )
    return result.stdout.strip()


def test_preset_wins_over_prompt_name() -> None:
    """A pre-set CLOSEDLOOP_COMMAND wins over --prompt — the desktop's
    websocket-derived command must override prompt-file selection."""
    assert resolve("PLAN", "code") == "PLAN"


def test_preset_wins_over_empty_prompt_name() -> None:
    """A pre-set CLOSEDLOOP_COMMAND is honored when no --prompt was passed."""
    assert resolve("EXECUTE", "") == "EXECUTE"


def test_prompt_name_used_when_preset_empty() -> None:
    """When CLOSEDLOOP_COMMAND is unset/empty, --prompt fills it in."""
    assert resolve("", "code") == "code"


def test_interactive_fallback_when_both_empty() -> None:
    """Both empty → fall back to the literal "interactive" — preserves the
    original behavior for bare `/code:code` invocations with no --prompt."""
    assert resolve("", "") == "interactive"


def test_preset_with_dash_passes_through() -> None:
    """Command names from the websocket may contain dashes (e.g. evaluate-plan).
    The helper must not reinterpret them."""
    assert resolve("evaluate-plan", "") == "evaluate-plan"


# ---------------------------------------------------------------------------
# State-file persistence — the resolved command (not the raw PROMPT_NAME) must
# land in state.json so that a resume without CLOSEDLOOP_COMMAND in env still
# recovers the original attribution from disk. Codex review round 1 finding.
# ---------------------------------------------------------------------------


def _invoke_create_state_file(
    tmp_path: Path,
    *,
    closedloop_command: str,
    prompt_name: str,
) -> str:
    """Run create_state_file() against a tmp workdir, return state-file text.

    run-loop.sh's top-level resets `WORKDIR`, `STATE_FILE`, and
    `CLOSEDLOOP_STATE_DIR` on source, so the test must SET them after
    sourcing rather than via subprocess env.
    """
    import os

    state_file = tmp_path / "state.md"
    workdir = tmp_path / "workdir"
    workdir.mkdir()

    script = (
        f'set --;'
        f'source "{RUN_LOOP}";'
        f'STATE_FILE="{state_file}";'
        f'WORKDIR="{workdir}";'
        f'CLOSEDLOOP_STATE_DIR="{tmp_path}/state-dir";'
        f'MAX_ITERATIONS=5;'
        f'COMPLETION_PROMISE=COMPLETE;'
        f'PRD_FILE="";'
        f'RUN_ID=test-run-id;'
        f'START_SHA=abc123;'
        f'SELF_LEARNING=false;'
        f'PROMPT_NAME="{prompt_name}";'
        f'ADD_DIRS=();'
        f'create_state_file'
    )

    subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=True,
        env={
            "PATH": os.environ.get("PATH", ""),
            "CLOSEDLOOP_COMMAND": closedloop_command,
        },
    )
    return state_file.read_text()


def test_state_file_persists_resolved_command_from_env(tmp_path: Path) -> None:
    """When CLOSEDLOOP_COMMAND is set but --prompt was not passed (the
    closedloop-electron desktop's typical spawn shape), state.json must carry
    `command: "PLAN"`, not `command: ""`. Otherwise a resume reads back ""
    and falls through to "interactive" — violating PRD-254 AC-001 across
    resumes (Codex round-1 finding)."""
    text = _invoke_create_state_file(
        tmp_path, closedloop_command="PLAN", prompt_name=""
    )
    assert 'command: "PLAN"' in text, (
        f"state.json must persist resolved 'PLAN' from CLOSEDLOOP_COMMAND env, "
        f"but file contained:\n{text}"
    )


def test_state_file_persists_resolved_command_from_prompt(tmp_path: Path) -> None:
    """When PROMPT_NAME is set but CLOSEDLOOP_COMMAND is not, --prompt fills
    the persisted command — preserves backward compatibility for legacy
    desktops that pass --prompt instead of setting the env var."""
    text = _invoke_create_state_file(
        tmp_path, closedloop_command="", prompt_name="feature"
    )
    assert 'command: "feature"' in text, (
        f"state.json must persist PROMPT_NAME when CLOSEDLOOP_COMMAND is "
        f"unset, but file contained:\n{text}"
    )


def test_state_file_env_wins_over_prompt(tmp_path: Path) -> None:
    """When both are set, CLOSEDLOOP_COMMAND wins — matches the env-precedence
    rule applied at run-loop.sh's main() export site."""
    text = _invoke_create_state_file(
        tmp_path, closedloop_command="PLAN", prompt_name="feature"
    )
    assert 'command: "PLAN"' in text


def test_state_file_falls_back_to_interactive(tmp_path: Path) -> None:
    """When both are empty, the persisted command is "interactive" — same
    fallback the exported CLOSEDLOOP_COMMAND uses, so resume behavior matches
    fresh-start behavior."""
    text = _invoke_create_state_file(
        tmp_path, closedloop_command="", prompt_name=""
    )
    assert 'command: "interactive"' in text


# ---------------------------------------------------------------------------
# Resume-path attribution — Codex round-2 finding. On resume, the persisted
# command in state.json is authoritative; a stale ambient CLOSEDLOOP_COMMAND
# (e.g., left over from a previous Loop in the same shell) must NOT rewrite
# history.
# ---------------------------------------------------------------------------


def _run_resume_branch(get_field_output: str, ambient_env: str) -> str:
    """Run the resume branch from run-loop.sh's main() in isolation, with
    a stubbed get_field() returning the given value and the given ambient
    CLOSEDLOOP_COMMAND in env. Return the resolved CLOSEDLOOP_COMMAND.
    """
    import os

    # Embed the file path; everything else is literal bash.
    script = (
        "set --\n"
        f'source "{RUN_LOOP}"\n'
        f'get_field() {{ echo "{get_field_output}"; }}\n'
        'PROMPT_NAME=""\n'
        # Resume branch (excerpted from main):
        'if [[ -z "$PROMPT_NAME" ]]; then\n'
        '  PROMPT_NAME=$(get_field "command")\n'
        '  if [[ -n "$PROMPT_NAME" ]]; then\n'
        '    CLOSEDLOOP_COMMAND="$PROMPT_NAME"\n'
        '  fi\n'
        'fi\n'
        # Final export (excerpted from main):
        'CLOSEDLOOP_COMMAND="$(resolve_closedloop_command "${CLOSEDLOOP_COMMAND:-}" "$PROMPT_NAME")"\n'
        'echo "$CLOSEDLOOP_COMMAND"\n'
    )

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=True,
        env={
            "PATH": os.environ.get("PATH", ""),
            "CLOSEDLOOP_COMMAND": ambient_env,
        },
    )
    return result.stdout.strip()


def test_resume_persisted_command_wins_over_stale_env() -> None:
    """Simulates the resume read-back branch: PROMPT_NAME initially empty,
    state.json carries `command: "PLAN"`, and the resume shell has stale
    `CLOSEDLOOP_COMMAND=EXECUTE`. After the read-back logic runs, the
    persisted "PLAN" must win — an ambient env var from a different prior
    Loop must not rewrite history.
    """
    assert _run_resume_branch(get_field_output="PLAN", ambient_env="EXECUTE") == "PLAN"


def test_resume_with_no_persisted_command_falls_through_normally() -> None:
    """If state.json's command field is empty (older state files predating
    persistence), the resume branch must NOT override CLOSEDLOOP_COMMAND.
    The export then resolves via the normal precedence chain (env wins),
    preserving backward compatibility for old state files."""
    assert _run_resume_branch(get_field_output="", ambient_env="EXECUTE") == "EXECUTE"


def test_resume_from_legacy_state_file_missing_command_field(tmp_path: Path) -> None:
    """Codex round-3 finding: older state files predating this PR lack the
    `command:` field entirely. Under `set -euo pipefail` (set at the top of
    run-loop.sh), `get_field`'s internal `grep | sed` pipeline returns
    non-zero on a missing field, which used to ABORT the resume branch
    before the new state-persistence logic could run.

    This test exercises the REAL get_field (no stub) against a state.md
    that has no `command:` line. The script must continue and resolve
    CLOSEDLOOP_COMMAND via the normal chain (ambient env → "interactive"),
    not abort.
    """
    import os

    legacy_state = tmp_path / "state.md"
    legacy_state.write_text(
        "---\n"
        "iteration: 1\n"
        "max_iterations: 5\n"
        "workdir: /tmp/wd\n"
        "run_id: rid\n"
        "start_sha: abc\n"
        "self_learning: false\n"
        "completion_promise: COMPLETE\n"
        "---\n"
        "old prompt without command line\n"
    )

    script = (
        "set --\n"
        f'source "{RUN_LOOP}"\n'
        f'STATE_FILE="{legacy_state}"\n'
        'PROMPT_NAME=""\n'
        # Reproduce the exact resume branch from main(), including the
        # `|| echo ""` safety added in response to this finding.
        'if [[ -z "$PROMPT_NAME" ]]; then\n'
        '  PROMPT_NAME=$(get_field "command" 2>/dev/null || echo "")\n'
        '  if [[ -n "$PROMPT_NAME" ]]; then\n'
        '    CLOSEDLOOP_COMMAND="$PROMPT_NAME"\n'
        '  fi\n'
        'fi\n'
        'CLOSEDLOOP_COMMAND="$(resolve_closedloop_command "${CLOSEDLOOP_COMMAND:-}" "$PROMPT_NAME")"\n'
        'echo "RESULT=$CLOSEDLOOP_COMMAND"\n'
    )

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,  # We assert exit-code separately so failure is visible.
        env={
            "PATH": os.environ.get("PATH", ""),
            "CLOSEDLOOP_COMMAND": "EXECUTE",
        },
    )
    assert result.returncode == 0, (
        f"Resume from legacy state file must not abort the script. "
        f"stdout: {result.stdout!r}, stderr: {result.stderr!r}"
    )
    assert "RESULT=EXECUTE" in result.stdout, (
        f"With no persisted command + ambient CLOSEDLOOP_COMMAND=EXECUTE, "
        f"resolution must fall through to the ambient value. Got: "
        f"{result.stdout!r}"
    )
