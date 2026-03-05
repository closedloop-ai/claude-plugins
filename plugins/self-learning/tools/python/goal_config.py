#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Goal Configuration

Loads and validates goal configuration from goal.yaml.
"""

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


@dataclass
class GoalConfig:
    """Goal configuration loaded from goal.yaml."""
    name: str
    description: str = ""
    pattern_priority: list[str] = field(default_factory=list)
    success_criteria: dict[str, Any] = field(default_factory=dict)
    metrics: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    source: str = "default"
    load_warnings: list[str] = field(default_factory=list)


# Default goal configuration
DEFAULT_GOAL = GoalConfig(
    name="reduce-failures",
    description="Minimize iterations needed to complete tasks",
    pattern_priority=["mistake", "pattern", "convention", "insight"],
    success_criteria={"type": "threshold", "metric": "iterations", "target": 3, "direction": "below"},
    metrics=["iterations_to_complete", "error_count"],
    source="builtin"
)


def _default_config_with_warning(warning: str, goal_name: Optional[str] = None) -> GoalConfig:
    """Create a default config with a warning message."""
    config = GoalConfig(**DEFAULT_GOAL.__dict__)
    if goal_name:
        config.name = goal_name
    config.load_warnings = [warning]
    return config


def _load_raw_config(goal_path: Path) -> tuple[Optional[dict], Optional[str]]:
    """Load raw YAML config from file. Returns (config, error_message)."""
    if not goal_path.exists():
        return None, f"Config file not found: {goal_path}"

    if yaml is None:
        return None, "PyYAML not installed"

    try:
        with open(goal_path, 'r') as f:
            raw_config = yaml.safe_load(f)
        if not raw_config:
            return None, "Empty config file"
        return raw_config, None
    except Exception as e:
        return None, f"Error loading config: {e}"


def load_goal_config(workdir: Optional[Path] = None, goal_name: Optional[str] = None) -> GoalConfig:
    """Load goal configuration with comprehensive error handling.

    All failures degrade to safe defaults (reduce-failures goal).

    Args:
        workdir: Working directory (uses cwd if not specified)
        goal_name: Goal to load (uses active_goal from file if not specified)

    Returns:
        GoalConfig with loaded or default configuration
    """
    warnings: list[str] = []

    # Resolve workdir
    resolved_workdir = Path.cwd() if workdir is None else Path(workdir).resolve()
    goal_path = resolved_workdir / '.learnings' / 'goal.yaml'

    # Load raw config
    raw_config, error = _load_raw_config(goal_path)
    if error:
        logger.info(f"Using default config: {error}")
        return _default_config_with_warning(error)

    assert raw_config is not None  # for type checker

    # Determine which goal to load
    resolved_goal_name = goal_name or raw_config.get('active_goal') or 'reduce-failures'

    # Get goals dict
    goals = raw_config.get('goals', {})
    if not isinstance(goals, dict):
        logger.warning("Invalid 'goals' field in goal.yaml, using defaults")
        return _default_config_with_warning("Invalid 'goals' field - not a dict")

    # Get specific goal config
    goal_data = goals.get(resolved_goal_name)
    if not goal_data:
        logger.warning(f"Unknown goal '{resolved_goal_name}', using defaults")
        return _default_config_with_warning(f"Unknown goal: {resolved_goal_name}", resolved_goal_name)

    # Build config from goal data
    try:
        config = GoalConfig(
            name=resolved_goal_name,
            description=goal_data.get('description', ''),
            pattern_priority=goal_data.get('pattern_priority', []),
            success_criteria=goal_data.get('success_criteria', {}),
            metrics=goal_data.get('metrics', []),
            extra={k: v for k, v in goal_data.items()
                   if k not in ['description', 'pattern_priority', 'success_criteria', 'metrics']},
            source=str(goal_path),
            load_warnings=warnings
        )

        # Validate fields
        if not isinstance(config.pattern_priority, list):
            warnings.append("pattern_priority is not a list")
            config.pattern_priority = []

        if not isinstance(config.success_criteria, dict):
            warnings.append("success_criteria is not a dict")
            config.success_criteria = {}

        if not isinstance(config.metrics, list):
            warnings.append("metrics is not a list")
            config.metrics = []

        config.load_warnings = warnings
        logger.info(f"Loaded goal config: {resolved_goal_name}")
        return config

    except Exception as e:
        logger.warning(f"Error building goal config: {e}")
        return _default_config_with_warning(f"Build error: {e}")


def get_pattern_priority_safe(workdir: Optional[Path] = None,
                               goal_name: Optional[str] = None) -> Optional[list[str]]:
    """Get pattern priority from goal config, safely returning None on error.

    For use in hooks where errors should be silent.
    """
    try:
        config = load_goal_config(workdir, goal_name)
        if config.pattern_priority:
            return config.pattern_priority
        return None
    except Exception:
        return None


def main():
    """CLI entrypoint for testing goal config loading."""
    parser = argparse.ArgumentParser(description='Load and display goal configuration')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--goal', help='Goal name to load')
    parser.add_argument('--json', action='store_true', help='Output as JSON')

    args = parser.parse_args()

    config = load_goal_config(Path(args.workdir), args.goal)

    if args.json:
        print(json.dumps(asdict(config), indent=2))
    else:
        print(f"Goal: {config.name}")
        print(f"Description: {config.description}")
        print(f"Pattern Priority: {config.pattern_priority}")
        print(f"Success Criteria: {config.success_criteria}")
        print(f"Metrics: {config.metrics}")
        print(f"Source: {config.source}")
        if config.load_warnings:
            print(f"Warnings: {config.load_warnings}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
