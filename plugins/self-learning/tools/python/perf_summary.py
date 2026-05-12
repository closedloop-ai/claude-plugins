#!/usr/bin/env python3
"""
ClosedLoop Performance Summary

Reads perf.jsonl and prints timing/token tables for iterations, phases,
pipeline steps, sub-steps, and agents. Helps identify bottlenecks in the
ClosedLoop loop.
"""

import argparse
import json
import sys
from collections.abc import Hashable
from datetime import datetime
from pathlib import Path
from typing import Callable, TypeVar

K = TypeVar("K", bound=Hashable)

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)

# Canonical perf.jsonl event schemas:
# iteration:     {event, run_id, iteration, duration_s, status, started_at, claude_exit_code}
# pipeline_step: {event, run_id, iteration, step, step_name, started_at, ended_at, duration_s,
#                 exit_code, skipped, [sub_step], [sub_step_name]}
# agent:         {event, run_id, iteration, agent_id, agent_type, agent_name,
#                 started_at, ended_at, duration_s, command,
#                 [model], [parent_session_id],
#                 [input_tokens], [output_tokens],
#                 [cache_creation_input_tokens], [cache_read_input_tokens],
#                 [total_context_tokens]}
#                 model, parent_session_id, and the token-count fields are marked
#                 optional ([...]) because they fall back to null/0 when the
#                 SubagentStop payload or transcript is missing or unparseable.
# phase:         {event, run_id, iteration, phase, status, start_sha, started_at, command}
#                Phase events carry only started_at; per-phase durations are derived from
#                the gap to the next phase event in the same iteration (or to the iteration's
#                ended_at for the final phase). Use --timeline for a chronological per-instance
#                view; the default summary aggregates by phase name.
# Legacy compatibility:
# pipeline_substep rows are still accepted for historical files and mapped into sub-step summaries.


def _agg_stats(durs: list[float]) -> dict[str, object]:
    """Return count, avg_s, min_s, max_s, total_s for a non-empty list of durations."""
    return {
        "count": len(durs),
        "avg_s": round(sum(durs) / len(durs), 1),
        "min_s": round(min(durs), 1),
        "max_s": round(max(durs), 1),
        "total_s": round(sum(durs), 1),
    }


def _get_float(row: dict[str, object], key: str) -> float:
    try:
        return float(row.get(key, 0))  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return 0.0


def _get_int(row: dict[str, object], key: str) -> int:
    try:
        return int(row.get(key, 0))  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return 0


def _collect_durations(
    events: list[dict[str, object]],
    event_type: str,
    key_fn: Callable[[dict[str, object]], K],
    predicate: Callable[[dict[str, object]], bool] | None = None,
    on_match: Callable[[dict[str, object], K], None] | None = None,
) -> dict[K, list[float]]:
    result: dict[K, list[float]] = {}
    for e in events:
        if e.get("event") != event_type:
            continue
        if predicate and not predicate(e):
            continue
        key = key_fn(e)
        result.setdefault(key, []).append(_get_float(e, "duration_s"))
        if on_match:
            on_match(e, key)
    return result


def _token_totals(rows: list[dict[str, object]]) -> dict[str, object]:
    """Return cumulative token totals plus context high-water mark for rows."""
    totals = {field: sum(_get_int(row, field) for row in rows) for field in TOKEN_FIELDS}
    peak_context = max((_get_int(row, "total_context_tokens") for row in rows), default=0)
    return {
        **totals,
        "total_tokens": sum(totals.values()),
        "peak_context_tokens": peak_context,
    }


