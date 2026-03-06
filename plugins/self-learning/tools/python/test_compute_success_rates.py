"""Tests for compute_success_rates.py."""

import textwrap
from pathlib import Path

import pytest

from compute_success_rates import (
    compute_rates,
    jaccard_similarity,
    match_outcome_to_pattern,
    parse_outcomes_log,
    parse_toon_patterns,
    serialize_toon,
)


@pytest.fixture
def tmp_workdir(tmp_path: Path) -> Path:
    """Create a workdir with .learnings directory."""
    learnings = tmp_path / ".learnings"
    learnings.mkdir()
    return tmp_path


def _write_toon(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content))


def _write_outcomes(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content))


# --- parse_toon_patterns ---

class TestParseToonPatterns:
    def test_empty_file(self, tmp_path: Path) -> None:
        toon = tmp_path / "org-patterns.toon"
        toon.write_text("")
        _headers, patterns = parse_toon_patterns(toon)
        assert patterns == []

    def test_missing_file(self, tmp_path: Path) -> None:
        toon = tmp_path / "nonexistent.toon"
        headers, patterns = parse_toon_patterns(toon)
        assert headers == []
        assert patterns == []

    def test_parses_single_pattern(self, tmp_path: Path) -> None:
        toon = tmp_path / "org-patterns.toon"
        _write_toon(toon, """\
            # Comment line
            patterns[1]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:
              P-001,pattern,"Always run tests before merging",high,5,0.85,,*,test|CI,*
        """)
        headers, patterns = parse_toon_patterns(toon)
        assert len(headers) == 2  # comment + schema
        assert len(patterns) == 1
        assert patterns[0]["id"] == "P-001"
        assert patterns[0]["category"] == "pattern"
        assert patterns[0]["summary"] == "Always run tests before merging"
        assert patterns[0]["confidence"] == "high"
        assert patterns[0]["success_rate"] == "0.85"
        assert patterns[0]["context"] == "test|CI"
        assert patterns[0]["repo"] == "*"

    def test_parses_multiple_patterns(self, tmp_path: Path) -> None:
        toon = tmp_path / "org-patterns.toon"
        _write_toon(toon, """\
              P-001,pattern,"Summary one",high,5,0.85,,*,tag1
              P-002,mistake,"Summary two",medium,3,0.60,[REVIEW],agent1|agent2,tag2|tag3
        """)
        _, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 2
        assert patterns[1]["flags"] == "[REVIEW]"
        assert patterns[1]["applies_to"] == "agent1|agent2"

    def test_parses_summary_with_commas(self, tmp_path: Path) -> None:
        toon = tmp_path / "org-patterns.toon"
        _write_toon(toon, """\
              P-001,pattern,"Validation: test=pnpm test, typecheck=pnpm typecheck",medium,6,0.00,[UNTESTED],build-validator|phase-5-validation,next.js|monorepo
        """)
        _, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 1
        assert "test=pnpm test, typecheck=pnpm typecheck" in patterns[0]["summary"]

    def test_parses_legacy_9_field_rows(self, tmp_path: Path) -> None:
        """Legacy 9-field TOON rows should parse with repo defaulting to '*'."""
        toon = tmp_path / "org-patterns.toon"
        _write_toon(toon, """\
              P-001,pattern,"Summary one",high,5,0.85,,*,tag1
              P-002,mistake,"Summary two",medium,3,0.60,[REVIEW],agent1|agent2,tag2|tag3
        """)
        _, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 2
        assert patterns[0]["repo"] == "*"
        assert patterns[1]["repo"] == "*"

    def test_parses_10_field_rows_with_repo(self, tmp_path: Path) -> None:
        """10-field TOON rows should parse with explicit repo value."""
        toon = tmp_path / "org-patterns.toon"
        _write_toon(toon, """\
              P-001,pattern,"Summary one",high,5,0.85,,*,tag1,my-repo
              P-002,mistake,"Summary two",medium,3,0.60,[REVIEW],agent1,tag2,*
        """)
        _, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 2
        assert patterns[0]["repo"] == "my-repo"
        assert patterns[1]["repo"] == "*"

    def test_mixed_9_and_10_field_rows(self, tmp_path: Path) -> None:
        """Mixed 9-field and 10-field rows should both parse correctly."""
        toon = tmp_path / "org-patterns.toon"
        toon.write_text(
            'patterns[2]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:\n'
            '  P-001,pattern,"Legacy pattern",high,5,0.85,,*,tag1\n'
            '  P-002,pattern,"New pattern",high,3,0.90,,*,tag2,my-repo\n'
        )
        _, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 2
        assert patterns[0]["repo"] == "*"  # legacy fallback
        assert patterns[1]["repo"] == "my-repo"

    def test_parses_real_toon_format(self, tmp_path: Path) -> None:
        """Test against the actual format from ~/.closedloop-ai/learnings/org-patterns.toon."""
        toon = tmp_path / "org-patterns.toon"
        toon.write_text(
            '# Organization Patterns (TOON format)\n'
            '# Last updated: 2026-01-29T23:11:00Z\n'
            '\n'
            'patterns[2]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context}:\n'
            '  P-001,pattern,"Project validation commands: test=pnpm test | typecheck=pnpm typecheck",medium,6,0.00,[UNTESTED],build-validator|phase-5-validation,next.js|monorepo|turborepo\n'
            '  P-005,mistake,"When task specifies exact line numbers for removal read those lines specifically",high,1,0.00,[UNTESTED],implementation-subagent,editing|precision|line-numbers\n'
        )
        headers, patterns = parse_toon_patterns(toon)
        assert len(headers) == 4  # 2 comments + blank + schema
        assert len(patterns) == 2
        assert patterns[0]["id"] == "P-001"
        assert patterns[0]["applies_to"] == "build-validator|phase-5-validation"
        assert patterns[0]["context"] == "next.js|monorepo|turborepo"
        assert patterns[1]["id"] == "P-005"
        assert patterns[1]["category"] == "mistake"


