"""Tests for perf_summary.py."""

import json
from pathlib import Path

from perf_summary import (
    backfill_agent_tokens_from_claude_output,
    load_events,
    phase_timeline,
    summarize_agents,
    summarize_phase_agents,
    summarize_iterations,
    summarize_phases,
    summarize_pipeline,
    summarize_substeps,
)


def _write_events(perf_path: Path, events: list[dict[str, object]]) -> None:
    with open(perf_path, "w") as f:
        for event in events:
            f.write(json.dumps(event) + "\n")


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


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
        assert dry["total_tokens"] == 0
        assert dry["peak_context_tokens"] == 0

    def test_aggregates_token_usage_by_agent_name(self) -> None:
        events = [
            {
                "event": "agent",
                "agent_name": "dry-judge",
                "duration_s": 22,
                "input_tokens": 100,
                "output_tokens": 25,
                "cache_creation_input_tokens": 10,
                "cache_read_input_tokens": 5,
                "total_context_tokens": 900,
            },
            {
                "event": "agent",
                "agent_name": "dry-judge",
                "duration_s": 30,
                "input_tokens": 200,
                "output_tokens": 75,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 25,
                "total_context_tokens": 850,
            },
            {
                "event": "agent",
                "agent_name": "kiss-judge",
                "duration_s": 15,
                "input_tokens": 50,
                "output_tokens": 10,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "total_context_tokens": 100,
            },
        ]
        result = summarize_agents(events)
        dry = next(r for r in result if r["agent_name"] == "dry-judge")
        assert dry["input_tokens"] == 300
        assert dry["output_tokens"] == 100
        assert dry["cache_creation_input_tokens"] == 10
        assert dry["cache_read_input_tokens"] == 30
        assert dry["total_tokens"] == 440
        assert dry["peak_context_tokens"] == 900

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


class TestBackfillAgentTokensFromClaudeOutput:
    def test_hydrates_legacy_agent_rows_from_archived_output_sidecar(
        self, tmp_path: Path
    ) -> None:
        events = [
            {
                "event": "agent",
                "agent_id": "agent-1",
                "agent_name": "pre-explorer",
                "duration_s": 10,
            },
            {
                "event": "agent",
                "agent_id": "agent-2",
                "agent_name": "plan-validator",
                "duration_s": 20,
            },
        ]
        archived = tmp_path / "claude-output-run-1.jsonl"
        (tmp_path / "claude-output.name.txt").write_text(archived.name)
        _write_jsonl(
            archived,
            [
                {
                    "type": "user",
                    "tool_use_result": {
                        "agentId": "agent-1",
                        "usage": {
                            "input_tokens": 1,
                            "output_tokens": 20,
                            "cache_creation_input_tokens": 30,
                            "cache_read_input_tokens": 400,
                        },
                    },
                }
            ],
        )

        updated = backfill_agent_tokens_from_claude_output(events, tmp_path)
        assert updated == 1

        result = summarize_agents(events)
        pre_explorer = next(r for r in result if r["agent_name"] == "pre-explorer")
        assert pre_explorer["input_tokens"] == 1
        assert pre_explorer["output_tokens"] == 20
        assert pre_explorer["cache_creation_input_tokens"] == 30
        assert pre_explorer["cache_read_input_tokens"] == 400
        assert pre_explorer["total_tokens"] == 451

        validator = next(r for r in result if r["agent_name"] == "plan-validator")
        assert validator["total_tokens"] == 0

    def test_keeps_existing_nonzero_perf_token_fields(self, tmp_path: Path) -> None:
        events = [
            {
                "event": "agent",
                "agent_id": "agent-1",
                "agent_name": "pre-explorer",
                "duration_s": 10,
                "input_tokens": 9,
                "output_tokens": 1,
            },
        ]
        _write_jsonl(
            tmp_path / "claude-output.jsonl",
            [
                {
                    "tool_use_result": {
                        "agentId": "agent-1",
                        "usage": {"input_tokens": 100, "output_tokens": 200},
                    }
                }
            ],
        )

        updated = backfill_agent_tokens_from_claude_output(events, tmp_path)
        assert updated == 0
        assert events[0]["input_tokens"] == 9
        assert events[0]["output_tokens"] == 1


