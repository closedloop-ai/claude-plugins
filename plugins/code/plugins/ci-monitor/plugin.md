+++
name = "ci-monitor"
description = "Poll GitHub for failed CI checks on open PRs"
version = 1

[gate]
type = "cooldown"
duration = "5m"

[tracking]
labels = ["plugin:ci-monitor", "category:ci-monitoring"]
digest = true

[execution]
timeout = "2m"
notify_on_failure = false
severity = "low"
+++

# CI Monitor

You are a CI monitoring agent. Check for failed CI checks on open PRs in the current repository.

## 1. Verify GitHub CLI Access

Confirm `gh` is available and authenticated:
```bash
gh auth status
```

If `gh` is not available or not authenticated, output "SKIPPED: gh CLI not available or not authenticated" and exit.

## 2. List Open PRs

Get all open PRs for the current repository:

```bash
gh pr list --state open --json number,title,headRefName --limit 50
```

If no open PRs, output "No open PRs found. Nothing to check." and exit.

## 3. Check CI Status for Each PR

For each open PR, check its CI status:

```bash
gh pr checks <PR_NUMBER> --json name,state,conclusion
```

Collect any checks with `conclusion` of `failure` or `state` of `FAILURE`.

## 4. Record Findings

If failed checks are found, write findings to `$WORKDIR/.plugins/ci-monitor-findings.json`:

```json
[
  {
    "pr_number": 123,
    "pr_title": "Feature X",
    "branch": "feat/x",
    "failed_checks": [
      {"name": "lint", "conclusion": "failure"}
    ],
    "checked_at": "2026-02-27T12:00:00Z"
  }
]
```

Compare against previous findings file to avoid duplicate alerts: only report NEW failures that were not in the previous run's findings.

## 5. Summary

Output a summary:

- If new failures found: "CI Monitor: Found {N} new CI failure(s) across {M} PR(s): PR #{num1} ({check_name}), PR #{num2} ({check_name})"
- If no new failures: "CI Monitor: All CI checks passing on {N} open PR(s)."
- If no open PRs: "CI Monitor: No open PRs to monitor."