# --- parse_outcomes_log ---

class TestParseOutcomesLog:
    def test_empty_file(self, tmp_workdir: Path) -> None:
        log = tmp_workdir / ".learnings" / "outcomes.log"
        log.write_text("")
        outcomes = parse_outcomes_log(log)
        assert outcomes == []

    def test_missing_file(self, tmp_workdir: Path) -> None:
        log = tmp_workdir / ".learnings" / "outcomes.log"
        outcomes = parse_outcomes_log(log)
        assert outcomes == []

    def test_parses_basic_outcome(self, tmp_workdir: Path) -> None:
        log = tmp_workdir / ".learnings" / "outcomes.log"
        _write_outcomes(log, """\
            2024-01-15T10:00:00Z|run-001|1|agent-a|test trigger|applied|src/foo.ts:10
        """)
        outcomes = parse_outcomes_log(log)
        assert len(outcomes) == 1
        assert outcomes[0]["pattern_trigger"] == "test trigger"
        assert outcomes[0]["status"] == "applied"
        assert outcomes[0]["unverified"] == ""

    def test_parses_unverified_outcome(self, tmp_workdir: Path) -> None:
        log = tmp_workdir / ".learnings" / "outcomes.log"
        _write_outcomes(log, """\
            2024-01-15T10:00:00Z|run-001|1|agent-a|test trigger|applied|src/foo.ts:10|unverified
        """)
        outcomes = parse_outcomes_log(log)
        assert len(outcomes) == 1
        assert outcomes[0]["unverified"] == "1"

    def test_parses_injected_status_as_unverified(self, tmp_workdir: Path) -> None:
        """Outcomes with status=injected should be marked as unverified."""
        log = tmp_workdir / ".learnings" / "outcomes.log"
        _write_outcomes(log, """\
            2024-01-15T10:00:00Z|run-001|1|agent-a|test trigger|injected|
        """)
        outcomes = parse_outcomes_log(log)
        assert len(outcomes) == 1
        assert outcomes[0]["status"] == "injected"
        assert outcomes[0]["unverified"] == "1"

    def test_parses_goal_fields(self, tmp_workdir: Path) -> None:
        log = tmp_workdir / ".learnings" / "outcomes.log"
        _write_outcomes(log, """\
            2024-01-15T10:00:00Z|run-001|1|agent-a|test trigger|applied|src/foo.ts:10|0.8|context_tags|reduce-failures|1|0.75
        """)
        outcomes = parse_outcomes_log(log)
        assert len(outcomes) == 1
        assert outcomes[0]["goal_name"] == "reduce-failures"
        assert outcomes[0]["goal_success"] == "1"
        assert outcomes[0]["goal_score"] == "0.75"
        assert outcomes[0]["relevance_score"] == "0.8"