class TestSummarizePhases:
    def test_empty_events(self) -> None:
        assert summarize_phases([]) == []

    def test_derives_durations_from_consecutive_phases(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:02:30Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:05:00Z",
            },
        ]
        result = summarize_phases(events)
        by_name = {row["phase"]: row for row in result}
        assert by_name["Phase 1: Planning"]["total_s"] == 150.0
        assert by_name["Phase 3: Implementation"]["total_s"] == 150.0

    def test_skips_final_phase_without_iteration_end(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:02:30Z",
            },
        ]
        result = summarize_phases(events)
        by_name = {row["phase"]: row for row in result}
        assert "Phase 1: Planning" in by_name
        assert "Phase 3: Implementation" not in by_name

    def test_does_not_pair_phases_across_iterations(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 7: Logging",
                "started_at": "2026-04-30T10:04:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 2,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:10:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:05:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 2,
                "ended_at": "2026-04-30T10:15:00Z",
            },
        ]
        result = summarize_phases(events)
        by_name = {row["phase"]: row for row in result}
        assert by_name["Phase 7: Logging"]["total_s"] == 60.0
        assert by_name["Phase 1: Planning"]["total_s"] == 300.0

    def test_aggregates_repeated_phase_across_iterations(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:01:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 2,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:02:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 2,
                "ended_at": "2026-04-30T10:05:00Z",
            },
        ]
        result = summarize_phases(events)
        assert len(result) == 1
        assert result[0]["count"] == 2
        assert result[0]["total_s"] == 240.0

    def test_sorts_by_total_time_descending(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase A",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase B",
                "started_at": "2026-04-30T10:00:10Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:02:00Z",
            },
        ]
        result = summarize_phases(events)
        assert [row["phase"] for row in result] == ["Phase B", "Phase A"]

    def test_sums_tokens_from_agents_started_inside_phase_window(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "phase": "Phase A",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "phase": "Phase B",
                "started_at": "2026-04-30T10:10:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:20:00Z",
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "planner",
                "started_at": "2026-04-30T10:05:00Z",
                "duration_s": 60,
                "input_tokens": 100,
                "output_tokens": 25,
                "cache_creation_input_tokens": 5,
                "cache_read_input_tokens": 10,
                "total_context_tokens": 500,
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "critic",
                "started_at": "2026-04-30T10:10:00Z",
                "duration_s": 30,
                "input_tokens": 200,
                "output_tokens": 50,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 20,
                "total_context_tokens": 700,
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "code_review",
                "agent_name": "wrong-command",
                "started_at": "2026-04-30T10:15:00Z",
                "duration_s": 30,
                "input_tokens": 999,
                "output_tokens": 999,
            },
        ]
        result = summarize_phases(events)
        by_phase = {row["phase"]: row for row in result}
        assert by_phase["Phase A"]["total_tokens"] == 140
        assert by_phase["Phase A"]["peak_context_tokens"] == 500
        assert by_phase["Phase B"]["total_tokens"] == 270
        assert by_phase["Phase B"]["peak_context_tokens"] == 700


class TestSummarizePhaseAgents:
    def test_empty_events(self) -> None:
        assert summarize_phase_agents([]) == []

    def test_aggregates_tokens_by_phase_and_agent(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "phase": "Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "phase": "Implementation",
                "started_at": "2026-04-30T10:05:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:20:00Z",
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "planner",
                "started_at": "2026-04-30T10:01:00Z",
                "duration_s": 10,
                "input_tokens": 100,
                "output_tokens": 20,
                "total_context_tokens": 300,
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "planner",
                "started_at": "2026-04-30T10:02:00Z",
                "duration_s": 20,
                "input_tokens": 150,
                "output_tokens": 30,
                "cache_read_input_tokens": 40,
                "total_context_tokens": 400,
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "implementation-subagent",
                "started_at": "2026-04-30T10:06:00Z",
                "duration_s": 60,
                "input_tokens": 500,
                "output_tokens": 200,
                "cache_creation_input_tokens": 25,
                "total_context_tokens": 1200,
            },
        ]
        result = summarize_phase_agents(events)
        by_key = {(row["phase"], row["agent_name"]): row for row in result}

        planning = by_key[("Planning", "planner")]
        assert planning["count"] == 2
        assert planning["total_s"] == 30.0
        assert planning["input_tokens"] == 250
        assert planning["output_tokens"] == 50
        assert planning["cache_read_input_tokens"] == 40
        assert planning["total_tokens"] == 340
        assert planning["peak_context_tokens"] == 400

        implementation = by_key[("Implementation", "implementation-subagent")]
        assert implementation["count"] == 1
        assert implementation["total_tokens"] == 725
        assert implementation["peak_context_tokens"] == 1200


