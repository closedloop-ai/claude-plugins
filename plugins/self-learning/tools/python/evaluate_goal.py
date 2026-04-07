#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Goal Evaluation

Evaluates run outcomes against configured goals with pluggable evaluators.
"""

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from goal_config import load_goal_config, GoalConfig
except ImportError:
    # Fallback for direct script execution
    sys.path.insert(0, str(Path(__file__).parent))
    from goal_config import load_goal_config, GoalConfig

# Log format field indices
RUNS_LOG_MIN_FIELDS = 4  # run_id|timestamp|goal_name|iteration|status


@dataclass
class GoalOutcome:
    """Result of goal evaluation."""
    goal: str
    run_id: str
    success: bool
    score: float  # 0.0 - 1.0
    metrics: dict[str, Any]
    details: str
    evaluated_at: str


def evaluate_reduce_failures(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:
    """Evaluate reduce-failures goal: minimize iterations to complete.

    Success criteria: Complete in fewer iterations than target.
    Score: 1.0 - (iterations / (target * 2)), clamped to [0, 1]
    """
    runs_log = workdir / '.learnings' / 'runs.log'

    # Default values
    iterations = 10
    target = config.success_criteria.get('target', 3)

    # Try to read actual iteration count from runs.log
    if runs_log.exists():
        with open(runs_log, 'r') as f:
            for line in f:
                parts = line.strip().split('|')
                if len(parts) >= RUNS_LOG_MIN_FIELDS and parts[0] == run_id:
                    iterations = int(parts[3]) if parts[3].isdigit() else 10
                    break

    # Also check environment variable
    env_iterations = os.environ.get('CLOSEDLOOP_ITERATION')
    if env_iterations and env_iterations.isdigit():
        iterations = int(env_iterations)

    success = iterations <= target
    score = max(0.0, min(1.0, 1.0 - (iterations / (target * 2))))

    return GoalOutcome(
        goal=config.name,
        run_id=run_id,
        success=success,
        score=round(score, 2),
        metrics={'iterations': iterations, 'target': target},
        details=f"Completed in {iterations} iterations (target: {target})",
        evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    )


def evaluate_swe_bench(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:
    """Evaluate swe-bench goal: pass test cases.

    Runs test_command and checks exit code.
    """
    test_command = config.success_criteria.get('test_command', 'pytest tests/ -x')

    try:
        result = subprocess.run(
            test_command,
            shell=True,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=300
        )
        success = result.returncode == 0

        # Try to parse test counts from output
        output = result.stdout + result.stderr
        passed = 0
        failed = 0

        # pytest format: "X passed, Y failed"
        import re
        match = re.search(r'(\d+) passed', output)
        if match:
            passed = int(match.group(1))
        match = re.search(r'(\d+) failed', output)
        if match:
            failed = int(match.group(1))

        total = passed + failed
        score = passed / total if total > 0 else 0.0

        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=success,
            score=round(score, 2),
            metrics={'tests_passed': passed, 'tests_failed': failed},
            details=f"Tests: {passed} passed, {failed} failed",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )

    except subprocess.TimeoutExpired:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.0,
            metrics={'error': 'timeout'},
            details="Test command timed out after 300s",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )
    except Exception as e:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.0,
            metrics={'error': str(e)},
            details=f"Test command failed: {e}",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )


def evaluate_minimize_tokens(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:
    """Evaluate minimize-tokens goal: reduce token usage.

    Parses Claude Code JSONL session file for token counts.
    """
    target = config.success_criteria.get('target', 50000)

    # Find session file
    session_id = os.environ.get('CLOSEDLOOP_SESSION_ID', '')
    session_file = None

    # Claude session transcripts live in home state; ClosedLoop does not use repo-local Claude state outside .claude/agents.
    possible_paths = [
        Path.home() / '.claude' / 'sessions' / f'{session_id}.jsonl',
    ]

    for path in possible_paths:
        if path.exists():
            session_file = path
            break

    if not session_file:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.5,  # Unknown - default middle score
            metrics={'error': 'session_file_not_found'},
            details="Could not find session file for token analysis",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )

    # Parse JSONL for token usage
    input_tokens = 0
    output_tokens = 0
    cache_tokens = 0

    try:
        with open(session_file, 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    usage = entry.get('usage', {})
                    input_tokens += usage.get('input_tokens', 0)
                    output_tokens += usage.get('output_tokens', 0)
                    cache_tokens += usage.get('cache_creation_input_tokens', 0)
                    cache_tokens += usage.get('cache_read_input_tokens', 0)
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.5,
            metrics={'error': str(e)},
            details=f"Error parsing session file: {e}",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )

    total_tokens = input_tokens + output_tokens
    success = total_tokens <= target
    score = max(0.0, min(1.0, 1.0 - (total_tokens / (target * 2))))

    return GoalOutcome(
        goal=config.name,
        run_id=run_id,
        success=success,
        score=round(score, 2),
        metrics={
            'input_tokens': input_tokens,
            'output_tokens': output_tokens,
            'cache_tokens': cache_tokens,
            'total_tokens': total_tokens,
            'target': target
        },
        details=f"Total tokens: {total_tokens} (target: {target})",
        evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    )


def evaluate_maximize_coverage(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:  # noqa: ARG001
    """Evaluate maximize-coverage goal: improve test coverage.

    Placeholder - returns middle score.
    """
    return GoalOutcome(
        goal=config.name,
        run_id=run_id,
        success=True,
        score=0.5,
        metrics={'coverage_percent': 'unknown'},
        details="Coverage evaluation not yet implemented",
        evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    )


def evaluate_custom(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:
    """Evaluate custom goal using GOAL_EVALUATOR_SCRIPT environment variable."""
    script_path = os.environ.get('GOAL_EVALUATOR_SCRIPT')

    if not script_path:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.0,
            metrics={'error': 'no_evaluator'},
            details="GOAL_EVALUATOR_SCRIPT not set for custom goal",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )

    try:
        result = subprocess.run(
            [script_path, '--run-id', run_id, '--workdir', str(workdir)],
            capture_output=True,
            text=True,
            timeout=60
        )

        # Expect JSON output
        output = json.loads(result.stdout)
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=output.get('success', False),
            score=output.get('score', 0.0),
            metrics=output.get('metrics', {}),
            details=output.get('details', 'Custom evaluation'),
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )

    except Exception as e:
        return GoalOutcome(
            goal=config.name,
            run_id=run_id,
            success=False,
            score=0.0,
            metrics={'error': str(e)},
            details=f"Custom evaluator failed: {e}",
            evaluated_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        )


# Evaluator dispatch table
EVALUATORS = {
    'reduce-failures': evaluate_reduce_failures,
    'swe-bench': evaluate_swe_bench,
    'minimize-tokens': evaluate_minimize_tokens,
    'maximize-coverage': evaluate_maximize_coverage,
}


def evaluate_goal(config: GoalConfig, run_id: str, workdir: Path) -> GoalOutcome:
    """Main evaluator dispatcher."""
    evaluator = EVALUATORS.get(config.name)

    if evaluator:
        return evaluator(config, run_id, workdir)
    else:
        # Try custom evaluator
        return evaluate_custom(config, run_id, workdir)


def main():
    parser = argparse.ArgumentParser(description='Evaluate goal outcome')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--run-id', required=True, help='Run ID to evaluate')
    parser.add_argument('--goal', help='Goal name (uses active_goal if not specified)')
    parser.add_argument('--output', default='-', help='Output file (- for stdout)')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()

    # Load goal config
    config = load_goal_config(workdir, args.goal)

    # Evaluate
    outcome = evaluate_goal(config, args.run_id, workdir)

    # Output
    output_json = json.dumps(asdict(outcome), indent=2)

    if args.output == '-':
        print(output_json)
    else:
        output_path = Path(args.output)
        with open(output_path, 'w') as f:
            f.write(output_json)
        print(f"Goal outcome written to {output_path}")

    # Also write to standard location
    goal_outcome_path = workdir / '.learnings' / 'goal-outcome.json'
    with open(goal_outcome_path, 'w') as f:
        f.write(output_json)

    return 0 if outcome.success else 1


if __name__ == '__main__':
    sys.exit(main())