# --- matching ---

class TestMatching:
    def test_exact_match(self) -> None:
        assert match_outcome_to_pattern("test trigger", "test trigger")

    def test_case_insensitive_match(self) -> None:
        assert match_outcome_to_pattern("Test Trigger", "test trigger")

    def test_substring_match(self) -> None:
        assert match_outcome_to_pattern("test", "test trigger for something")

    def test_reverse_substring_match(self) -> None:
        assert match_outcome_to_pattern("test trigger for something", "test trigger")

    def test_jaccard_match(self) -> None:
        # Jaccard({run,all,unit,tests,first,before,push} & {run,unit,tests,first,before,merge}) = 5/8 = 0.625
        assert match_outcome_to_pattern("run all unit tests first before push", "run unit tests first before merge")

    def test_no_match(self) -> None:
        assert not match_outcome_to_pattern("completely different", "test trigger")

    def test_jaccard_similarity_identical(self) -> None:
        assert jaccard_similarity("hello world", "hello world") == 1.0

    def test_jaccard_similarity_empty(self) -> None:
        assert jaccard_similarity("", "") == 0.0


# --- compute_rates ---

class TestComputeRates:
    def test_no_outcomes_marks_untested(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "test"},
        ]
        result = compute_rates(patterns, [], max_iteration=0)
        assert result[0]["flags"] == "[UNTESTED]"

    def test_single_applied_pattern(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "",
             "iteration": "1"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=1)
        assert result[0]["success_rate"] == "1.00"
        assert result[0]["confidence"] == "high"
        assert result[0]["flags"] == ""

    def test_mixed_applied_and_unverified(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "",
             "category": "pattern", "seen_count": "3", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "", "iteration": "1"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "2"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "", "iteration": "3"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=3)
        # 2 verified out of 3 total = 0.67
        assert result[0]["success_rate"] == "0.67"
        assert result[0]["confidence"] == "medium"

    def test_goal_weighting(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "",
             "category": "pattern", "seen_count": "2", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "",
             "iteration": "1", "goal_success": "1", "goal_name": "reduce-failures", "goal_score": "0.8"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "",
             "iteration": "2", "goal_success": "0", "goal_name": "reduce-failures", "goal_score": "0.2",
             "relevance_score": "0.6"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=2)
        # goal_success=1 -> 1.0, goal_success=0 -> 0.6 * 0.5 = 0.3
        # total = (1.0 + 0.3) / 2 = 0.65
        assert result[0]["success_rate"] == "0.65"
        assert result[0]["confidence"] == "medium"

    def test_low_success_marks_review(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "5", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "1"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "2"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "", "iteration": "3"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=3)
        # 1 verified out of 3 = 0.33
        assert result[0]["success_rate"] == "0.33"
        assert result[0]["confidence"] == "low"
        assert result[0]["flags"] == "[REVIEW]"

    def test_stale_pattern(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "5", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "", "iteration": "1"},
        ]
        # max_iteration=11, last application at iteration 1 -> stale (11-1 >= 10)
        result = compute_rates(patterns, outcomes, max_iteration=11)
        assert result[0]["flags"] == "[STALE]"

    def test_confidence_transitions(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "some summary", "confidence": "low",
             "success_rate": "0.20", "flags": "[REVIEW]",
             "category": "pattern", "seen_count": "5", "applies_to": "*", "context": "test"},
        ]
        # All successful -> high confidence
        outcomes = [
            {"pattern_trigger": "some summary", "status": "applied", "unverified": "", "iteration": "1"},
            {"pattern_trigger": "some summary", "status": "applied", "unverified": "", "iteration": "2"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=2)
        assert result[0]["confidence"] == "high"
        assert result[0]["success_rate"] == "1.00"
        assert result[0]["flags"] == ""

    def test_fuzzy_matching_across_patterns(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "check token expiry", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "auth"},
        ]
        outcomes = [
            {"pattern_trigger": "always check token expiry before API", "status": "applied",
             "unverified": "", "iteration": "1"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=1)
        # "check token expiry" is a substring of "always check token expiry before API"
        assert result[0]["success_rate"] == "1.00"

    def test_injected_outcomes_count_as_unverified(self) -> None:
        """Injected (not explicitly applied) outcomes should lower success rate."""
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "",
             "iteration": "1"},
            {"pattern_trigger": "test trigger summary", "status": "injected", "unverified": "1",
             "iteration": "2"},
            {"pattern_trigger": "test trigger summary", "status": "injected", "unverified": "1",
             "iteration": "3"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=3)
        # 1 applied + 2 injected (unverified) = 1/3 = 0.33
        assert result[0]["success_rate"] == "0.33"
        assert result[0]["confidence"] == "low"

    def test_idempotent_double_run(self) -> None:
        """Running compute_rates twice should produce the same result."""
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "", "iteration": "1"},
        ]
        result1 = compute_rates(patterns, outcomes, max_iteration=1)
        result2 = compute_rates(result1, outcomes, max_iteration=1)
        assert result1 == result2


