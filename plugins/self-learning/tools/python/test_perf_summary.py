"""Tests for perf_summary.py."""

import json
from pathlib import Path

from perf_summary import (
    load_events,
    summarize_agents,
    summarize_iterations,
    summarize_pipeline,
    summarize_substeps,
)


def _write_events(perf_path: Path, events: list[dict[str, object]]) -> None:
    with open(perf_path, "w") as f:
        for event in events:
            f.write(json.dumps(event) + "\n")


class TestLoadEvents:
    def test_missing_file(self, tmp_path: Path) -> None:
        events = load_events(tmp_path / "nonexistent.jsonl")
        assert events == []

    def test_filters_by_run_id(self, tmp_path: Path) -> None:
        perf = tmp_path / "perf.jsonl"
        _write_events(
            perf,
            [
                {
                    "event": "iteration",
                    "run_id": "r1",
                    "iteration": 1,
                    "duration_s": 100,
                },
                {
                    "event": "iteration",
                    "run_id": "r2",
                    "iteration": 1,
                    "duration_s": 200,
                },
            ],
        )
        events = load_events(perf, run_id="r1")
        assert len(events) == 1
        assert events[0]["run_id"] == "r1"

    def test_skips_invalid_json(self, tmp_path: Path) -> None:
        perf = tmp_path / "perf.jsonl"
        perf.write_text(
            '{"event":"iteration","run_id":"r1","iteration":1,"duration_s":100}\n'
            "not valid json\n"
            '{"event":"pipeline_step","run_id":"r1","step_name":"changed_files","duration_s":5}\n',
        )
        events = load_events(perf)
        assert len(events) == 2


class TestSummarizeIterations:
    def test_empty_events(self) -> None:
        assert summarize_iterations([]) == []

    def test_multiple_iterations_summary(self) -> None:
        events = [
            {"event": "iteration", "iteration": 2, "duration_s": 200, "status": "ok"},
            {"event": "iteration", "iteration": 1, "duration_s": 100, "status": "ok"},
            {
                "event": "iteration",
                "iteration": 3,
                "duration_s": 300,
                "status": "completed",
            },
        ]
        result = summarize_iterations(events)
        assert [row["iteration"] for row in result[:-1]] == [1, 2, 3]
        assert result[-1]["iteration"] == "summary"
        assert result[-1]["total_s"] == 600.0


class TestSummarizePipeline:
    def test_empty_events(self) -> None:
        assert summarize_pipeline([]) == []

    def test_aggregates_by_step_name_and_counts_skips(self) -> None:
        events = [
            {
                "event": "pipeline_step",
                "step_name": "evaluate_goal",
                "duration_s": 3,
                "skipped": False,
            },
            {
                "event": "pipeline_step",
                "step_name": "evaluate_goal",
                "duration_s": 7,
                "skipped": False,
            },
            {
                "event": "pipeline_step",
                "step_name": "verify_citations",
                "duration_s": 0,
                "skipped": True,
            },
            {
                "event": "pipeline_step",
                "step_name": "verify_citations",
                "duration_s": 4,
                "skipped": False,
            },
        ]
        result = summarize_pipeline(events)
        assert len(result) == 2
        assert result[0]["step_name"] == "evaluate_goal"
        assert result[0]["count"] == 2
        assert result[0]["total_s"] == 10.0
        assert result[0]["skip_count"] == 0
        assert result[1]["step_name"] == "verify_citations"
        assert result[1]["skip_count"] == 1

    def test_excludes_events_with_sub_step_to_avoid_double_counting(self) -> None:
        """Outer run_timed_step emits one event; run-judges emits 7 inner events.
        summarize_pipeline must exclude inner events (with sub_step) so count/total_s
        reflect only the outer step, not 1+7=8.
        """
        events = [
            {"event": "pipeline_step", "step_name": "plan_judges", "duration_s": 120},
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 0,
                "sub_step_name": "prerequisites",
                "duration_s": 2,
            },
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 1,
                "sub_step_name": "batch_1",
                "duration_s": 30,
            },
        ]
        result = summarize_pipeline(events)
        assert len(result) == 1
        assert result[0]["step_name"] == "plan_judges"
        assert result[0]["count"] == 1
        assert result[0]["total_s"] == 120.0


