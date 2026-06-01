### ⚠️  TestQuality / {subcategory} — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Explanation:**
{explanation}

**Why this is surfaced manually (for now):** Specialized auto-fix for TestQuality findings (`missing-coverage`, `weak-assertion`, `mock-faithfulness`, `missing-edge-case`) is implemented via the `test-engineer` subagent, which ships with **PLN-723 — Test Quality Reviewer**. Until PLN-723 lands, /fix surfaces these findings here for the operator to address by hand.

**Your options:**
1. **Apply the recommendation** by hand — see below.
2. **Re-assert** via `re-assert --cr-dir <CR_DIR> --finding-ids {id}` if you believe the finding is incorrect.

**Recommendation:** {recommendation}

**Tracking:** After PLN-723 ships, this category will dispatch to a `test-engineer` subagent automatically.
