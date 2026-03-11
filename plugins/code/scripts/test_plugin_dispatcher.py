"""Tests for plugin-dispatcher.py."""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import importlib

import pytest

# Ensure the script directory is importable
sys.path.insert(0, str(Path(__file__).parent))

# Import the hyphenated module name
_mod = importlib.import_module("plugin-dispatcher")

Gate = _mod.Gate
GateType = _mod.GateType
Plugin = _mod.Plugin
count_runs_since = _mod.count_runs_since
discover_plugins = _mod.discover_plugins
evaluate_gate = _mod.evaluate_gate
force_dispatch = _mod.force_dispatch
get_last_run = _mod.get_last_run
list_plugins = _mod.list_plugins
parse_duration = _mod.parse_duration
parse_plugin_file = _mod.parse_plugin_file
validate_frontmatter = _mod.validate_frontmatter
write_dispatch_queue = _mod.write_dispatch_queue
record_run = _mod.record_run


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


@pytest.fixture
def sample_plugin_content():
    return """\
+++
name = "test-plugin"
description = "A test plugin"
version = 1

[gate]
type = "cooldown"
duration = "30m"

[tracking]
labels = ["plugin:test", "category:test"]
digest = true

[execution]
timeout = "5m"
notify_on_failure = false
severity = "low"
+++

# Test Plugin

You are a test plugin. Do test things.
"""


@pytest.fixture
def minimal_plugin_content():
    return """\
+++
name = "minimal"
+++

# Minimal Plugin

Do nothing.
"""


def _write_plugin(base_dir: Path, name: str, content: str) -> Path:
    plugin_dir = base_dir / name
    plugin_dir.mkdir(parents=True, exist_ok=True)
    plugin_file = plugin_dir / "plugin.md"
    plugin_file.write_text(content)
    return plugin_file


def _write_history(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# TOML Frontmatter Parsing
# ---------------------------------------------------------------------------


class TestParseTomlFrontmatter:
    def test_valid(self, tmp_dir, sample_plugin_content):
        plugin_file = _write_plugin(tmp_dir, "test", sample_plugin_content)
        frontmatter, body = parse_plugin_file(str(plugin_file))
        assert frontmatter["name"] == "test-plugin"
        assert frontmatter["description"] == "A test plugin"
        assert frontmatter["gate"]["type"] == "cooldown"
        assert frontmatter["gate"]["duration"] == "30m"
        assert "# Test Plugin" in body

    def test_minimal(self, tmp_dir, minimal_plugin_content):
        plugin_file = _write_plugin(tmp_dir, "minimal", minimal_plugin_content)
        frontmatter, body = parse_plugin_file(str(plugin_file))
        assert frontmatter["name"] == "minimal"
        assert "gate" not in frontmatter
        assert "# Minimal Plugin" in body

    def test_missing_name(self, tmp_dir):
        content = """\
+++
description = "no name"
+++

Body here.
"""
        plugin_file = _write_plugin(tmp_dir, "noname", content)
        frontmatter, _ = parse_plugin_file(str(plugin_file))
        with pytest.raises(ValueError, match="'name' field is required"):
            validate_frontmatter(frontmatter, str(plugin_file))

    def test_no_delimiters(self, tmp_dir):
        content = "# Just markdown\n\nNo TOML here."
        plugin_file = _write_plugin(tmp_dir, "nodelimt", content)
        with pytest.raises(ValueError, match="No .* delimiter"):
            parse_plugin_file(str(plugin_file))


# ---------------------------------------------------------------------------
# TOML Validation
# ---------------------------------------------------------------------------


class TestTomlValidation:
    def test_cooldown_requires_duration(self, tmp_dir):
        content = """\
+++
name = "bad-cooldown"
[gate]
type = "cooldown"
+++
Body.
"""
        plugin_file = _write_plugin(tmp_dir, "bad", content)
        frontmatter, _ = parse_plugin_file(str(plugin_file))
        with pytest.raises(ValueError, match="cooldown gate requires 'duration'"):
            validate_frontmatter(frontmatter, str(plugin_file))

    def test_cron_requires_schedule(self, tmp_dir):
        content = """\
+++
name = "bad-cron"
[gate]
type = "cron"
+++
Body.
"""
        plugin_file = _write_plugin(tmp_dir, "bad", content)
        frontmatter, _ = parse_plugin_file(str(plugin_file))
        with pytest.raises(ValueError, match="cron gate requires 'schedule'"):
            validate_frontmatter(frontmatter, str(plugin_file))

    def test_condition_requires_check(self, tmp_dir):
        content = """\
+++
name = "bad-condition"
[gate]
type = "condition"
+++
Body.
"""
        plugin_file = _write_plugin(tmp_dir, "bad", content)
        frontmatter, _ = parse_plugin_file(str(plugin_file))
        with pytest.raises(ValueError, match="condition gate requires 'check'"):
            validate_frontmatter(frontmatter, str(plugin_file))

    def test_event_requires_on(self, tmp_dir):
        content = """\
+++
name = "bad-event"
[gate]
type = "event"
+++
Body.
"""
        plugin_file = _write_plugin(tmp_dir, "bad", content)
        frontmatter, _ = parse_plugin_file(str(plugin_file))
        with pytest.raises(ValueError, match="event gate requires 'on'"):
            validate_frontmatter(frontmatter, str(plugin_file))


# ---------------------------------------------------------------------------
# Directory Scanning
# ---------------------------------------------------------------------------


class TestScanDirectory:
    def test_discovers_plugins(self, tmp_dir, sample_plugin_content, minimal_plugin_content):
        _write_plugin(tmp_dir / "bundled", "test-plugin", sample_plugin_content)
        _write_plugin(tmp_dir / "bundled", "minimal-plugin", minimal_plugin_content)
        plugins = discover_plugins([str(tmp_dir / "bundled")])
        assert len(plugins) == 2
        names = {p.name for p in plugins}
        assert names == {"test-plugin", "minimal"}

    def test_empty_directory(self, tmp_dir):
        plugins = discover_plugins([str(tmp_dir / "nonexistent")])
        assert plugins == []

    def test_deduplication(self, tmp_dir, sample_plugin_content):
        _write_plugin(tmp_dir / "bundled", "test-plugin", sample_plugin_content)
        override = """\
+++
name = "test-plugin"
description = "Override version"
+++
Override body.
"""
        _write_plugin(tmp_dir / "custom", "test-plugin", override)
        plugins = discover_plugins([str(tmp_dir / "bundled"), str(tmp_dir / "custom")])
        assert len(plugins) == 1
        assert plugins[0].description == "Override version"

    def test_skips_dot_dirs(self, tmp_dir, sample_plugin_content):
        _write_plugin(tmp_dir / "bundled", ".hidden", sample_plugin_content)
        _write_plugin(tmp_dir / "bundled", "visible", sample_plugin_content)
        plugins = discover_plugins([str(tmp_dir / "bundled")])
        assert len(plugins) == 1


# ---------------------------------------------------------------------------
# Gate Evaluation
# ---------------------------------------------------------------------------


class TestCooldownGate:
    def test_open_no_history(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.COOLDOWN, duration="30m"),
        )
        history = str(tmp_dir / "run-history.jsonl")
        assert evaluate_gate(plugin, history, "") is True

    def test_open_old_runs(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.COOLDOWN, duration="30m"),
        )
        history = tmp_dir / "run-history.jsonl"
        old_time = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        _write_history(
            history,
            [{"plugin": "test", "result": "success", "started_at": old_time}],
        )
        assert evaluate_gate(plugin, str(history), "") is True

    def test_closed_recent_run(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.COOLDOWN, duration="30m"),
        )
        history = tmp_dir / "run-history.jsonl"
        recent_time = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        _write_history(
            history,
            [{"plugin": "test", "result": "success", "started_at": recent_time}],
        )
        assert evaluate_gate(plugin, str(history), "") is False