class TestSummarizeSubsteps:
    def test_empty_events(self) -> None:
        assert summarize_substeps([]) == []

    def test_returns_empty_without_nested_metadata(self) -> None:
        events = [
            {
                "event": "pipeline_step",
                "step_name": "changed_files",
                "duration_s": 5,
                "skipped": False,
            },
        ]
        assert summarize_substeps(events) == []

    def test_reads_nested_metadata_from_pipeline_step(self) -> None:
        events = [
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 1,
                "sub_step_name": "dry-judge",
                "duration_s": 22,
                "skipped": False,
            },
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 1,
                "sub_step_name": "dry-judge",
                "duration_s": 30,
                "skipped": False,
            },
        ]
        result = summarize_substeps(events)
        assert len(result) == 1
        assert result[0]["step_name"] == "plan_judges"
        assert result[0]["sub_step"] == 1
        assert result[0]["sub_step_name"] == "dry-judge"
        assert result[0]["count"] == 2
        assert result[0]["total_s"] == 52.0

    def test_supports_optional_sub_step_name(self) -> None:
        events = [
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 2,
                "duration_s": 18,
                "skipped": False,
            },
        ]
        result = summarize_substeps(events)
        assert len(result) == 1
        assert result[0]["step_name"] == "plan_judges"
        assert result[0]["sub_step"] == 2
        assert result[0]["sub_step_name"] == ""

    def test_keeps_legacy_pipeline_substep_compatibility(self) -> None:
        events = [
            {
                "event": "pipeline_substep",
                "parent_step_name": "code_judges",
                "sub_step": 3,
                "sub_step_name": "test-judge",
                "duration_s": 41,
                "skipped": False,
            },
        ]
        result = summarize_substeps(events)
        assert len(result) == 1
        assert result[0]["step_name"] == "code_judges"
        assert result[0]["sub_step"] == 3
        assert result[0]["sub_step_name"] == "test-judge"

    def test_sorts_by_step_then_sub_step(self) -> None:
        events = [
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 2,
                "sub_step_name": "batch_2",
                "duration_s": 50,
            },
            {
                "event": "pipeline_step",
                "step_name": "plan_judges",
                "sub_step": 0,
                "sub_step_name": "prerequisites",
                "duration_s": 1,
            },
            {
                "event": "pipeline_step",
                "step_name": "code_judges",
                "sub_step": 1,
                "sub_step_name": "batch_1",
                "duration_s": 60,
            },
        ]
        result = summarize_substeps(events)
        assert [f"{row['step_name']}:{row['sub_step']}" for row in result] == [
            "code_judges:1",
            "plan_judges:0",
            "plan_judges:2",
        ]


class TestSummarizeAgents:
    def test_empty_events(self) -> None:
        assert summarize_agents([]) == []

    def test_ignores_non_agent_events(self) -> None:
        events = [
            {"event": "iteration", "iteration": 1, "duration_s": 100},
            {"event": "pipeline_step", "step_name": "changed_files", "duration_s": 5},
        ]
        assert summarize_agents(events) == []

    def test_aggregates_by_agent_name(self) -> None:
        events = [
            {"event": "agent", "agent_name": "dry-judge", "duration_s": 22},
            {"event": "agent", "agent_name": "dry-judge", "duration_s": 30},
            {"event": "agent", "agent_name": "kiss-judge", "duration_s": 15},
        ]
        result = summarize_agents(events)
        assert len(result) == 2
        dry = next(r for r in result if r["agent_name"] == "dry-judge")
        assert dry["count"] == 2
        assert dry["total_s"] == 52.0
        kiss = next(r for r in result if r["agent_name"] == "kiss-judge")
        assert kiss["count"] == 1
        assert kiss["total_s"] == 15.0

    def test_sorts_by_total_time_descending(self) -> None:
        events = [
            {"event": "agent", "agent_name": "fast-agent", "duration_s": 5},
            {"event": "agent", "agent_name": "slow-agent", "duration_s": 100},
            {"event": "agent", "agent_name": "mid-agent", "duration_s": 50},
        ]
        result = summarize_agents(events)
        assert [r["agent_name"] for r in result] == [
            "slow-agent",
            "mid-agent",
            "fast-agent",
        ]
