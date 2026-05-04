"""Shared test fixtures for plan-validate scripts."""


def make_minimal_data(**overrides: object) -> dict:
    """Build a base-valid plan dict with empty arrays."""
    data: dict = {
        "content": "",
        "acceptanceCriteria": [],
        "pendingTasks": [],
        "completedTasks": [],
        "openQuestions": [],
        "answeredQuestions": [],
        "gaps": [],
        "manualTasks": [],
    }
    data.update(overrides)
    return data