# --- TOON round-trip ---

class TestToonRoundTrip:
    def test_round_trip_preserves_content(self, tmp_path: Path) -> None:
        toon = tmp_path / "org-patterns.toon"
        original = (
            '# Organization Patterns\n'
            '# Last updated: 2024-01-15T10:30:00Z\n'
            'patterns[2]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:\n'
            '  P-001,pattern,"Always run tests",high,5,0.85,,*,test|CI,*\n'
            '  P-002,mistake,"Check for None before accessing",medium,3,0.60,[REVIEW],agent1,python|safety,my-repo\n'
        )
        toon.write_text(original)

        headers, patterns = parse_toon_patterns(toon)
        output = serialize_toon(headers, patterns)

        # Re-parse the output
        toon2 = tmp_path / "org-patterns2.toon"
        toon2.write_text(output)
        _, patterns2 = parse_toon_patterns(toon2)

        assert len(patterns) == len(patterns2)
        for p1, p2 in zip(patterns, patterns2, strict=True):
            assert p1["id"] == p2["id"]
            assert p1["summary"] == p2["summary"]
            assert p1["confidence"] == p2["confidence"]
            assert p1["context"] == p2["context"]
            assert p1["repo"] == p2["repo"]

    def test_round_trip_with_embedded_quotes(self, tmp_path: Path) -> None:
        """Ensure summaries with double quotes survive a parse-serialize-parse cycle."""
        toon = tmp_path / "org-patterns.toon"
        # RFC 4180: embedded quotes are doubled ("") inside quoted fields
        toon.write_text(
            'patterns[1]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:\n'
            '  P-001,pattern,"Use ""strict"" mode for TypeScript",high,3,0.90,,*,typescript,*\n'
        )

        headers, patterns = parse_toon_patterns(toon)
        assert len(patterns) == 1
        assert patterns[0]["summary"] == 'Use "strict" mode for TypeScript'

        # Serialize and re-parse
        output = serialize_toon(headers, patterns)
        toon2 = tmp_path / "round-trip.toon"
        toon2.write_text(output)
        _, patterns2 = parse_toon_patterns(toon2)

        assert len(patterns2) == 1
        assert patterns2[0]["summary"] == 'Use "strict" mode for TypeScript'

    def test_quote_if_needed_with_quotes(self, tmp_path: Path) -> None:
        """Flags containing quotes should use RFC 4180 double-quote escaping."""
        from compute_success_rates import _quote_if_needed
        # Value with embedded quote
        result = _quote_if_needed('value with "quotes"')
        assert result == '"value with ""quotes"""'
        # Round-trip through csv.reader
        import csv
        import io
        reader = csv.reader(io.StringIO(result))
        parsed = next(reader)
        assert parsed[0] == 'value with "quotes"'


