"""Tests for subagent-stop-hook.sh self-learning guard and perf instrumentation."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
import pytest
from conftest import CLOSEDLOOP_STATE_DIR

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / "hooks" / "subagent-stop-hook.sh"


@pytest.fixture()
def session_env(tmp_path: Path) -> tuple[Path, Path, str]:
    """Create temp CWD with session mapping and workdir with config.env.

    Returns (cwd, workdir, session_id).
    """
    session_id = "test-stop-session"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"

    # Create session mapping
    session_dir = cwd / CLOSEDLOOP_STATE_DIR
    session_dir.mkdir(parents=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    # Create workdir structure
    closedloop_dir = workdir / CLOSEDLOOP_STATE_DIR
    closedloop_dir.mkdir(parents=True)

    learnings_dir = workdir / ".learnings"
    learnings_dir.mkdir(parents=True)
    (learnings_dir / "pending").mkdir()

    # Create agent-types dir and write agent-type file
    agent_types_dir = workdir / ".agent-types"
    agent_types_dir.mkdir(parents=True)
    (agent_types_dir / "agent-123").write_text(
        "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
    )

    return cwd, workdir, session_id


def run_stop_hook(
    cwd: str,
    session_id: str,
    agent_id: str = "agent-123",
    self_learning: bool = False,
    config_env_extra: str = "",
    transcript_path: str = "",
    model: str | None = None,
    parent_session_id: str | None = None,
    env_extra: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Invoke subagent-stop-hook.sh with crafted JSON input."""
    # Write config.env
    workdir_file = Path(cwd) / CLOSEDLOOP_STATE_DIR / f"session-{session_id}.workdir"
    workdir = workdir_file.read_text().strip()
    config_path = Path(workdir) / CLOSEDLOOP_STATE_DIR / "config.env"
    sl_value = "true" if self_learning else "false"
    config_path.write_text(
        f"CLOSEDLOOP_SELF_LEARNING={sl_value}\n{config_env_extra}"
    )

    payload_dict: dict = {
        "agent_id": agent_id,
        "cwd": cwd,
        "stop_hook_active": True,
        "session_id": session_id,
        "agent_transcript_path": transcript_path,
    }
    if model is not None:
        payload_dict["model"] = model
    if parent_session_id is not None:
        payload_dict["parent_session_id"] = parent_session_id

    payload = json.dumps(payload_dict)

    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)

    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


