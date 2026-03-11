#!/usr/bin/env python3
"""Plugin dispatcher: scan, parse, evaluate gates, and write dispatch queue.

Discovers autonomous workflow plugins from plugin.md files with TOML frontmatter,
evaluates their gate conditions against run history, and produces a dispatch queue
for the orchestrator to consume.
"""

import sys

if sys.version_info < (3, 11):
    print(
        "ERROR: plugin-dispatcher.py requires Python 3.11+ (for tomllib). "
        f"Current version: {sys.version}",
        file=sys.stderr,
    )
    sys.exit(1)

import argparse
import json
import re
import subprocess
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Type System
# ---------------------------------------------------------------------------


class GateType(Enum):
    COOLDOWN = "cooldown"
    CRON = "cron"
    CONDITION = "condition"
    EVENT = "event"
    MANUAL = "manual"


@dataclass
class Gate:
    type: GateType = GateType.MANUAL
    duration: Optional[str] = None  # cooldown: "30m", "1h", "7d"
    schedule: Optional[str] = None  # cron: interval as duration "4h"
    check: Optional[str] = None  # condition: shell command
    on: Optional[str] = None  # event: trigger name e.g. "session-start"


@dataclass
class Tracking:
    labels: list[str] = field(default_factory=list)
    digest: bool = False


@dataclass
class Execution:
    timeout: Optional[str] = None
    notify_on_failure: bool = False
    severity: str = "low"


@dataclass
class Plugin:
    name: str
    description: str = ""
    version: int = 1
    gate: Gate = field(default_factory=Gate)
    tracking: Tracking = field(default_factory=Tracking)
    execution: Execution = field(default_factory=Execution)
    instructions: str = ""  # markdown body after TOML frontmatter
    path: str = ""  # filesystem path to plugin.md
    location: str = "bundled"  # "bundled" or "custom"


# ---------------------------------------------------------------------------
# Duration Parsing
# ---------------------------------------------------------------------------

_DURATION_RE = re.compile(r"^(\d+)([smhd])$")
_DURATION_MULTIPLIERS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(duration_str: str) -> timedelta:
    """Parse duration strings like '30m', '1h', '7d', '300s'."""
    match = _DURATION_RE.match(duration_str)
    if not match:
        raise ValueError(f"Invalid duration format: {duration_str}")
    value, unit = int(match.group(1)), match.group(2)
    return timedelta(seconds=value * _DURATION_MULTIPLIERS[unit])


# ---------------------------------------------------------------------------
# TOML Frontmatter Parsing
# ---------------------------------------------------------------------------


def parse_plugin_file(filepath: str) -> tuple[dict, str]:
    """Parse a plugin.md file into (frontmatter_dict, markdown_body).

    File format:
        +++
        name = "my-plugin"
        [gate]
        type = "cooldown"
        duration = "30m"
        +++

        # Plugin Title
        Instructions here...

    Returns:
        (toml_dict, markdown_body)

    Raises:
        ValueError if +++ delimiters are missing or TOML is malformed.
    """
    content = Path(filepath).read_text()

    first = content.find("+++")
    if first == -1:
        raise ValueError(f"No +++ delimiter found in {filepath}")

    second = content.find("+++", first + 3)
    if second == -1:
        raise ValueError(f"No closing +++ delimiter found in {filepath}")

    toml_str = content[first + 3 : second].strip()
    markdown_body = content[second + 3 :].strip()

    frontmatter = tomllib.loads(toml_str)
    return frontmatter, markdown_body


def validate_frontmatter(frontmatter: dict, filepath: str) -> None:
    """Validate TOML frontmatter fields based on gate type."""
    name = frontmatter.get("name", "")
    if not name:
        raise ValueError(f"Plugin at {filepath}: 'name' field is required and non-empty")

    gate = frontmatter.get("gate", {})
    gate_type = gate.get("type")

    if gate_type == "cooldown" and "duration" not in gate:
        raise ValueError(f"Plugin '{name}': cooldown gate requires 'duration' field")
    if gate_type == "cron" and "schedule" not in gate:
        raise ValueError(f"Plugin '{name}': cron gate requires 'schedule' field")
    if gate_type == "condition" and "check" not in gate:
        raise ValueError(f"Plugin '{name}': condition gate requires 'check' field")
    if gate_type == "event" and "on" not in gate:
        raise ValueError(f"Plugin '{name}': event gate requires 'on' field")


