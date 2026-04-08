# PR Validation Gates (FEA-107)

This repo runs standardised PR validation gates on every pull request. The gates
live in `.github/workflows/ci.yml`.

## Gate matrix

| Job                                | Command                               | Blocking? |
| ---------------------------------- | ------------------------------------- | --------- |
| `Lint`                             | `ruff check .`                        | yes       |
| `Type Check`                       | `pyright`                             | yes       |
| `Tests`                            | `pytest plugins/ -m 'not quarantine'` | yes       |
| `Contract tests`                   | `pytest plugins/ -m contract`         | yes       |
| `Quarantined tests (non-blocking)` | `pytest plugins/ -m quarantine`       | **no**    |
| `PR gates`                         | aggregates the four blocking jobs     | yes       |

Every job installs dev dependencies via `pip install -r requirements-dev.txt`
followed by `pip check`, which validates the resolved dependency graph is
internally consistent. This satisfies FEA-107 AC-004.1 ("lockfile consistency
check; install must succeed without warnings or missing packages").

`requirements-dev.txt` is bumped manually. See the header comment in that
file for the regeneration procedure.

The `Contract tests` and `Quarantined tests` jobs treat pytest exit code 5
("no tests collected") as success so they pass vacuously until tests are
marked.

See [`flaky-test-quarantine.md`](./flaky-test-quarantine.md) for the
`@pytest.mark.quarantine` and `@pytest.mark.contract` conventions.

## Updating branch protection

Ruleset `13555155` currently has **zero** required status checks. After a test
PR confirms the new gates are reporting, add this rule:

```bash
# 1. Fetch the current ruleset JSON
gh api repos/closedloop-ai/claude-plugins/rulesets/13555155 > /tmp/plugins-ruleset.json

# 2. Edit /tmp/plugins-ruleset.json -- add a new entry to the "rules" array:
#    {
#      "type": "required_status_checks",
#      "parameters": {
#        "strict_required_status_checks_policy": false,
#        "do_not_enforce_on_create": false,
#        "required_status_checks": [
#          { "context": "Lint",           "integration_id": 15368 },
#          { "context": "Type Check",     "integration_id": 15368 },
#          { "context": "Tests",          "integration_id": 15368 },
#          { "context": "Contract tests", "integration_id": 15368 },
#          { "context": "PR gates",       "integration_id": 15368 }
#        ]
#      }
#    }

# 3. Apply
gh api -X PUT repos/closedloop-ai/claude-plugins/rulesets/13555155 \
  --input /tmp/plugins-ruleset.json
```

Verify with:

```bash
gh api repos/closedloop-ai/claude-plugins/rules/branches/main \
  | jq '.[] | select(.type=="required_status_checks").parameters.required_status_checks'
```

**Do not update the ruleset until the new check contexts have been observed on
at least one PR run.** Otherwise PRs will hang waiting for a context that does
not yet exist in the workflow history.
