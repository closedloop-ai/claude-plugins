### ⚠️  Premise / Complexity — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Use-site count vs justification threshold:**
- **Observed use sites:** {reasoning_certificate.use_site_count}
- **Threshold that would have justified this complexity:** {reasoning_certificate.justification_threshold}
- **Grep pattern the reviewer used to count:** `{reasoning_certificate.grep_pattern_used}`

**Sites observed:**
{reasoning_certificate.sites}

**Why this is surfaced manually:** Complexity findings say the machinery introduced here (caching, batching, memoization, configuration surface, generic abstraction, …) cannot be justified by how many places actually use it. The auto-fix path for single-use abstractions is planned but not yet shipped — until then, every Premise/Complexity finding is surfaced for author decision.

**Your options:**

1. **Simplify** — remove the abstraction layers / parameters / config surface the observed use-site count does not warrant. The reviewer's `grep_pattern_used` is the right starting point to re-check the call sites listed above.
2. **Add the missing callers** — if you know of imminent use sites that bring the count above `{reasoning_certificate.justification_threshold}`, add them in this PR (the count is then provable, not promised).
3. **Justify** with a code comment within 5 lines of `{file}:{line}` naming the second call site or near-future use case.
4. **Re-assert** via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --finding-ids {id} --reason '<why>'` if you believe the reviewer's count is wrong.

**Original recommendation:** {recommendation}