# --- Flag assignment ---

class TestFlagAssignment:
    def test_untested_no_applications(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "unique summary xyz", "confidence": "medium",
             "success_rate": "", "flags": "[UNTESTED]",
             "category": "pattern", "seen_count": "1", "applies_to": "*", "context": "test"},
        ]
        result = compute_rates(patterns, [], max_iteration=5)
        assert result[0]["flags"] == "[UNTESTED]"

    def test_review_flag_low_rate(self) -> None:
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "5", "applies_to": "*", "context": "test"},
        ]
        # All unverified -> 0% success
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "1"},
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "2"},
        ]
        result = compute_rates(patterns, outcomes, max_iteration=2)
        assert result[0]["flags"] == "[REVIEW]"

    def test_stale_overrides_review(self) -> None:
        """[STALE] takes precedence when both stale and low rate."""
        patterns = [
            {"id": "P-001", "summary": "test trigger summary", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "5", "applies_to": "*", "context": "test"},
        ]
        outcomes = [
            {"pattern_trigger": "test trigger summary", "status": "applied", "unverified": "1", "iteration": "1"},
        ]
        # Stale: iteration 1, max_iteration 11
        result = compute_rates(patterns, outcomes, max_iteration=11)
        assert result[0]["flags"] == "[STALE]"

    def test_prune_flag_high_count_low_rate(self) -> None:
        """[PRUNE] when applied_count > 20 and success_rate < 0.40."""
        patterns = [
            {"id": "P-001", "summary": "prune me trigger", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "25", "applies_to": "*", "context": "test"},
        ]
        # 21 outcomes, all unverified (0% success)
        outcomes = [
            {"pattern_trigger": "prune me trigger", "status": "applied",
             "unverified": "1", "iteration": str(i)}
            for i in range(1, 22)
        ]
        result = compute_rates(patterns, outcomes, max_iteration=21)
        assert result[0]["flags"] == "[PRUNE]"
        assert result[0]["success_rate"] == "0.00"
        assert result[0]["confidence"] == "low"

    def test_no_prune_below_threshold_count(self) -> None:
        """No [PRUNE] when applied_count <= 20 even with low success."""
        patterns = [
            {"id": "P-001", "summary": "not enough applications trigger", "confidence": "high",
             "success_rate": "0.80", "flags": "",
             "category": "pattern", "seen_count": "20", "applies_to": "*", "context": "test"},
        ]
        # 20 outcomes, all unverified (0% success) - at threshold, not above
        outcomes = [
            {"pattern_trigger": "not enough applications trigger", "status": "applied",
             "unverified": "1", "iteration": str(i)}
            for i in range(1, 21)
        ]
        result = compute_rates(patterns, outcomes, max_iteration=20)
        assert result[0]["flags"] == "[REVIEW]"  # Not [PRUNE]

    def test_no_prune_above_success_threshold(self) -> None:
        """No [PRUNE] when success_rate >= 0.40 even with many applications."""
        patterns = [
            {"id": "P-001", "summary": "above success threshold trigger", "confidence": "medium",
             "success_rate": "0.50", "flags": "",
             "category": "pattern", "seen_count": "25", "applies_to": "*", "context": "test"},
        ]
        # 21 outcomes: 9 verified (success) + 12 unverified => 9/21 = 0.43
        outcomes = [
            {"pattern_trigger": "above success threshold trigger", "status": "applied",
             "unverified": "", "iteration": str(i)}
            for i in range(1, 10)
        ] + [
            {"pattern_trigger": "above success threshold trigger", "status": "applied",
             "unverified": "1", "iteration": str(i)}
            for i in range(10, 22)
        ]
        result = compute_rates(patterns, outcomes, max_iteration=21)
        assert result[0]["flags"] != "[PRUNE]"
