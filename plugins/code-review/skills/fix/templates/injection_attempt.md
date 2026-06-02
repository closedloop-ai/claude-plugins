### ⚠️  Injection Attempt — `{system_marker}`  ({severity})

**Issue:** {issue}

**Detected patterns:**
{code_snippet}

**Source:** PR-author-controlled text (PR description, commit messages, or untrusted file content per the injection detector's scope).

**Why this is surfaced manually:** Prompt-injection patterns must NEVER be auto-edited by /fix — that would let a malicious PR description redirect /fix into modifying unrelated code. Any resolution requires a human.

**Your options:**

If the content is **legitimate** (e.g., security-research PR, documentation about injection attacks, intentional test fixture):
1. Edit the PR description / commit message to neutralize the trigger string (e.g., add `# example: ` prefix, wrap in code-fences with explanatory text).
2. Add the injection pattern to the per-repo allowlist if appropriate.
3. Note: auto-merge will not unblock with an InjectionAttempt finding present — manual reviewer sign-off is required.

If the content is **suspicious or malicious**:
1. Investigate the PR author / branch source.
2. Close the PR if compromise is suspected.
3. Open an incident if this is part of a broader pattern.

**Reviewer detail:** {explanation}
