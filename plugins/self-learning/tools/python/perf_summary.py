#!/usr/bin/env python3
"""
ClosedLoop Performance Summary

Reads perf.jsonl and prints timing tables for iterations, pipeline steps,
and agents. Helps identify bottlenecks in the ClosedLoop loop.
"""

import argparse
import json
import sys
from collections.abc import Hashable
from datetime import datetime
from pathlib import Path
from typing import Callable, TypeVar

K = TypeVar("K", bound=Hashable)

# Canonical perf.jsonl event schemas:
# iteration:     {event, run_id, iteration, duration_s, status, started_at, claude_exit_code}
# pipeline_step: {event, run_id, iteration, step, step_name, started_at, ended_at, duration_s,
#                 exit_code, skipped, [sub_step], [sub_step_name]}
# agent:         {event, run_id, iteration, agent_id, agent_type, agent_name,
#                 started_at, ended_at, duration_s,
#                 [command], [model], [parent_session_id],
#                 [input_tokens], [output_tokens],
#                 [cache_creation_input_tokens], [cache_read_input_tokens],
#                 [total_context_tokens]}
#                 Token/model fields are present when CLOSEDLOOP_PERF_V2=1.
# phase:         {event, run_id, iteration, phase, status, start_sha, started_at}
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

    Returns rows sorted by total time descending.
    """
    by_name = _collect_durations(
        events,
        "agent",
        lambda e: str(e.get("agent_name", "unknown")),
    )
    if not by_name:
        return []

    rows: list[dict[str, object]] = []
    for name, durs in by_name.items():
        rows.append({"agent_name": name, **_agg_stats(durs)})

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


def summarize_phases(
    events: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Aggregate phase events by phase name.

    Phase events carry only `started_at`. Duration is derived from the gap to
    the next phase event in the same (run_id, iteration), or to the iteration's
    ended_at for the final phase. Returns rows sorted by total time descending.
    """
    grouped = _group_phase_events(events)
    if not grouped:
        return []

    iter_ends = _phase_iter_ends(events)

    by_phase: dict[str, list[float]] = {}
    for key, phase_events in grouped.items():
        sorted_phases = sorted(
            phase_events, key=lambda x: str(x.get("started_at", ""))
        )
        for i, p in enumerate(sorted_phases):
            start_ts = _parse_iso(str(p.get("started_at", "")))
            if start_ts is None:
                continue
            if i + 1 < len(sorted_phases):
                end_ts = _parse_iso(
                    str(sorted_phases[i + 1].get("started_at", ""))
                )
            else:
                end_ts = _parse_iso(iter_ends.get(key, ""))
            if end_ts is None:
                continue
            duration = end_ts - start_ts
            if duration < 0:
                continue
            phase_name = str(p.get("phase", "unknown"))
            by_phase.setdefault(phase_name, []).append(duration)

    if not by_phase:
        return []

    rows: list[dict[str, object]] = []
    for name, durs in by_phase.items():
        rows.append({"phase": name, **_agg_stats(durs)})

    rows.sort(key=lambda x: x.get("total_s", 0), reverse=True)  # type: ignore[return-value]
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
                "phase": str(p.get("phase", "unknown")),
                "started_at": started_at,
                "ended_at": ended_at,
                "duration_s": duration,
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


def _format_stats_cols(row: dict[str, object]) -> str:
    return (
        f"{row.get('count', 0)!s:<6} "
        f"{_fmt_duration(_get_float(row, 'avg_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'min_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'max_s')):<8} "
        f"{_fmt_duration(_get_float(row, 'total_s')):<8}"
    )


def print_text(
    iterations: list[dict[str, object]],
    pipeline: list[dict[str, object]],
    *,
    substeps: list[dict[str, object]],
    agents: list[dict[str, object]],
    phases: list[dict[str, object]],
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
        print(f"{'Phase':<40} {_STATS_HEADER}")
        print("-" * 80)
        for row in phases:
            print(
                f"{row.get('phase', '')!s:<40} {_format_stats_cols(row)}"
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
        print(f"{'Agent':<28} {_STATS_HEADER}")
        print("-" * 68)
        for row in agents:
            print(f"{row.get('agent_name', '')!s:<28} {_format_stats_cols(row)}")
        print()

    if not iterations and not pipeline and not substeps and not agents and not phases:
        print("No performance data found.")


def print_phase_timeline(rows: list[dict[str, object]]) -> None:
    """Print one row per phase instance, sorted chronologically."""
    if not rows:
        print("No phase events found.")
        return
    print("=== Phase Timeline ===")
    print(
        f"{'Run':<22} {'Iter':<6} {'Phase':<40} {'Started':<22} {'Ended':<22} {'Duration':<10}"
    )
    print("-" * 124)
    for row in rows:
        dur = row.get("duration_s")
        dur_str = _fmt_duration(float(dur)) if isinstance(dur, (int, float)) else "?"
        print(
            f"{row.get('run_id', '')!s:<22} "
            f"{row.get('iteration', '')!s:<6} "
            f"{row.get('phase', '')!s:<40} "
            f"{row.get('started_at', '')!s:<22} "
            f"{row.get('ended_at', '')!s:<22} "
            f"{dur_str:<10}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize ClosedLoop loop performance from perf.jsonl"
    )
    parser.add_argument(
        "--workdir",
        required=True,
        help="CLOSEDLOOP_WORKDIR containing .learnings/perf.jsonl",
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

    if args.format == "json":
        output = {
            "iterations": iterations,
            "phases": phases,
            "pipeline_steps": pipeline,
            "pipeline_substeps": substeps,
            "agents": agents,
        }
        print(json.dumps(output, indent=2))
    else:
        print_text(
            iterations,
            pipeline,
            substeps=substeps,
            agents=agents,
            phases=phases,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
