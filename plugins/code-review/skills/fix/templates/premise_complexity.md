### ⚠️  Premise / Complexity — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Stated motivation:** {reasoning_certificate.stated_motivation}
**Delivered scope:** {reasoning_certificate.delivered_scope}
**Complexity delta:** {reasoning_certificate.complexity_delta}

**Why this is surfaced manually:** Complexity findings either say the change does **more** than its stated motivation justifies (over-complexity) or **less** (under-complexity). The auto-fix path for single-use-abstraction over-complexity is planned but not yet shipped — until then, every Premise/Complexity finding is surfaced for author decision.

**Your options (depending on direction):**

If **over-complexity** (delivered scope > stated motivation):
1. **Simplify** — remove the abstraction layers / parameters the motivation does not require.
2. **Expand the motivation** in the PR description with the additional goals.
3. **Justify** with a code comment naming the second-call-site or near-future use case.

If **under-complexity** (delivered scope < stated motivation):
1. **Extend the change** to deliver the rest of the stated goals.
2. **Scope as staged work** — add to PR description: `This PR delivers [scope]. Remaining goals: [issue or PR reference].`

Either way, **re-assert** is available via `re-assert --cr-dir <CR_DIR> --finding-ids {id}`.

**Original recommendation:** {recommendation}
