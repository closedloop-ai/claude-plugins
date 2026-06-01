### ⚠️  Premise / Workaround — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Root cause** (per the reviewer's `workaround` certificate):
- **Location:** `{reasoning_certificate.root_cause_location.file}:{reasoning_certificate.root_cause_location.line}`
- **Ownership:** {reasoning_certificate.root_cause_ownership}
- **Why not fixed at the source:** {reasoning_certificate.why_not_fixed_at_source}

**Why this is surfaced manually:** The reviewer believes this change works around a problem instead of addressing the root cause. Auto-fixing the root cause is out of scope for `/fix` — that change usually belongs in a separate PR.

**Your options:**

1. **Address the root cause** at `{reasoning_certificate.root_cause_location.file}:{reasoning_certificate.root_cause_location.line}` — preferred when ownership is `in-repo` (the certificate's `why_not_fixed_at_source` should be empty in that case; any non-empty value is the workaround justification).
2. **Document the workaround** in the PR description with a link to a tracking issue / follow-up PR that addresses the root cause.
3. **Justify** with a code comment within 5 lines of `{file}:{line}` if the workaround is the intentional final state.
4. **Re-assert** via `re-assert --cr-dir <CR_DIR> --finding-ids {id}` if the analysis is wrong.

> Note: the Premise prompt only emits actionable workaround findings when `root_cause_ownership == "in-repo"`. If you see `upstream-dep` or `external-service` here, the reviewer should have discarded the finding — flag this as a Premise prompt regression.

**Original recommendation:** {recommendation}