class TestCronGate:
    def test_open_never_run(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CRON, schedule="4h"),
        )
        history = str(tmp_dir / "run-history.jsonl")
        assert evaluate_gate(plugin, history, "") is True

    def test_open_overdue(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CRON, schedule="1h"),
        )
        history = tmp_dir / "run-history.jsonl"
        old_time = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        _write_history(
            history,
            [{"plugin": "test", "result": "success", "started_at": old_time}],
        )
        assert evaluate_gate(plugin, str(history), "") is True

    def test_closed_within_interval(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CRON, schedule="4h"),
        )
        history = tmp_dir / "run-history.jsonl"
        recent_time = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        _write_history(
            history,
            [{"plugin": "test", "result": "success", "started_at": recent_time}],
        )
        assert evaluate_gate(plugin, str(history), "") is False


class TestEventGate:
    def test_match(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.EVENT, on="session-start"),
        )
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "session-start") is True

    def test_no_match(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.EVENT, on="session-start"),
        )
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "session-end") is False


class TestConditionGate:
    def test_success(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CONDITION, check="true"),
        )
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "") is True

    def test_failure(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CONDITION, check="false"),
        )
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "") is False

    def test_timeout(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.CONDITION, check="sleep 10"),
        )
        with patch.object(_mod.subprocess, "run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="sleep 10", timeout=5)
            assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "") is False


class TestManualGate:
    def test_always_closed(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.MANUAL),
        )
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "") is False

    def test_no_gate_treated_as_manual(self, tmp_dir):
        plugin = Plugin(name="test")  # default gate is MANUAL
        assert evaluate_gate(plugin, str(tmp_dir / "h.jsonl"), "") is False


# ---------------------------------------------------------------------------
# Duration Parsing
# ---------------------------------------------------------------------------


