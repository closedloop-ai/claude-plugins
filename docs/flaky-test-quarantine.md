# Flaky Test Quarantine & Contract Tests

This repo uses pytest markers to categorize tests for CI gating. Two markers are
currently defined in `pyproject.toml` under `[tool.pytest.ini_options]`:

- `@pytest.mark.contract` -- repo-level contract tests that assert invariants
  across multiple plugins or modules. Run by the `contract-tests` CI job.
- `@pytest.mark.quarantine` -- known-flaky tests that should not block merges.
  Run by the `quarantine` CI job with `continue-on-error: true`.

## How CI uses the markers

`.github/workflows/ci.yml` runs several gates, each installing from
`requirements-dev.txt` followed by `pip check`:

| Job              | Command                                 | Blocking? |
| ---------------- | --------------------------------------- | --------- |
| `Lint`           | `ruff check .`                          | yes       |
| `Type Check`     | `pyright`                               | yes       |
| `Tests`          | `pytest plugins/ -m 'not quarantine'`   | yes       |
| `Contract tests` | `pytest plugins/ -m contract`           | yes       |
| `Quarantined tests (non-blocking)` | `pytest plugins/ -m quarantine` | **no**  |
| `PR gates`       | aggregates the four blocking jobs       | yes       |

The `Contract tests` and `Quarantined tests` jobs both treat pytest exit
code 5 ("no tests collected") as success so they pass vacuously until
tests are marked.

## Quarantining a flaky test

1. Add the marker to the top of the test function or class:
   ```python
   import pytest

   @pytest.mark.quarantine
   def test_something_flaky():
       ...
   ```
2. Add a comment referencing the tracking issue:
   ```python
   # FLAKY: https://github.com/closedloop-ai/claude-plugins/issues/NNN
   @pytest.mark.quarantine
   def test_something_flaky():
       ...
   ```
3. Open or link a follow-up issue to fix or delete the test.

Because the main `Tests` job runs with `-m 'not quarantine'`, quarantined tests
are excluded from the blocking run. The non-blocking `Quarantined tests` job
still executes them so signal is retained in the PR check summary.

## Un-quarantining

Remove the `@pytest.mark.quarantine` decorator (and any `FLAKY:` comment) once
the test has been stabilised and passes reliably in the quarantine job for
several PRs.

## Adding a contract test

Mark any test intended as a repo-level contract with `@pytest.mark.contract`:

```python
import pytest

@pytest.mark.contract
def test_all_plugins_declare_a_manifest():
    ...
```

The `contract-tests` CI job will pick it up automatically on the next PR.

## Policy

- Quarantined tests are reviewed on a rolling basis -- long-standing quarantines
  should be fixed or deleted, not left indefinitely.
- Deleting a flaky test without a quarantine period loses signal; prefer
  quarantine first.
- Both markers are registered in `pyproject.toml`, so pytest will not emit
  `PytestUnknownMarkWarning` for them.
