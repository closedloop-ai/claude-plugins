### ⚠️  TestQuality / Test-Deletion — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Why this is surfaced manually:** Tests were removed without the corresponding production code being removed. May be intentional (test was wrong, replaced, or no longer relevant), but auto-restoring is unsafe — the operator must confirm intent.

**Your options:**
1. **Intentional removal** — add a line to the PR description explaining why the test(s) were removed and what (if anything) replaces them.
2. **Unintentional** — restore the deleted test(s), or write a replacement that covers the same behavior.

**Reviewer detail:**
{explanation}

**Original recommendation:** {recommendation}