class TestDurationParsing:
    def test_seconds(self):
        assert parse_duration("300s") == timedelta(seconds=300)

    def test_minutes(self):
        assert parse_duration("30m") == timedelta(minutes=30)

    def test_hours(self):
        assert parse_duration("1h") == timedelta(hours=1)

    def test_days(self):
        assert parse_duration("7d") == timedelta(days=7)

    def test_invalid(self):
        with pytest.raises(ValueError, match="Invalid duration"):
            parse_duration("abc")


# ---------------------------------------------------------------------------
# Dispatch Queue
# ---------------------------------------------------------------------------


class TestDispatchQueue:
    def test_write_dispatch_queue(self, tmp_dir):
        plugin = Plugin(
            name="test",
            gate=Gate(type=GateType.COOLDOWN, duration="30m"),
            instructions="Do things.",
            path="/path/to/plugin.md",
        )
        workdir = str(tmp_dir / "workdir")
        history = str(tmp_dir / "run-history.jsonl")
        queue = write_dispatch_queue([plugin], history, "", workdir)
        assert len(queue) == 1
        assert queue[0]["name"] == "test"

        queue_file = Path(workdir) / ".plugins" / "dispatch-queue.json"
        assert queue_file.exists()
        parsed = json.loads(queue_file.read_text())
        assert len(parsed) == 1

    def test_creates_plugins_directory(self, tmp_dir):
        workdir = str(tmp_dir / "new" / "workdir")
        queue = write_dispatch_queue([], str(tmp_dir / "h.jsonl"), "", workdir)
        assert queue == []
        queue_file = Path(workdir) / ".plugins" / "dispatch-queue.json"
        assert queue_file.exists()


# ---------------------------------------------------------------------------
# JSONL Handling
# ---------------------------------------------------------------------------


class TestJsonlHandling:
    def test_skip_malformed_lines(self, tmp_dir):
        history = tmp_dir / "run-history.jsonl"
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(minutes=5)).isoformat()
        history.parent.mkdir(parents=True, exist_ok=True)
        with open(history, "w") as f:
            f.write("this is not json\n")
            f.write(json.dumps({"plugin": "test", "result": "success", "started_at": recent}) + "\n")
            f.write("{broken json\n")

        count = count_runs_since(str(history), "test", now - timedelta(hours=1))
        assert count == 1

    def test_format_version(self, tmp_dir):
        history = str(tmp_dir / "run-history.jsonl")
        record_run(history, "test", "success", datetime.now(timezone.utc).isoformat())
        with open(history) as f:
            entry = json.loads(f.readline())
        assert entry["format_version"] == 1


# ---------------------------------------------------------------------------
# CLI Integration
# ---------------------------------------------------------------------------


class TestCli:
    def test_trigger_session_start(self, tmp_dir, sample_plugin_content):
        _write_plugin(tmp_dir / "plugins", "test-plugin", sample_plugin_content)
        workdir = str(tmp_dir / "workdir")
        script = str(Path(__file__).parent / "plugin-dispatcher.py")
        result = subprocess.run(
            [
                sys.executable,
                script,
                "--trigger",
                "session-start",
                "--workdir",
                workdir,
                "--plugin-root",
                str(tmp_dir),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        queue_file = Path(workdir) / ".plugins" / "dispatch-queue.json"
        assert queue_file.exists()
        queue = json.loads(queue_file.read_text())
        assert len(queue) == 1
        assert queue[0]["name"] == "test-plugin"

    def test_force_dispatch(self, tmp_dir, sample_plugin_content):
        _write_plugin(tmp_dir / "plugins", "test-plugin", sample_plugin_content)
        workdir = str(tmp_dir / "workdir")
        script = str(Path(__file__).parent / "plugin-dispatcher.py")
        result = subprocess.run(
            [
                sys.executable,
                script,
                "--trigger",
                "manual",
                "--workdir",
                workdir,
                "--plugin-root",
                str(tmp_dir),
                "--plugin",
                "test-plugin",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Force-dispatched" in result.stdout

    def test_list_mode(self, tmp_dir, sample_plugin_content):
        _write_plugin(tmp_dir / "plugins", "test-plugin", sample_plugin_content)
        workdir = str(tmp_dir / "workdir")
        script = str(Path(__file__).parent / "plugin-dispatcher.py")
        result = subprocess.run(
            [
                sys.executable,
                script,
                "--list",
                "--workdir",
                workdir,
                "--plugin-root",
                str(tmp_dir),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        plugins = json.loads(result.stdout)
        assert len(plugins) == 1
        assert plugins[0]["name"] == "test-plugin"
        assert plugins[0]["gate_type"] == "cooldown"

    def test_empty_dispatch(self, tmp_dir):
        workdir = str(tmp_dir / "workdir")
        script = str(Path(__file__).parent / "plugin-dispatcher.py")
        result = subprocess.run(
            [
                sys.executable,
                script,
                "--trigger",
                "session-start",
                "--workdir",
                workdir,
                "--plugin-root",
                str(tmp_dir),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        queue_file = Path(workdir) / ".plugins" / "dispatch-queue.json"
        assert queue_file.exists()
        assert json.loads(queue_file.read_text()) == []