def _parse_gate(raw: dict) -> Gate:
    gate_type_str = raw.get("type", "manual")
    try:
        gate_type = GateType(gate_type_str)
    except ValueError:
        gate_type = GateType.MANUAL
    return Gate(
        type=gate_type,
        duration=raw.get("duration"),
        schedule=raw.get("schedule"),
        check=raw.get("check"),
        on=raw.get("on"),
    )


def _parse_tracking(raw: dict) -> Tracking:
    return Tracking(
        labels=raw.get("labels", []),
        digest=raw.get("digest", False),
    )


def _parse_execution(raw: dict) -> Execution:
    return Execution(
        timeout=raw.get("timeout"),
        notify_on_failure=raw.get("notify_on_failure", False),
        severity=raw.get("severity", "low"),
    )


# ---------------------------------------------------------------------------
# Plugin Scanner
# ---------------------------------------------------------------------------


def discover_plugins(scan_dirs: list[str]) -> list[Plugin]:
    """Scan directories for plugin.md files. Later dirs override earlier by name."""
    plugins: dict[str, Plugin] = {}

    for scan_dir in scan_dirs:
        dir_path = Path(scan_dir)
        if not dir_path.is_dir():
            continue

        for entry in sorted(dir_path.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue

            plugin_file = entry / "plugin.md"
            if not plugin_file.exists():
                continue

            try:
                frontmatter, body = parse_plugin_file(str(plugin_file))
                validate_frontmatter(frontmatter, str(plugin_file))

                name = frontmatter["name"]

                if name in plugins:
                    print(
                        f"Warning: plugin '{name}' from {plugin_file} "
                        f"overrides version at {plugins[name].path}",
                        file=sys.stderr,
                    )

                plugins[name] = Plugin(
                    name=name,
                    description=frontmatter.get("description", ""),
                    version=frontmatter.get("version", 1),
                    gate=_parse_gate(frontmatter.get("gate", {})),
                    tracking=_parse_tracking(frontmatter.get("tracking", {})),
                    execution=_parse_execution(frontmatter.get("execution", {})),
                    instructions=body,
                    path=str(plugin_file),
                    location="custom" if "custom" in str(scan_dir) else "bundled",
                )
            except Exception as e:
                print(f"Warning: failed to parse {plugin_file}: {e}", file=sys.stderr)
                continue

    return list(plugins.values())


# ---------------------------------------------------------------------------
# Run History
# ---------------------------------------------------------------------------


def count_runs_since(history_path: str, plugin_name: str, since: datetime) -> int:
    """Count non-skipped runs for a plugin after the given timestamp.

    Reads JSONL, skips malformed lines (corruption recovery).
    """
    count = 0
    path = Path(history_path)
    if not path.exists():
        return 0

    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue  # skip corrupted lines

        if entry.get("plugin") != plugin_name:
            continue
        if entry.get("result") == "skipped":
            continue

        started = datetime.fromisoformat(entry["started_at"])
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if started >= since:
            count += 1

    return count


def get_last_run(history_path: str, plugin_name: str) -> Optional[datetime]:
    """Get the most recent non-skipped run time for a plugin."""
    path = Path(history_path)
    if not path.exists():
        return None

    last: Optional[datetime] = None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        if entry.get("plugin") != plugin_name:
            continue
        if entry.get("result") == "skipped":
            continue

        started = datetime.fromisoformat(entry["started_at"])
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if last is None or started > last:
            last = started

    return last


def record_run(
    history_path: str,
    plugin_name: str,
    result: str,
    started_at: str,
    trigger: str = "auto",
) -> None:
    """Append a run record to the JSONL history file."""
    record = {
        "format_version": 1,
        "plugin": plugin_name,
        "result": result,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
    }

    path = Path(history_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "a") as f:
        f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Gate Evaluation
# ---------------------------------------------------------------------------


def evaluate_gate(plugin: Plugin, history_path: str, trigger: str) -> bool:
    """Evaluate a plugin's gate. Returns True if gate is open (should dispatch)."""
    gate = plugin.gate

    if gate.type == GateType.MANUAL:
        return False

    if gate.type == GateType.COOLDOWN:
        assert gate.duration is not None
        duration = parse_duration(gate.duration)
        since = datetime.now(timezone.utc) - duration
        return count_runs_since(history_path, plugin.name, since) == 0

    if gate.type == GateType.CRON:
        assert gate.schedule is not None
        interval = parse_duration(gate.schedule)
        last_run = get_last_run(history_path, plugin.name)
        if last_run is None:
            return True  # never run, overdue
        return (datetime.now(timezone.utc) - last_run) >= interval

    if gate.type == GateType.CONDITION:
        assert gate.check is not None
        try:
            result = subprocess.run(
                gate.check, shell=True, timeout=5, capture_output=True
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            return False

    if gate.type == GateType.EVENT:
        assert gate.on is not None
        return gate.on == trigger

    return False  # unknown gate type


# ---------------------------------------------------------------------------
# Dispatch Queue
# ---------------------------------------------------------------------------


def write_dispatch_queue(
    plugins: list[Plugin], history_path: str, trigger: str, workdir: str
) -> list[dict]:
    """Evaluate gates and write dispatch queue. Returns the queue entries."""
    queue = []
    for plugin in plugins:
        if evaluate_gate(plugin, history_path, trigger):
            entry: dict = {
                "name": plugin.name,
                "path": plugin.path,
                "instructions": plugin.instructions,
            }
            execution: dict = {}
            if plugin.execution.timeout:
                execution["timeout"] = plugin.execution.timeout
            execution["notify_on_failure"] = plugin.execution.notify_on_failure
            execution["severity"] = plugin.execution.severity
            entry["execution"] = execution
            queue.append(entry)

    queue_path = Path(workdir) / ".plugins" / "dispatch-queue.json"
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue_path.write_text(json.dumps(queue, indent=2) + "\n")
    return queue


def force_dispatch(
    plugins: list[Plugin], plugin_name: str, workdir: str
) -> list[dict]:
    """Force-dispatch a single plugin by name regardless of gate."""
    matching = [p for p in plugins if p.name == plugin_name]
    if not matching:
        print(f"Error: plugin '{plugin_name}' not found", file=sys.stderr)
        sys.exit(1)

    plugin = matching[0]
    entry: dict = {
        "name": plugin.name,
        "path": plugin.path,
        "instructions": plugin.instructions,
    }
    execution: dict = {}
    if plugin.execution.timeout:
        execution["timeout"] = plugin.execution.timeout
    execution["notify_on_failure"] = plugin.execution.notify_on_failure
    execution["severity"] = plugin.execution.severity
    entry["execution"] = execution
    queue = [entry]

    queue_path = Path(workdir) / ".plugins" / "dispatch-queue.json"
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue_path.write_text(json.dumps(queue, indent=2) + "\n")
    return queue


def list_plugins(plugins: list[Plugin], history_path: str) -> str:
    """Return JSON array of all discovered plugins with their status."""
    result = []
    for plugin in sorted(plugins, key=lambda p: p.name):
        last_run = get_last_run(history_path, plugin.name)
        result.append(
            {
                "name": plugin.name,
                "description": plugin.description,
                "version": plugin.version,
                "gate_type": plugin.gate.type.value,
                "gate_status": "open"
                if evaluate_gate(plugin, history_path, "")
                else "closed",
                "last_run": last_run.isoformat() if last_run else None,
            }
        )
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Plugin dispatcher: scan, evaluate gates, write dispatch queue."
    )
    parser.add_argument(
        "--trigger",
        default="",
        help="Event trigger name (e.g. session-start, session-end, manual)",
    )
    parser.add_argument("--workdir", required=True, help="Working directory path")
    parser.add_argument(
        "--plugin-root", required=True, help="Plugin root directory path"
    )
    parser.add_argument(
        "--plugin", default=None, help="Force-dispatch a single plugin by name"
    )
    parser.add_argument(
        "--list", action="store_true", help="List all plugins with status"
    )

    args = parser.parse_args()

    # Build scan directories
    bundled_dir = str(Path(args.plugin_root) / "plugins")
    custom_dir = str(Path(args.workdir) / ".plugins" / "custom")
    scan_dirs = [bundled_dir, custom_dir]

    plugins = discover_plugins(scan_dirs)
    history_path = str(Path(args.workdir) / ".plugins" / "run-history.jsonl")

    if args.list:
        print(list_plugins(plugins, history_path))
        return

    if args.plugin:
        queue = force_dispatch(plugins, args.plugin, args.workdir)
        if queue:
            print(f"Force-dispatched plugin: {queue[0]['name']}")
        return

    queue = write_dispatch_queue(plugins, history_path, args.trigger, args.workdir)
    if queue:
        names = ", ".join(e["name"] for e in queue)
        print(f"Dispatched {len(queue)} plugin(s): {names}")
    else:
        print("No plugins ready to dispatch.")


if __name__ == "__main__":
    main()