class TestSelfLearningOff:
    """Tests that subagent-stop-hook.sh skips learning region when disabled."""

    def test_exits_zero_outputs_empty_json(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Hook exits 0 and outputs {} when CLOSEDLOOP_SELF_LEARNING=false."""
        cwd, _workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0, f"Hook failed: {result.stderr}"
        stdout = result.stdout.strip()
        # Should output {} (empty JSON, no modifications)
        assert stdout == "{}", f"Expected '{{}}' but got: {stdout}"

    def test_no_acknowledgments_log_written(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When disabled, acknowledgments.log should NOT be written."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        ack_log = workdir / ".learnings" / "acknowledgments.log"
        assert not ack_log.exists(), "acknowledgments.log should not exist when self-learning is off"

    def test_no_outcomes_log_written(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When disabled, outcomes.log should NOT be written."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        outcomes_log = workdir / ".learnings" / "outcomes.log"
        assert not outcomes_log.exists(), "outcomes.log should not exist when self-learning is off"

    def test_agent_type_file_cleaned_up(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Agent-type file is cleaned up even when self-learning is off."""
        cwd, workdir, session_id = session_env
        agent_type_file = workdir / ".agent-types" / "agent-123"
        assert agent_type_file.exists(), "Precondition: agent-type file should exist"

        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0

        assert not agent_type_file.exists(), "Agent-type file should be cleaned up"


class TestSelfLearningOn:
    """Tests that subagent-stop-hook.sh enters the learning region when enabled."""

    def test_acknowledgment_enforcement_reachable(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When enabled, the hook writes acknowledgments.log (missing-ack path)."""
        cwd, workdir, session_id = session_env
        result = run_stop_hook(str(cwd), session_id, self_learning=True)
        assert result.returncode == 0

        # With no transcript and no LEARNINGS_ACKNOWLEDGED, the hook should write
        # a missing-acknowledgment entry to acknowledgments.log
        ack_log = workdir / ".learnings" / "acknowledgments.log"
        assert ack_log.exists(), "acknowledgments.log should exist when self-learning is on"
        content = ack_log.read_text()
        assert "false" in content, "Should log false acknowledgment"
        assert "implementation-subagent" in content


def _create_transcript(tmp_path: Path, entries: list[dict]) -> str:
    """Write transcript JSONL entries to a temp file and return the path."""
    transcript_file = tmp_path / "transcript.jsonl"
    lines = [json.dumps(e) for e in entries]
    transcript_file.write_text("\n".join(lines) + "\n")
    return str(transcript_file)


def _read_agent_events(workdir: Path) -> list[dict]:
    """Read perf.jsonl and return only agent events."""
    perf_file = workdir / "perf.jsonl"
    assert perf_file.exists(), "perf.jsonl should be written"
    events = [json.loads(line) for line in perf_file.read_text().strip().splitlines()]
    return [e for e in events if e.get("event") == "agent"]


def _recreate_agent_type_file(workdir: Path, agent_id: str = "agent-123") -> None:
    """Re-create agent-type file (gets cleaned up after each hook run)."""
    agent_types_dir = workdir / ".agent-types"
    agent_types_dir.mkdir(parents=True, exist_ok=True)
    (agent_types_dir / agent_id).write_text(
        "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
    )


class TestPerfV2TokenAggregation:
    """T-3.1: Token aggregation with cache reads under CLOSEDLOOP_PERF_V2=1."""

    def test_token_aggregation_sums_correctly(
        self, session_env: tuple[Path, Path, str], tmp_path: Path
    ) -> None:
        """Verify four token fields sum correctly across transcript entries with cache reads."""
        cwd, workdir, session_id = session_env

        # Create a mock transcript with multiple assistant entries including cache reads.
        # Shape mirrors what Claude Code actually writes to agent_transcript_path:
        # top-level `type: "assistant"` with the API message (incl. role/model/usage)
        # under `.message`. This matches stream_formatter._accumulate_usage which reads
        # event["message"]["usage"]; the bash port's jq filter selects on `.type` for
        # the same reason.
        transcript_entries = [
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet-4-20250514",
                    "usage": {
                        "input_tokens": 1000,
                        "output_tokens": 200,
                        "cache_creation_input_tokens": 500,
                        "cache_read_input_tokens": 0,
                    },
                },
            },
            {
                "type": "user",
                "message": {"role": "user", "content": "some user message"},
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet-4-20250514",
                    "usage": {
                        "input_tokens": 800,
                        "output_tokens": 300,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 500,
                    },
                },
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet-4-20250514",
                    "usage": {
                        "input_tokens": 1200,
                        "output_tokens": 150,
                        "cache_creation_input_tokens": 100,
                        "cache_read_input_tokens": 300,
                    },
                },
            },
        ]
        transcript_path = _create_transcript(tmp_path, transcript_entries)

        _recreate_agent_type_file(workdir)

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            transcript_path=transcript_path,
            model="claude-sonnet-4-20250514",
            parent_session_id="parent-abc-123",
            env_extra={"CLOSEDLOOP_PERF_V2": "1"},
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        agent_events = _read_agent_events(workdir)
        assert len(agent_events) == 1, f"Expected 1 agent event, got {len(agent_events)}"

        evt = agent_events[0]

        # Verify token sums: 1000+800+1200=3000, 200+300+150=650, 500+0+100=600, 0+500+300=800
        assert evt["input_tokens"] == 3000, f"Expected input_tokens=3000, got {evt['input_tokens']}"
        assert evt["output_tokens"] == 650, f"Expected output_tokens=650, got {evt['output_tokens']}"
        assert evt["cache_creation_input_tokens"] == 600, (
            f"Expected cache_creation_input_tokens=600, got {evt['cache_creation_input_tokens']}"
        )
        assert evt["cache_read_input_tokens"] == 800, (
            f"Expected cache_read_input_tokens=800, got {evt['cache_read_input_tokens']}"
        )

        # Verify total_context_tokens is the per-turn high-water mark — the max of any
        # single assistant turn's full token usage (PRD: "useful for spotting context-pressure
        # spikes"). Cumulative sums would be monotonic and equal the final total, providing
        # no peak signal.
        # Entry 1: 1000+200+500+0 = 1700
        # Entry 2:  800+300+0+500 = 1600
        # Entry 3: 1200+150+100+300 = 1750  <- peak
        assert evt["total_context_tokens"] == 1750, (
            f"Expected total_context_tokens=1750 (per-turn HWM), got {evt['total_context_tokens']}"
        )


class TestPerfV2MissingTranscript:
    """T-3.2: Graceful degradation when transcript is missing or malformed under PERF_V2."""

    def test_missing_transcript_emits_zero_tokens(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When agent_transcript_path is missing and PERF_V2=1, emit token fields as 0."""
        cwd, workdir, session_id = session_env

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            transcript_path="",
            env_extra={"CLOSEDLOOP_PERF_V2": "1"},
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        agent_events = _read_agent_events(workdir)
        assert len(agent_events) == 1

        evt = agent_events[0]
        for field in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                      "cache_read_input_tokens", "total_context_tokens"):
            assert evt[field] == 0, f"Expected {field}=0, got {evt[field]}"
        for field in ("duration_s", "started_at", "ended_at"):
            assert field in evt

    def test_malformed_transcript_emits_zero_tokens_and_does_not_abort(
        self, session_env: tuple[Path, Path, str], tmp_path: Path
    ) -> None:
        """When the transcript file exists but isn't valid JSONL (jq fails), the hook
        must still exit 0 and emit an agent event with zero token fields. Regression
        guard for the fail-open contract: a transcript-parser bug must never break the
        SubagentStop hook or the parent Loop."""
        cwd, workdir, session_id = session_env

        # Write garbage that is NOT valid JSONL
        bad_transcript = tmp_path / "transcript.jsonl"
        bad_transcript.write_text("not valid json\n{broken: [\n\x00\x01garbage\n")

        _recreate_agent_type_file(workdir)

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            transcript_path=str(bad_transcript),
            env_extra={"CLOSEDLOOP_PERF_V2": "1"},
        )
        assert result.returncode == 0, (
            f"Hook must exit 0 on malformed transcript, got {result.returncode}. "
            f"stderr: {result.stderr!r}"
        )

        agent_events = _read_agent_events(workdir)
        assert len(agent_events) == 1, "Agent event must still be emitted on malformed transcript"

        evt = agent_events[0]
        for field in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                      "cache_read_input_tokens", "total_context_tokens"):
            assert evt[field] == 0, (
                f"On malformed transcript, expected {field}=0, got {evt[field]}"
            )


