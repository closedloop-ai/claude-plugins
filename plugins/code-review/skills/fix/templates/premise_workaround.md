### ⚠️  Premise / Workaround — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Root cause:**
- **Location:** {reasoning_certificate.root_cause_location}
- **Ownership:** {reasoning_certificate.root_cause_ownership}
- **Workaround class:** {reasoning_certificate.workaround_class}

**Why this is surfaced manually:** The reviewer believes this change works around a problem instead of addressing the root cause. Auto-fixing the root cause is out of scope for /fix — that change usually belongs in a separate PR.

**Your options:**
1. **Address the root cause** at `{reasoning_certificate.root_cause_location}` — preferred when ownership is the same team and the change is bounded.
2. **Document the workaround** in the PR description with a link to a tracking issue / PR that addresses the root cause.
3. **Justify** by adding a code comment within 5 lines of `{file}:{line}` if the workaround is the intentionally final state.
4. **Re-assert** via `re-assert --cr-dir <CR_DIR> --finding-ids {id}`.

**Original recommendation:** {recommendation}
