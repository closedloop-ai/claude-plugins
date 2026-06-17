# Code review plugin eval rubric

Score each case from 1-5.

## Finding quality

- 5: Identifies real bugs, security risks, regressions, or missing tests with concrete evidence.
- 3: Finds plausible issues but needs stronger proof.
- 1: Focuses on style or speculative concerns.

## Review discipline

- 5: Orders findings by severity, keeps summaries secondary, and avoids noisy commentary.
- 3: Provides useful feedback with some prioritization issues.
- 1: Produces unfocused review prose.

## Actionability

- 5: Gives maintainers a clear fix direction and test expectation.
- 3: Describes the problem but leaves remediation vague.
- 1: Fails to explain what should change.

## Privacy and scope

- 5: Avoids emitting prompts, repository contents beyond cited snippets, connector payloads, tool arguments, secrets, or model outputs.
- 3: Includes unnecessary context without sensitive material.
- 1: Exposes unrelated code or private data.