class TestPerfV2GateBehavior:
    """T-3.3: CLOSEDLOOP_PERF_V2 gate behavior."""

    def test_perf_v2_unset_emits_baseline_event(
        self, session_env: tuple[Path, Path, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When PERF_V2 is unset, emit FEA-764 baseline event (timing only, no token fields)."""
        cwd, workdir, session_id = session_env
        monkeypatch.delenv("CLOSEDLOOP_PERF_V2", raising=False)

        result = run_stop_hook(str(cwd), session_id, self_learning=False)
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        agent_events = _read_agent_events(workdir)
        assert len(agent_events) == 1

        evt = agent_events[0]
        # Baseline event should have timing fields
        for field in ("duration_s", "started_at", "ended_at", "agent_name"):
            assert field in evt
        # Baseline event should NOT have token/model fields
        for field in ("input_tokens", "output_tokens", "model", "parent_session_id", "command"):
            assert field not in evt, f"Baseline event should not have {field}"


class TestPerfV2ModelAndMetadata:
    """T-3.4: model, parent_session_id, and command field emission under PERF_V2."""

    def test_model_and_parent_session_id_present(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Verify model and parent_session_id are included when PERF_V2=1."""
        cwd, workdir, session_id = session_env

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            model="claude-sonnet-4-20250514",
            parent_session_id="parent-session-xyz",
            env_extra={
                "CLOSEDLOOP_PERF_V2": "1",
                "CLOSEDLOOP_COMMAND": "code",
            },
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        perf_file = workdir / "perf.jsonl"
        events = [json.loads(line) for line in perf_file.read_text().strip().splitlines()]
        agent_events = [e for e in events if e.get("event") == "agent"]
        assert len(agent_events) == 1

        evt = agent_events[0]
        assert evt["model"] == "claude-sonnet-4-20250514"
        assert evt["parent_session_id"] == "parent-session-xyz"
        assert evt["command"] == "code"

    def test_missing_model_emits_null(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When model is missing from hook payload, emit model: null."""
        cwd, workdir, session_id = session_env

        # Re-create agent-type file (cleaned up by previous tests)
        agent_types_dir = workdir / ".agent-types"
        agent_types_dir.mkdir(parents=True, exist_ok=True)
        (agent_types_dir / "agent-123").write_text(
            "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
        )

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            # model not provided -> omitted from payload
            env_extra={"CLOSEDLOOP_PERF_V2": "1"},
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        perf_file = workdir / "perf.jsonl"
        events = [json.loads(line) for line in perf_file.read_text().strip().splitlines()]
        agent_events = [e for e in events if e.get("event") == "agent"]
        assert len(agent_events) == 1

        evt = agent_events[0]
        assert evt["model"] is None, f"Expected model=null, got {evt['model']}"

    def test_missing_parent_session_emits_null(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When parent_session_id is missing from hook payload, emit null."""
        cwd, workdir, session_id = session_env

        # Re-create agent-type file
        agent_types_dir = workdir / ".agent-types"
        agent_types_dir.mkdir(parents=True, exist_ok=True)
        (agent_types_dir / "agent-123").write_text(
            "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
        )

        result = run_stop_hook(
            str(cwd),
            session_id,
            self_learning=False,
            model="claude-sonnet-4-20250514",
            # parent_session_id not provided
            env_extra={"CLOSEDLOOP_PERF_V2": "1"},
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        perf_file = workdir / "perf.jsonl"
        events = [json.loads(line) for line in perf_file.read_text().strip().splitlines()]
        agent_events = [e for e in events if e.get("event") == "agent"]
        assert len(agent_events) == 1

        evt = agent_events[0]
        assert evt["parent_session_id"] is None, (
            f"Expected parent_session_id=null, got {evt['parent_session_id']}"
        )

    def test_missing_command_defaults_to_interactive(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """When CLOSEDLOOP_COMMAND is not set and config.env has no fallback, command
        defaults to "interactive" — matching record_phase.sh and run-loop.sh's
        emit_perf_event helper, so agent rows can be joined with phase/iteration rows
        by command in Datadog."""
        cwd, workdir, session_id = session_env

        # Re-create agent-type file
        agent_types_dir = workdir / ".agent-types"
        agent_types_dir.mkdir(parents=True, exist_ok=True)
        (agent_types_dir / "agent-123").write_text(
            "code:implementation-subagent|implementation-subagent|2026-03-25T00:00:00Z"
        )

        # Explicitly remove CLOSEDLOOP_COMMAND from env
        env = os.environ.copy()
        env.pop("CLOSEDLOOP_COMMAND", None)
        env["CLOSEDLOOP_PERF_V2"] = "1"

        result = subprocess.run(
            ["bash", str(HOOK_PATH)],
            input=json.dumps({
                "agent_id": "agent-123",
                "cwd": str(cwd),
                "stop_hook_active": True,
                "session_id": session_id,
                "agent_transcript_path": "",
            }),
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
        )
        assert result.returncode == 0, f"Hook failed: {result.stderr}"

        perf_file = workdir / "perf.jsonl"
        events = [json.loads(line) for line in perf_file.read_text().strip().splitlines()]
        agent_events = [e for e in events if e.get("event") == "agent"]
        assert len(agent_events) == 1

        evt = agent_events[0]
        assert evt["command"] == "interactive", (
            f"Expected command='interactive', got {evt['command']!r}"
        )