class TestPhaseTimeline:
    def test_empty_events(self) -> None:
        assert phase_timeline([]) == []

    def test_emits_chronological_rows_with_durations(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:02:30Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:05:00Z",
            },
        ]
        result = phase_timeline(events)
        assert [row["phase"] for row in result] == [
            "Phase 1: Planning",
            "Phase 3: Implementation",
        ]
        assert result[0]["started_at"] == "2026-04-30T10:00:00Z"
        assert result[0]["ended_at"] == "2026-04-30T10:02:30Z"
        assert result[0]["duration_s"] == 150.0
        assert result[1]["started_at"] == "2026-04-30T10:02:30Z"
        assert result[1]["ended_at"] == "2026-04-30T10:05:00Z"
        assert result[1]["duration_s"] == 150.0
        for row in result:
            assert row["run_id"] == "r1"
            assert row["iteration"] == 1

    def test_emits_incomplete_final_phase_with_null_duration(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 3: Implementation",
                "started_at": "2026-04-30T10:02:30Z",
            },
        ]
        result = phase_timeline(events)
        assert len(result) == 2
        impl = result[1]
        assert impl["phase"] == "Phase 3: Implementation"
        assert impl["ended_at"] == ""
        assert impl["duration_s"] is None

    def test_does_not_pair_phases_across_iterations(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "phase": "Phase 7: Logging",
                "started_at": "2026-04-30T10:04:00Z",
            },
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 2,
                "phase": "Phase 1: Planning",
                "started_at": "2026-04-30T10:10:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:05:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 2,
                "ended_at": "2026-04-30T10:15:00Z",
            },
        ]
        result = phase_timeline(events)
        by_phase = {row["phase"]: row for row in result}
        assert by_phase["Phase 7: Logging"]["ended_at"] == "2026-04-30T10:05:00Z"
        assert by_phase["Phase 7: Logging"]["duration_s"] == 60.0
        assert by_phase["Phase 1: Planning"]["ended_at"] == "2026-04-30T10:15:00Z"
        assert by_phase["Phase 1: Planning"]["duration_s"] == 300.0

    def test_includes_run_id_and_iteration_per_row(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "run-a",
                "iteration": 3,
                "phase": "Phase 5",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "iteration",
                "run_id": "run-a",
                "iteration": 3,
                "ended_at": "2026-04-30T10:01:00Z",
            },
        ]
        result = phase_timeline(events)
        assert len(result) == 1
        assert result[0]["run_id"] == "run-a"
        assert result[0]["iteration"] == 3

    def test_includes_phase_instance_token_totals(self) -> None:
        events = [
            {
                "event": "phase",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "phase": "Planning",
                "started_at": "2026-04-30T10:00:00Z",
            },
            {
                "event": "iteration",
                "run_id": "r1",
                "iteration": 1,
                "ended_at": "2026-04-30T10:05:00Z",
            },
            {
                "event": "agent",
                "run_id": "r1",
                "iteration": 1,
                "command": "plan_execute",
                "agent_name": "planner",
                "started_at": "2026-04-30T10:01:00Z",
                "duration_s": 30,
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_creation_input_tokens": 5,
                "cache_read_input_tokens": 10,
                "total_context_tokens": 300,
            },
        ]
        result = phase_timeline(events)
        assert result[0]["total_tokens"] == 135
        assert result[0]["peak_context_tokens"] == 300