def _agent_events(events: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return canonical agent perf events from a mixed perf event list."""
    return [e for e in events if e.get("event") == "agent"]


def _candidate_claude_output_paths(workdir: Path) -> list[Path]:
    """Return adjacent Claude output JSONL files that may contain agent usage.

    Newer Loop runs can archive the parent stream to `claude-output-<run>.jsonl`
    and record the chosen filename in `claude-output.name.txt`; older or active
    runs may still have `claude-output.jsonl`. Search both shapes so historical
    perf files can recover token data when the agent perf rows predate token
    instrumentation.
    """
    paths: list[Path] = []
    sidecar = workdir / "claude-output.name.txt"
    if sidecar.exists():
        try:
            sidecar_name = sidecar.read_text().strip()
        except OSError:
            sidecar_name = ""
        if sidecar_name:
            paths.append(workdir / sidecar_name)

    paths.append(workdir / "claude-output.jsonl")
    paths.extend(sorted(workdir.glob("claude-output-*.jsonl")))

    seen: set[Path] = set()
    unique_paths: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen or not path.exists():
            continue
        seen.add(resolved)
        unique_paths.append(path)
    return unique_paths


def _load_agent_usage_from_claude_outputs(
    paths: list[Path],
) -> dict[str, dict[str, int]]:
    """Load `tool_use_result.usage` totals keyed by Claude agent id."""
    usage_by_agent: dict[str, dict[str, int]] = {}
    for path in paths:
        try:
            lines = path.open()
        except OSError:
            continue
        with lines:
            for line in lines:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                result = row.get("tool_use_result")
                if not isinstance(result, dict):
                    continue
                agent_id = result.get("agentId")
                usage = result.get("usage")
                if not isinstance(agent_id, str) or not isinstance(usage, dict):
                    continue
                usage_by_agent[agent_id] = {
                    field: _get_int(usage, field) for field in TOKEN_FIELDS
                }
    return usage_by_agent


def backfill_agent_tokens_from_claude_output(
    events: list[dict[str, object]],
    workdir: Path,
) -> int:
    """Hydrate legacy agent perf rows from adjacent Claude output logs.

    Returns the number of agent rows updated. Existing non-zero token rows are
    left untouched; missing or zero token rows are filled when a matching
    `tool_use_result.agentId` entry with a usage object exists.
    """
    agents = _agent_events(events)
    if not agents:
        return 0

    usage_by_agent = _load_agent_usage_from_claude_outputs(
        _candidate_claude_output_paths(workdir)
    )
    if not usage_by_agent:
        return 0

    updated = 0
    for agent in agents:
        if sum(_get_int(agent, field) for field in TOKEN_FIELDS) > 0:
            continue
        agent_id = str(agent.get("agent_id", ""))
        usage = usage_by_agent.get(agent_id)
        if not usage:
            continue
        for field in TOKEN_FIELDS:
            agent[field] = usage.get(field, 0)
        agent.setdefault("total_context_tokens", 0)
        agent["token_usage_source"] = "claude-output"
        updated += 1
    return updated


def load_events(
    perf_path: Path,
    run_id: str | None = None,
) -> list[dict[str, object]]:
    """Load events from perf.jsonl, optionally filtered by run_id."""
    events: list[dict[str, object]] = []
    if not perf_path.exists():
        return events

    with open(perf_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if run_id and event.get("run_id") != run_id:
                continue
            events.append(event)

    return events


def summarize_iterations(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Summarize iteration events.

    Returns a list of per-iteration dicts plus an aggregate summary dict.
    """
    iters = [e for e in events if e.get("event") == "iteration"]
    if not iters:
        return []

    rows: list[dict[str, object]] = []
    durations: list[float] = []
    for it in sorted(iters, key=lambda x: x.get("iteration", 0)):  # type: ignore[return-value]
        dur = float(it.get("duration_s", 0))  # type: ignore[arg-type]
        durations.append(dur)
        rows.append({
            "iteration": it.get("iteration"),
            "duration_s": dur,
            "status": it.get("status", ""),
            "started_at": it.get("started_at", ""),
            "claude_exit_code": it.get("claude_exit_code", 0),
        })

    if durations:
        rows.append({"iteration": "summary", **_agg_stats(durations)})

    return rows


def summarize_pipeline(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate pipeline_step events by step_name.

    Excludes events that carry a sub_step field; those are aggregated by
    summarize_substeps. This avoids double-counting when run-judges emits
    both outer (no sub_step) and inner (with sub_step) pipeline_step events.
    Returns rows sorted by total time descending.
    """
    skip_counts: dict[str, int] = {}

    def on_pipeline_step(e: dict[str, object], key: str) -> None:
        if e.get("skipped", False):
            skip_counts[key] = skip_counts.get(key, 0) + 1

    by_name = _collect_durations(
        events,
        "pipeline_step",
        lambda e: str(e.get("step_name", "unknown")),
        predicate=lambda e: "sub_step" not in e,
        on_match=on_pipeline_step,
    )
    if not by_name:
        return []

    rows: list[dict[str, object]] = []
    for name, durs in by_name.items():
        rows.append({
            "step_name": name,
            "skip_count": skip_counts.get(name, 0),
            **_agg_stats(durs),
        })

    rows.sort(key=lambda x: x.get("total_s", 0), reverse=True)  # type: ignore[return-value]
    return rows


def summarize_substeps(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate nested sub-steps from pipeline_step events.

    Reads canonical nested metadata from pipeline_step rows that include sub_step.
    Legacy pipeline_substep rows are also accepted for backward compatibility.
    Returns rows sorted by step_name then sub_step.
    """
    by_key: dict[tuple[str, int, str], list[float]] = {}
    for e in events:
        event_name = str(e.get("event", ""))
        if event_name == "pipeline_step":
            if "sub_step" not in e:
                continue
            step_name = str(e.get("step_name", "unknown"))
            sub_step = _get_int(e, "sub_step")
            sub_step_name = str(e.get("sub_step_name", ""))
        elif event_name == "pipeline_substep":
            # Legacy shape support for older perf files.
            step_name = str(e.get("parent_step_name", "unknown"))
            sub_step = _get_int(e, "sub_step")
            sub_step_name = str(e.get("sub_step_name", ""))
        else:
            continue
        by_key.setdefault((step_name, sub_step, sub_step_name), []).append(
            _get_float(e, "duration_s")
        )

    if not by_key:
        return []

    rows: list[dict[str, object]] = []
    for (step_name, sub_step, sub_step_name), durs in by_key.items():
        rows.append({
            "step_name": step_name,
            "sub_step": sub_step,
            "sub_step_name": sub_step_name,
            **_agg_stats(durs),
        })

    rows.sort(key=lambda x: (x.get("step_name", ""), x.get("sub_step", 0)))  # type: ignore[return-value]
    return rows


def summarize_agents(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate agent events by agent_name.

    Returns rows sorted by total time descending, including token totals when
    the agent perf rows carry usage fields. Legacy rows without token fields
    report zero-token usage.
    """
    by_name: dict[str, list[dict[str, object]]] = {}
    for e in _agent_events(events):
        by_name.setdefault(str(e.get("agent_name", "unknown")), []).append(e)

    if not by_name:
        return []

    rows: list[dict[str, object]] = []
    for name, agent_rows in by_name.items():
        durs = [_get_float(row, "duration_s") for row in agent_rows]
        rows.append({
            "agent_name": name,
            **_agg_stats(durs),
            **_token_totals(agent_rows),
        })

    rows.sort(key=lambda x: x.get("total_s", 0), reverse=True)  # type: ignore[return-value]
    return rows


def _parse_iso(ts: str) -> float | None:
    """Parse ISO-8601 timestamp (with optional Z suffix) to a POSIX epoch float."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _phase_iter_ends(
    events: list[dict[str, object]],
) -> dict[tuple[str, int], str]:
    """Build (run_id, iteration) -> ended_at lookup from iteration events."""
    iter_ends: dict[tuple[str, int], str] = {}
    for e in events:
        if e.get("event") != "iteration":
            continue
        key = (str(e.get("run_id", "")), _get_int(e, "iteration"))
        ended_at = str(e.get("ended_at", ""))
        if ended_at:
            iter_ends[key] = ended_at
    return iter_ends


def _group_phase_events(
    events: list[dict[str, object]],
) -> dict[tuple[str, int], list[dict[str, object]]]:
    """Group phase events by (run_id, iteration)."""
    grouped: dict[tuple[str, int], list[dict[str, object]]] = {}
    for e in events:
        if e.get("event") != "phase":
            continue
        key = (str(e.get("run_id", "")), _get_int(e, "iteration"))
        grouped.setdefault(key, []).append(e)
    return grouped


def _phase_windows(
    events: list[dict[str, object]],
    *,
    include_incomplete: bool = False,
) -> list[dict[str, object]]:
    """Return derived phase windows with internal epoch bounds for joins.

    Phase events only carry a start timestamp. The end is the next phase start
    in the same run/iteration, or the matching iteration end for the final
    phase. Incomplete final phases are emitted only when requested by timeline
    output, where their end and duration are intentionally unknown.
    """
    grouped = _group_phase_events(events)
    if not grouped:
        return []

    iter_ends = _phase_iter_ends(events)

    rows: list[dict[str, object]] = []
    for key, phase_events in grouped.items():
        run_id, iteration = key
        sorted_phases = sorted(
            phase_events, key=lambda x: str(x.get("started_at", ""))
        )
        for i, p in enumerate(sorted_phases):
            started_at = str(p.get("started_at", ""))
            start_ts = _parse_iso(started_at)
            if start_ts is None:
                continue
            if i + 1 < len(sorted_phases):
                ended_at = str(sorted_phases[i + 1].get("started_at", ""))
            else:
                ended_at = iter_ends.get(key, "")
            end_ts = _parse_iso(ended_at)
            duration: float | None
            if end_ts is None:
                if not include_incomplete:
                    continue
                duration = None
                ended_at = ""
            else:
                raw = end_ts - start_ts
                if raw < 0:
                    continue
                duration = round(raw, 1)
            rows.append({
                "run_id": run_id,
                "iteration": iteration,
                "command": str(p.get("command", "interactive")),
                "phase": str(p.get("phase", "unknown")),
                "started_at": started_at,
                "ended_at": ended_at,
                "duration_s": duration,
                "_start_ts": start_ts,
                "_end_ts": end_ts,
            })

    rows.sort(key=lambda r: str(r.get("started_at", "")))
    return rows


def _agent_in_phase_window(
    agent: dict[str, object],
    window: dict[str, object],
) -> bool:
    """Return whether an agent should be attributed to a derived phase window."""
    if str(agent.get("run_id", "")) != str(window.get("run_id", "")):
        return False
    if _get_int(agent, "iteration") != _get_int(window, "iteration"):
        return False
    if str(agent.get("command", "interactive")) != str(window.get("command", "")):
        return False

    agent_started = _parse_iso(str(agent.get("started_at", "")))
    start_ts = window.get("_start_ts")
    end_ts = window.get("_end_ts")
    if agent_started is None or not isinstance(start_ts, (int, float)):
        return False
    if agent_started < float(start_ts):
        return False
    if isinstance(end_ts, (int, float)) and agent_started >= float(end_ts):
        return False
    return True


def _agents_for_phase_window(
    agent_rows: list[dict[str, object]],
    window: dict[str, object],
) -> list[dict[str, object]]:
    """Return agent rows whose start time falls inside the phase window."""
    return [agent for agent in agent_rows if _agent_in_phase_window(agent, window)]


def summarize_phases(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate phase events by phase name.

    Phase events carry only `started_at`. Duration is derived from the gap to
    the next phase event in the same (run_id, iteration), or to the iteration's
    ended_at for the final phase. Token totals are attributed from agent events
    whose start time falls inside each completed phase window. Returns rows
    sorted by total time descending.
    """
    windows = _phase_windows(events)
    if not windows:
        return []

    by_phase: dict[str, list[float]] = {}
    phase_agents: dict[str, list[dict[str, object]]] = {}
    agents = _agent_events(events)
    for window in windows:
        phase_name = str(window.get("phase", "unknown"))
        by_phase.setdefault(phase_name, []).append(_get_float(window, "duration_s"))
        phase_agents.setdefault(phase_name, []).extend(
            _agents_for_phase_window(agents, window)
        )

    rows: list[dict[str, object]] = []
    for name, durs in by_phase.items():
        rows.append({
            "phase": name,
            **_agg_stats(durs),
            **_token_totals(phase_agents.get(name, [])),
        })

    rows.sort(key=lambda x: x.get("total_s", 0), reverse=True)  # type: ignore[return-value]
    return rows


def summarize_phase_agents(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate agent token and duration usage by derived phase and agent.

    Agent events are joined to completed phase windows by run_id, iteration,
    command, and agent start timestamp. If an agent spans a phase boundary, its
    whole token total is attributed to the phase where it started because
    current perf rows only contain one aggregate token record per agent.
    """
    windows = _phase_windows(events)
    agents = _agent_events(events)
    if not windows or not agents:
        return []

    by_key: dict[tuple[str, str], list[dict[str, object]]] = {}
    for window in windows:
        phase_name = str(window.get("phase", "unknown"))
        for agent in _agents_for_phase_window(agents, window):
            agent_name = str(agent.get("agent_name", "unknown"))
            by_key.setdefault((phase_name, agent_name), []).append(agent)

    rows: list[dict[str, object]] = []
    for (phase_name, agent_name), agent_rows in by_key.items():
        durs = [_get_float(row, "duration_s") for row in agent_rows]
        rows.append({
            "phase": phase_name,
            "agent_name": agent_name,
            **_agg_stats(durs),
            **_token_totals(agent_rows),
        })

    rows.sort(
        key=lambda x: (x.get("total_tokens", 0), x.get("total_s", 0)),
        reverse=True,
    )
    return rows


def phase_timeline(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Return chronological per-instance phase rows.

    Unlike summarize_phases (aggregate stats), this emits one row per phase
    instance with run_id, iteration, started_at, ended_at, and duration_s.
    Incomplete final phases (no following phase event AND no iteration ended_at)
    are still emitted with ended_at="" and duration_s=None so in-progress runs
    are visible. Negative durations from clock skew are filtered. Rows are
    sorted by started_at ascending.
    """
    windows = _phase_windows(events, include_incomplete=True)
    if not windows:
        return []

    agents = _agent_events(events)
    rows: list[dict[str, object]] = []
    for window in windows:
        agent_rows = _agents_for_phase_window(agents, window)
        rows.append({
            "run_id": window.get("run_id", ""),
            "iteration": window.get("iteration", 0),
            "phase": window.get("phase", "unknown"),
            "started_at": window.get("started_at", ""),
            "ended_at": window.get("ended_at", ""),
            "duration_s": window.get("duration_s"),
            **_token_totals(agent_rows),
        })

    rows.sort(key=lambda r: str(r.get("started_at", "")))
    return rows


_SECONDS_PER_MINUTE = 60
_MINUTES_PER_HOUR = 60


def _fmt_duration(seconds: float) -> str:
    """Format seconds as human-readable duration."""
    if seconds < _SECONDS_PER_MINUTE:
        return f"{seconds:.0f}s"
    minutes = seconds / _SECONDS_PER_MINUTE
    if minutes < _MINUTES_PER_HOUR:
        return f"{minutes:.1f}m"
    hours = minutes / _MINUTES_PER_HOUR
    return f"{hours:.1f}h"


_STATS_HEADER = f"{'Count':<6} {'Avg':<8} {'Min':<8} {'Max':<8} {'Total':<8}"
_TOKEN_HEADER = (
    f"{'Tokens':>12} {'In':>10} {'Out':>10} {'Cache':>10} {'PeakCtx':>10}"
)


def _format_stats_cols(row: dict[str, object]) -> str:
    return (
        f"{row.get('count', 0)!s:<6} "
        f"{_fmt_duration(_get_float(row, 'avg_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'min_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'max_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'total_s')):<8}"
    )


def _format_token_cols(row: dict[str, object]) -> str:
    cache_tokens = (
        _get_int(row, "cache_creation_input_tokens")
        + _get_int(row, "cache_read_input_tokens")
    )
    return (
        f"{_get_int(row, 'total_tokens'):>12,} "
        f"{_get_int(row, 'input_tokens'):>10,} "
        f"{_get_int(row, 'output_tokens'):>10,} "
        f"{cache_tokens:>10,} "
        f"{_get_int(row, 'peak_context_tokens'):>10,}"
    )


def print_text(
    iterations: list[dict[str, object]],
    pipeline: list[dict[str, object]],
    *,
    substeps: list[dict[str, object]],
    agents: list[dict[str, object]],
    phases: list[dict[str, object]],
    phase_agents: list[dict[str, object]],
) -> None:
    """Print human-readable text tables."""
    if iterations:
        print("=== Iterations ===")
        print(f"{'Iter':<6} {'Duration':<10} {'Status':<15} {'Started':<25}")
        print("-" * 60)
        for row in iterations:
            if row.get("iteration") == "summary":
                print("-" * 60)
                print(
                    f"{'Total':<6} {_fmt_duration(_get_float(row, 'total_s')):<10} "
                    f"avg={_fmt_duration(_get_float(row, 'avg_s'))} "
                    f"min={_fmt_duration(_get_float(row, 'min_s'))} "
                    f"max={_fmt_duration(_get_float(row, 'max_s'))} "
                    f"n={row.get('count', 0)}"
                )
            else:
                print(
                    f"{row.get('iteration', '')!s:<6} "
                    f"{_fmt_duration(_get_float(row, 'duration_s')):<10} "
                    f"{row.get('status', '')!s:<15} "
                    f"{row.get('started_at', '')!s:<25}"
                )
        print()

    if phases:
        print("=== Phases (by total time) ===")
        print(f"{'Phase':<40} {_STATS_HEADER} {_TOKEN_HEADER}")
        print("-" * 135)
        for row in phases:
            print(
                f"{row.get('phase', '')!s:<40} "
                f"{_format_stats_cols(row)} "
                f"{_format_token_cols(row)}"
            )
        print()

    if pipeline:
        print("=== Pipeline Steps (by total time) ===")
        print(f"{'Step':<28} {_STATS_HEADER} {'Skips':<6}")
        print("-" * 74)
        for row in pipeline:
            print(
                f"{row.get('step_name', '')!s:<28} {_format_stats_cols(row)} {row.get('skip_count', 0)!s:<6}"
            )
        print()

    if substeps:
        print("=== Sub-steps (by step) ===")
        print(f"{'Step':<18} {'Sub':<6} {'Sub-step':<24} {_STATS_HEADER}")
        print("-" * 92)
        for row in substeps:
            print(
                f"{row.get('step_name', '')!s:<18} "
                f"{row.get('sub_step', 0)!s:<6} "
                f"{row.get('sub_step_name', '')!s:<24} "
                f"{_format_stats_cols(row)}"
            )
        print()

    if agents:
        print("=== Agents (by total time) ===")
        print(f"{'Agent':<28} {_STATS_HEADER} {_TOKEN_HEADER}")
        print("-" * 123)
        for row in agents:
            print(
                f"{row.get('agent_name', '')!s:<28} "
                f"{_format_stats_cols(row)} "
                f"{_format_token_cols(row)}"
            )
        print()

    if phase_agents:
        print("=== Phase Agents (by total tokens) ===")
        print(f"{'Phase':<36} {'Agent':<28} {_STATS_HEADER} {_TOKEN_HEADER}")
        print("-" * 159)
        for row in phase_agents:
            print(
                f"{row.get('phase', '')!s:<36} "
                f"{row.get('agent_name', '')!s:<28} "
                f"{_format_stats_cols(row)} "
                f"{_format_token_cols(row)}"
            )
        print()

    if (
        not iterations
        and not pipeline
        and not substeps
        and not agents
        and not phases
        and not phase_agents
    ):
        print("No performance data found.")


def print_phase_timeline(rows: list[dict[str, object]]) -> None:
    """Print one row per phase instance, sorted chronologically."""
    if not rows:
        print("No phase events found.")
        return
    print("=== Phase Timeline ===")
    print(
        f"{'Run':<22} {'Iter':<6} {'Phase':<40} {'Started':<22} "
        f"{'Ended':<22} {'Duration':<10} {'Tokens':>12} {'PeakCtx':>10}"
    )
    print("-" * 149)
    for row in rows:
        dur = row.get("duration_s")
        dur_str = _fmt_duration(float(dur)) if isinstance(dur, (int, float)) else "?"
        print(
            f"{row.get('run_id', '')!s:<22} "
            f"{row.get('iteration', '')!s:<6} "
            f"{row.get('phase', '')!s:<40} "
            f"{row.get('started_at', '')!s:<22} "
            f"{row.get('ended_at', '')!s:<22} "
            f"{dur_str:<10} "
            f"{_get_int(row, 'total_tokens'):>12,} "
            f"{_get_int(row, 'peak_context_tokens'):>10,}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize ClosedLoop loop performance from perf.jsonl"
    )
    parser.add_argument(
        "--workdir",
        required=True,
        help="CLOSEDLOOP_WORKDIR containing perf.jsonl",
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Filter to a specific run_id",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)",
    )
    parser.add_argument(
        "--timeline",
        action="store_true",
        help="Show chronological phase timeline (one row per phase instance) "
        "instead of aggregate summary tables",
    )

    args = parser.parse_args()
    workdir = Path(args.workdir).resolve()
    perf_path = workdir / "perf.jsonl"

    if not perf_path.exists():
        print(f"No perf.jsonl found at {perf_path}", file=sys.stderr)
        return 0

    events = load_events(perf_path, run_id=args.run_id)
    if not events:
        print("No events found in perf.jsonl", file=sys.stderr)
        return 0
    backfill_agent_tokens_from_claude_output(events, workdir)

    if args.timeline:
        timeline = phase_timeline(events)
        if args.format == "json":
            print(json.dumps(timeline, indent=2))
        else:
            print_phase_timeline(timeline)
        return 0

    iterations = summarize_iterations(events)
    pipeline = summarize_pipeline(events)
    substeps = summarize_substeps(events)
    agents = summarize_agents(events)
    phases = summarize_phases(events)
    phase_agents = summarize_phase_agents(events)

    if args.format == "json":
        output = {
            "iterations": iterations,
            "phases": phases,
            "pipeline_steps": pipeline,
            "pipeline_substeps": substeps,
            "agents": agents,
            "phase_agents": phase_agents,
        }
        print(json.dumps(output, indent=2))
    else:
        print_text(
            iterations,
            pipeline,
            substeps=substeps,
            agents=agents,
            phases=phases,
            phase_agents=phase_agents,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
