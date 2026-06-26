---
name: present-local
description: Render the operator-facing local-mode code review results at stage_29_present. Covers BLOCKING/HIGH/MEDIUM section templates, Justified Findings (PLN-721), Dismissed Findings (PLN-722), Verifier Stats footer (PLN-773), operator-flag descriptions, override precedence rule for stage_22b, Validation Summary, and final Summary. Invoke when MODE=local AND stage_29_present is reached. Do NOT use for GitHub mode — see prompts/github-review.md. Do NOT use for Gate A hygiene-only early-exit — that path is mode-agnostic and remains in start.md alongside the Gate A definition.
---

# Local-Mode Code Review Presenter

This skill is the canonical presenter for `/code-review` local mode at `stage_29_present`. It is split out of `commands/start.md` so the orchestration spine stays lean; the orchestrator invokes it when `MODE=local` and `stage_29_present` is reached.

Gate A hygiene-only early-exit is **not** in this skill. That path is mode-agnostic (fires for both `MODE=local` and `MODE=github`) and the hygiene presentation lives in `start.md` adjacent to the Gate A definition — the orchestrator handles it inline, not via this skill.

---

## Local Mode: Present Results (stage_29_present, MODE=local)

Mark "Present findings by severity" `in_progress`.

Render the report below. Three text conventions run through this template, so it stays clear which lines you emit verbatim and which are directions to you:

- **`##` section headers** (Repo Hygiene, BLOCKING, …) are the report's own structure — emit them as written, with the live `[count]` substituted.
- **Fenced code blocks** are card/footer templates — instantiate one per finding (or per stat block), substituting the `{PLACEHOLDER}` and `[bracketed]` fields.
- **`[bracketed]` and `{BRACED}` tokens** are instructions or substitution points, never literal output.

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
```

**Reviewer Fleet block (PLN-725 Phase 9 / v2.23.0).** Do NOT write the Reviewers / Model Routing / Fleet lines from scratch. Run the canonical renderer and embed its output verbatim:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py" render-fleet-summary --cr-dir <CR_DIR>
```

The renderer consumes `<CR_DIR>/spawn.json` (sections: `spec` — intended fleet from stage_19b; `verification` — runtime tally from stage_20b; `route` — model assignments from Gate B). The output is a deterministic markdown block of 2–9 lines — 2–4 for the core **Reviewers** / **Model Routing** / **Fleet** section, plus up to 5 conditional note bullets — covering:

- **Reviewers** — the actual fleet that spawned (with the rule-resolved vs LLM-proposed split surfaced on domain critics so the operator can tell operator-configured coverage apart from one-off LLM proposals).
- **Model Routing** — the per-agent model assignments derived from `spawn.json.route`.
- **Fleet** — `N intended | N ran | N required missing` so the operator sees the runtime tally without scrolling to Verifier Stats.
- **Notes (conditional)** — only emitted when the run was non-default: BLOCKING-sanitized arbitration, missing required reviewers (runtime crash), BHA partitions capped by post-arbitrate budget, PLN-723 deferral, malformed-plan required skips. Each note is a single bullet so the section stays scannable; multiple notes can fire together.

Embed the renderer's output verbatim where the prior static Reviewers/Model Routing block would have appeared (between the `**Files Reviewed:**` line and the next `---` separator). Do NOT hand-author a separate Reviewers line — the renderer is the single source of truth for fleet composition.

**Fallback:** if the renderer reports `spawn-spec unavailable` or `spawn-spec fell back`, the orchestrator walked the static reviewer table in the `code-review:spawn-reviewers` skill for this run. The renderer says so explicitly; embed its line as-is and rely on the static reviewer table in the `code-review:spawn-reviewers` skill for what the fleet looked like at dispatch time.

**Fast-path runs** are handled by the renderer too — it emits the `Fast Path Reviewer (single-agent mode)` line + the resolved fast-path model. No branch needed in this skill.

Then continue with:

---

## Repo Hygiene ([count])

[List any hygiene findings from deterministic checks]

```markdown
### Finding Title
**File:** `path/file.ts:line`
**Issue:** [description]
**Recommendation:** [fix]
```

---

## BLOCKING ([count])

[List all blocking issues]

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]
**Recommendation:** [fix]
```

**Impact Analyzer findings (FEA-1401):** when a finding has
`category: "ImpactAnalysis"` AND non-empty `external_impact[]`,
append an **Affected callsites** block AFTER `Recommendation`:

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** Impact Analyzer
**Issue:** [description]
**Recommendation:** [fix]

**Affected callsites** ({len(external_impact)}):
- `{external_impact[i].file}:{external_impact[i].line}` — {external_impact[i].description} ({external_impact[i].impact_type})
- ...
```

