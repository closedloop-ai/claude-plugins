### ⚠️  ImpactAnalysis / {subcategory} — `{file}:{line}`  ({severity})

**Anchor change in this PR:**
{issue}

**Explanation:**
{explanation}

**Affected callsites (external_impact):**
{external_impact_rendered}

**Why this is surfaced manually (for now):** The dedicated multi-callsite update flow ships with **PLN-726 — Cross-File Impact Analysis**. Until PLN-726 lands, /fix does not auto-edit untouched files outside the PR diff — it lists the affected callsites here for the operator to update.

**Even after PLN-726 ships, `semantic_change` findings stay manual:** behavioral changes (return value semantics, side-effect ordering, error handling shape) need human judgment about whether consumers are okay with the new behavior, not just a callsite-syntax update.

**Your options:**
1. **Update each callsite** listed above to match the new shape / behavior.
2. **Document the behavioral change** if consumers can adapt — add a note to the PR description and (if applicable) a CHANGELOG entry.
3. **Re-assert** via `re-assert --cr-dir <CR_DIR> --finding-ids {id}` if the impact analysis is overreaching.

**Original recommendation:** {recommendation}
