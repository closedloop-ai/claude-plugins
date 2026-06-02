### ⚠️  TestQuality / Bug-Locking — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Why this is surfaced manually:** The test verifies a behavior that may itself be buggy. Auto-fixing is unsafe — the system cannot determine which behavior is correct (the test's current expectation, or what the production code should actually do).

**Your options:**
1. **Confirm the test is correct** — the behavior under test really is what the production code should do; mark the finding `RE_ASSERTED` and proceed.
2. **Confirm the production code is correct** — update the test's expectation to match the real behavior.
3. **Both wrong** — investigate the original requirement, then update both.

**Reasoning the reviewer gave for flagging:**
{explanation}

**Original recommendation:** {recommendation}