Sort `external_impact[]` entries by `(file, line)` ascending. Cap at
10 displayed; if more, append a pointer line:
`(+{N-10} more — see review_result.json finding.external_impact[])`.

---

## HIGH ([count])

[List all high priority issues — same format, including the
Impact Analyzer **Affected callsites** block when applicable]

---

## MEDIUM ([count])

[List all medium priority issues — same format, including the
Impact Analyzer **Affected callsites** block when applicable]

---

## Justified Findings (PLN-721)

Read `<CR_DIR>/review_result.json` → `justified[]`. If empty, omit the section. If non-empty, render below with collapsible details so the reviewer can audit the justification audit. Cap at 20 displayed; if more, append a pointer line to `review_result.json.justified[]`.

For each justified finding:

```markdown
### [{ORIGINAL_SEVERITY} justified] {FILE}:{LINE} — {ISSUE_HEAD}
**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Verifier verdict:** JUSTIFIED-VALID
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original concern:** [verbatim from finding.issue]

**Author's justification:**
> [verbatim from finding.justification.text]
>
> — cited at `{finding.justification.source}` by `{finding.justification.claimed_by_reviewer}`

**Verifier reasoning:** [verbatim from finding.verifier_reasoning — explains why J1 + J2 both passed]
```

After all justified findings (or the cap), print:

```
ℹ️ {N} finding(s) were emitted by reviewers but absorbed by author justification comments the verifier independently validated. Inspect each; if you disagree with a dismissal, the original concern is preserved in review_result.json.justified[].
```

---

## Dismissed Findings (PLN-722)

Read `<CR_DIR>/review_result.json` → `rejected[]`. If empty, omit the section. If non-empty, render verbose-by-design (humans must evaluate, not skim) and sort BLOCKING dismissals first, MEDIUM last. Cap at 20 displayed; if more, append a pointer line to `review_result.json` for the full list.

For each rejected finding:

```markdown
### [{ORIGINAL_SEVERITY} dismissed] {FILE}:{LINE} — {ISSUE_HEAD}
**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Verifier verdict:** REJECTED (rejection_class: `{REJECTION_CLASS}`)
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original issue:** [verbatim from finding.issue]

**Verifier reasoning:** [verbatim from finding.verifier_reasoning — usually 1-3 paragraphs]

**Evidence checks:**
- ✓ {check.claim} — verified at {check.source}
- ✗ {check.claim} — {check.actual_read} ({check.source})

(If `finding.verifier_verdict == "TENTATIVE"` because of a sensitive-path escalation rather than a true REJECTED → TENTATIVE rewrite, that finding belongs in the primary BLOCKING/HIGH/MEDIUM sections above with a `[verifier uncertain — sensitive path]` annotation, NOT here.)
```

After all rejected findings (or the cap), print:

```
ℹ️ {N} finding(s) were emitted by reviewers but disproved by the verifier with cited evidence. Inspect each; if you disagree with a dismissal, the original finding is preserved in review_result.json.rejected[].
```

If `review_result.json.pending_verification[]` is non-empty, append a one-line note:

```
⚠️ {M} finding(s) were eligible for verification but no verifier output landed on disk (agent timeout or budget overflow). Treat them as unverified and re-review by reading review_result.json.pending_verification[].
```

---

## Verifier Stats (PLN-773)

Read `<CR_DIR>/review_result.json` → `stats.verification`. Render the footer below verbose-by-design — operators read the per-reviewer FP rate to detect over-rejection (a reviewer hallucinating findings the verifier then discards).

```
=== Verifier Stats ===
Findings verified: {stats.verification.verified_count}
  - CONFIRMED + DOWNGRADE: {verified_count - tentative_count - re_asserted}
  - TENTATIVE:             {tentative_count}
  - RE_ASSERTED:           sum over by_reviewer[].re_asserted
Findings dismissed: {stats.verification.rejected_count}
Findings justified: {stats.verification.justified_valid_count + stats.verification.justified_invalid_count}
  - JUSTIFIED-VALID:   {stats.verification.justified_valid_count}
  - JUSTIFIED-INVALID: {stats.verification.justified_invalid_count}
Reviewers (FP rate / overrides):
  {reviewer}: {fp_rate:.2f} / {re_asserted}{ "  ⚠ override" if re_asserted > 0 else "" }
Impact gateable count:     {stats.impact_cumulative_count} (gate threshold {impact_cumulative})
Partition mode: {verify_manifest.partition_mode} ({verify_manifest.partition_count} partitions)
```

**Deferred Impact symbols (FEA-1401)** — render this block ONLY when
the Impact Analyzer's `agent_impact.json` carries a non-empty
`deferred_symbols[]` list (cost cap fired, more candidate symbols
existed than the 30-symbol limit allowed). Render after the Partition
mode line. If the file is absent (Impact didn't spawn) or
`deferred_symbols[]` is empty, omit entirely.

```
=== Deferred Impact symbols ({len(deferred_symbols)}) ===
{deferred_symbols[i].symbol} at {deferred_symbols[i].file}:{deferred_symbols[i].line} — {deferred_symbols[i].change_nature}
...
ℹ️ These symbols were identified as candidates but not analyzed due to the 30-symbol cap. Consider re-running on a narrower scope to cover them.
```

Render the **Partition mode** line by reading `<CR_DIR>/verify_manifest.json` → `partition_mode` ("unified" | "partitioned" | "unknown") and `partition_count` (int). The Reviewers block above keys off the `reviewer` field which `cmd_collect_findings` derives from the agent filename (`agent_bha_p0.json` → `reviewer='bha_p0'`), so BHA naturally appears as one bucket per partition under partitioned mode and a single `bha_p0` bucket under unified mode (only one partition exists). Defensive: if `verify_manifest.json` is missing (pre-PLN-774 cache or hygiene-only run), omit this line — do NOT fabricate a value.

If the verify-prepare manifest carried `override_hits` (operator `--re-assert` honored) or `override_invalidated` (override rejected on file-content drift), echo a one-line summary:

```
ℹ️ Overrides: {len(override_hits)} honored / {len(override_invalidated)} invalidated (content drift).
```

### Operator flags affecting the presenter (PLN-773)

- **`--justified-only`** — when present, render ONLY the Justified Findings section above. Suppress BLOCKING / HIGH / MEDIUM / Dismissed sections so the operator can audit justification usage without scrolling past every finding.
- **`--re-assert <id>[,<id>...]`** — write operator overrides for the listed finding IDs via `code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids <ids> [--reason '<why>']`. Promotes from `rejected[]` / `pending_verification[]` back into `verified[]` on the next run. Persists across runs via `<CACHE_DIR>/overrides/<finding_id>.json` keyed on file-content hash — content drift auto-invalidates the override.
- **`--review-dismissed`** — fetch a second opinion (haiku verifier) on prior `rejected[]`. Run `review-dismissed-prepare` to build the manifest, dispatch a haiku-verifier fleet against the per-finding inputs, then run `review-dismissed-consolidate` to auto-promote any non-REJECTED verdict via the same override file format (`override: "REVIEW_DISMISSED"`). Side-by-side diff lands at `<CR_DIR>/review_dismissed_diff.json`.

### Override precedence in stage_22b

When `cmd_verify_prepare` runs with a `--cache-dir`, the precedence is:

1. **`<CACHE_DIR>/overrides/<finding_id>.json`** — operator override. If the file exists and the cited file's content hash still matches, synthesize a `RE_ASSERTED` verdict and skip both the verifications/ cache and the agent spawn.
2. **`<CACHE_DIR>/verifications/<finding_id>.json`** — cached verifier verdict for the `(finding_id, snippet_hash, model, prompt_hash)` tuple. Materialize at the canonical output path and skip the agent spawn.
3. **Agent spawn** — fall through; the orchestrator dispatches a verifier agent for this finding.

Hash drift on an override (file content changed since the override was written) → override invalidated silently (logged in `manifest.override_invalidated[]`); verifier runs normally.

---

## Validation Summary

If `normalization_warnings > 0` in `findings_validated.json`, append this line directly after the summary list below:

```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

- **Total findings from agents:** X
- **Hygiene findings:** H
- **Validated (confirmed):** A
- **Discarded — file not changed:** B
- **Discarded — line not changed:** C
- **Discarded — low confidence:** D
- **Discarded — rejected by validation:** E
- **Duplicates merged:** F
- **Cross-file grouped:** G (findings with `other_locations`)
- **Downgraded to MEDIUM:** I

(Placeholder `I` is intentional — `H` is reserved for "Hygiene findings" above. Reusing `H` here would conflate two distinct counts in the rendered Validation Summary.)

### Discarded Findings
[List discarded findings grouped by discard reason — helps track agent accuracy]

---

## Summary

The Output directory line is mandatory at every stage_29 — there is no "no artifacts" case at present-time. Substitute `[CR_DIR_PATH]` with the actual CR_DIR resolved in stage 0 (typically `.closedloop-ai/code-review/cr-<NNNNN>`) so operators can locate `review_result.json`, agent outputs, manifests, patches, and WIP files from in-progress pipeline phases without scanning the filesystem. Render the template below verbatim:

```markdown
| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

**Recommendation:** [action based on findings]

**Output directory:** `[CR_DIR_PATH]`
```

**Consolidated Finding Format** (when multiple findings share root cause):

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]

**Other Locations** (N more):
- `path/file.ts:87` — same pattern in `functionName()`
- `path/file.ts:124` — same pattern in `otherFunction()`

**Recommendation:** [fix]
```

Mark todo as `completed`.
