# Changelog

All notable changes to the claude-plugins project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are listed newest-first; each plugin section is treated as released when merged to `main`.

### code-review v2.11.0

#### Added
- **New `code-review:present-local` skill.** Local-mode presenter content (BLOCKING/HIGH/MEDIUM section templates, Justified Findings (PLN-721), Dismissed Findings (PLN-722), Verifier Stats footer (PLN-773), operator-flag descriptions, override precedence rule, Validation Summary, final Summary) moved out of `commands/start.md` into `skills/present-local/SKILL.md`. The orchestrator explicitly invokes the skill at `stage_29_present` when `MODE=local`. Establishes the decomposition pattern for the rest of the start.md monolith (operator-flag skills, fast-path skill, agent-prompts skill — pending follow-up work).

#### Changed
- **`commands/start.md` reduced from 1014 → ~775 lines (~24% smaller).** Pointer block at the former local-mode presenter location scopes the skill invocation to `MODE=local` only. The Gate A hygiene presentation format stays inline in start.md (mode-agnostic — fires in both `MODE=local` and `MODE=github`); only the local-mode `stage_29_present` pipeline is delegated to the skill. No behavior change for operators — the orchestrator still produces the same output.
- **GitHub-mode Validation Stats expanded to mirror local-mode parity.** `prompts/github-review.md` Step 8 previously surfaced only `Agent failures` and `Cross-file grouped` to PR reviewers; the local mode's full discard-reason breakdown (Total / Validated / Discarded by file/line/confidence/validation reason / Duplicates merged / Cross-file grouped / Downgraded to MEDIUM / Hygiene findings) is now also rendered in the GitHub Summary. Operators auditing reviewer accuracy from a PR no longer have to read local logs. Pre-PLN-722 runs (no `findings_validated.json`) fall back to the original two-line stats so back-compat holds.
- **GitHub-mode `--no-verify` audit banner now also prepended to `code-review-summary.md`.** Previously the banner only landed in `code-review-verifier-stats.md` (Step 6e), which the workflow posts as a separate comment with collapsible `<details>`. A PR reviewer reading only the Summary comment could miss that the verifier was bypassed. Step 8 now duplicates the banner onto the Summary file so the audit signal rides the most-visible comment — same content as the verifier-stats banner; intentional duplication.

### code-review v2.10.1

#### Fixed
- **Override hits now reach `verified[]` with `verifier_verdict == "RE_ASSERTED"` end-to-end (PR #114 review, thadeusb — HIGH).** `cmd_verify_prepare` recorded the fid in `override_hits[]` and wrote the synthesized stub on disk, but `cmd_verify_consolidate` only read `agent_verifier_<fid>.json` when the fid was in `to_verify_ids` or `cache_hit_ids`. Override fids matched neither set and fell through as tier-skips with `verifier_verdict=None`. Net effect: every override silently dropped its `RE_ASSERTED` verdict on the integration path, so `stats.verification.by_reviewer[*].re_asserted` always reported 0 even while the footer's `override_hits` line reported N honored — the two numbers openly disagreed in the same report. Consolidate now extracts `override_hit_ids` from the manifest and folds them into the same read-back branch as `cache_hit_ids` (no special-case branch). Cache write-back skips both `cache_hit_ids` AND `override_hit_ids` so a synthesized stub never corrupts the verifications/ cache. Same fix repairs the `--review-dismissed` path since `REVIEW_DISMISSED` overrides ride the same prepare→consolidate channel.
- **`CACHE_TTL_DAYS["overrides"]` (90 days) is now enforced (PR #114 review, thadeusb — MED).** Constant was declared in `code_review_schema.py` but neither `_load_override` nor `_override_is_valid` checked `asserted_at` against it. New `_override_is_expired` helper sweeps on read; both the content-hash and system-scope branches now run through it. Defensive: missing/unparseable `asserted_at` returns "not expired" so pre-fix overrides written without enforcement do not silently drop after upgrade.
- **`cmd_re_assert` no longer silently no-ops on system-scoped findings (PR #114 review, local HIGH).** When a finding had no `file` / `line` (system-scoped reviewer output — e.g. injection-detector, agent-auditor), `_file_content_hash` returned `""` and the resulting override was rejected at promotion time by `_override_is_valid`'s "no hash anchor" guard. New `_OVERRIDE_SYSTEM_SCOPE_SENTINEL = "SYSTEM_SCOPE"` is written for system-scoped findings; `_override_is_valid` honors the sentinel as long as the finding ALSO lacks file/line (defensive — refuses to promote a file-scoped finding via a system-scope override).
- **`cmd_re_assert` now reports `already_dismissed[]` for findings in `justified[]` (PR #114 review, local MED).** Re-asserting a JUSTIFIED-VALID finding silently re-routed it through `verified[]` on the next run, erasing the justification record. New explicit bucket alongside `already_verified[]` so the operator sees the no-op rather than getting a success summary that doesn't match observed behavior.
- **Documented re-assert's best-effort behavior against finding_id drift (PR #114 review, thadeusb — MED).** Finding IDs are `<reviewer>_f<index>` where `<index>` is the reviewer's emission position; across re-runs the LLM may reorder/drop findings so an override written for `bha_f3` on run N may map to a different finding on run N+1. README `Override Flow (PLN-773)` section now spells out the caveat and points operators to inspect `override_hits` / `override_invalidated` in the verify-prepare manifest to confirm the override landed. (No code change — anchoring on a content-stable id would require a wider schema change; mitigations documented inline.)
- **`commands/start.md:889` schema field name (`tentative` → `tentative_count`).** Render template referenced the wrong field name (`stats.verification.tentative` does not exist — the schema's key is `tentative_count`). Now matches `github-review.md:272`.

#### Changed
- **Test helpers `_run_verify_prepare` / `_run_verify_consolidate` accept an optional `cr_dir`.** End-to-end tests that share a `cr` directory between prepare and consolidate can pass the same path to both helpers; defaults preserved for single-phase callers. `_run_verify_prepare` also gains `no_verify` / `no_verify_reason` params so `TestNoVerifyBypass` and `TestOverrideCache` no longer duplicate the per-test stdout-capture + Namespace dance.

#### Added
- **6 new regression tests under `TestPR114ReviewFixes`** covering: end-to-end prepare+consolidate routing override to `verified[]`; per-reviewer `re_asserted` counter increments correctly through both phases; `already_dismissed` no-op against `justified[]` bucket; system-scoped re-assert writes the SYSTEM_SCOPE sentinel and `_override_is_valid` honors it; over-TTL overrides are invalidated; within-TTL overrides still honor (negative control).

### code-review v2.10.0

#### Added
- **PLN-773 — Verifier Override Flow + Premise/Verification Telemetry.** Consolidates the deferred scope from PLN-721 (Phase 7 — Premise telemetry, `--justified-only`) and PLN-722 (Phase 5 — Override Flow, Phase 8 — Verifier Telemetry). Closes the operator-facing surface gaps both prior plans left open: the override flow (so an operator can falsify a wrong dismissal) and the telemetry surface (so the operator can see when the verifier or the justification hatch is misbehaving). Together these are the last orchestrator-side work before 2-round auto-merge is mechanically defensible.
- **`RE_ASSERTED` canonical verdict.** New additive value in `VERIFIER_VERDICTS` (`code_review_schema.py`). A finding with `verifier_verdict: "RE_ASSERTED"` lives in `verified[]` and was promoted there by an operator override (`--re-assert` or `--review-dismissed`), bypassing fresh verification. The override is keyed on file-content hash so content drift auto-invalidates. Schema validator accepts the new verdict via `validate_result_envelope`; envelope round-trip test pins the contract.
- **Override cache namespace (`<CACHE_DIR>/overrides/<finding_id>.json`).** New `_load_override` / `_write_override` / `_override_is_valid` / `_file_content_hash` helpers (`code_review_helpers.py`). `cmd_verify_prepare` checks the overrides namespace BEFORE the verifications/ cache so an operator override short-circuits both the cache check and the agent spawn. Hash drift on the cited line ±20 (matching the verifier prompt's EXISTENCE-check window) auto-invalidates the override; verifier runs normally and the manifest's new `override_invalidated[]` field records the event. Manifest gains `override_hits[]` / `override_invalidated[]` telemetry fields and `total_eligible` now includes override hits.
- **`cmd_re_assert` subcommand (`re-assert`).** `--cr-dir`, `--cache-dir`, `--finding-ids <id>[,<id>...]`, optional `--reason`, optional `--asserted-by`. Reads prior `review_result.json`, locates each finding (in `rejected[]` / `pending_verification[]` / `verified[]`), computes the current file-content hash, and writes an override file. Stdout summary documents which ids were promoted (`re_asserted`), which were no-ops (`already_verified`), and which were not found (`not_found`). Synthesizes a `RE_ASSERTED` verifier output stub so `cmd_verify_consolidate` treats the override as a fresh verdict without a special-case branch.
- **`cmd_review_dismissed_prepare` + `cmd_review_dismissed_consolidate` subcommands.** Two-phase second-opinion flow: prepare writes per-finding inputs at `<CR_DIR>/review_dismissed_inputs/<finding_id>.json` and a manifest pinned to the haiku model (cross-model independence — different from the default sonnet verifier so the second pass gives an independent vote). Consolidate reads the haiku-verifier outputs, auto-promotes any non-`REJECTED` verdict via a `REVIEW_DISMISSED` override (same shape as `--re-assert`, distinguishable by the `override` field), and writes a side-by-side diff to `<CR_DIR>/review_dismissed_diff.json` with `{promoted, no_change, missing_output}` stats. Sensitive-path tags still apply on the new verdict — `mandatory_human_review_paths` still forces TENTATIVE regardless.
- **`--no-verify` emergency-bypass flag on `cmd_verify_prepare`.** Every eligible finding lands in `skipped_no_verification[]` so `cmd_verify_consolidate` routes the whole set to `verified[]` with `verifier_verdict: null`. **Requires `--no-verify-reason='<why>'`** — emergency bypass is never silent; the reason is recorded in the manifest and echoed in the operator-facing footer's audit banner. Manifest gains `no_verify: bool` and `no_verify_reason: str` fields downstream consumers can key on without a missing-key check.
- **Premise telemetry sub-blocks in `review_result.json.stats`** (closes PLN-721 Phase 7):
  - `stats.justification` — `rate` (justified / total Premise), `rejection_rate` (JUSTIFIED-INVALID / total justified), `total_premise`, `justified_emitted`, `justified_valid`, `justified_invalid`, `threshold_alert` (true when `rate > justification_rate_alert`). NaN-safe: empty inputs return zeros. JUSTIFIED-VALID in `justified[]` AND JUSTIFIED-INVALID in `verified[]` both count for the denominator.
  - `stats.by_subcategory` — counts of Premise findings in `verified[]` partitioned by `subcategory`. Pinned to the canonical four (`necessity`, `cohesion`, `workaround`, `complexity`); typos in reviewer output are silently dropped so a single misspelling cannot pollute the bucket set.
  - `stats.verification.by_reviewer` — per-reviewer `{verified, rejected, re_asserted, fp_rate}` where `fp_rate = rejected / (verified + rejected)` and `re_asserted` counts overrides honored on this run. The inverse health metric: a high `fp_rate` AND high `re_asserted` flags reviewers operators are correcting back.
- **`justification_rate_alert` config knob in `verdict-thresholds.json`.** Default `0.30` (PLN-721 §Telemetry — "if > ~30%, authors likely gaming the hatch"). Float in `[0.0, 1.0]`; values outside the range or wrong type fall back to the default. `_load_verdict_thresholds` gains polymorphic per-key validation (int with `≥ 1` floor for `premise_cumulative_medium`, float with range for `justification_rate_alert`).
- **Pending-learnings jsonl writers with `fcntl.flock`.** New `_pending_learnings_append` helper serializes appends so N concurrent runs each get exactly one well-formed JSON line per event — no corruption, no interleaving. `cmd_verify_consolidate` appends to `.closedloop-ai/pending-learnings/premise-justifications.jsonl` for every JUSTIFIED-INVALID verdict so `self-learning:process-learnings` can tune the verifier's J2 (responsiveness) threshold over time. `cmd_re_assert` appends to `.closedloop-ai/pending-learnings/verifier-overrides.jsonl` for every override so over-rejection patterns per reviewer become observable. Best-effort: failure to write does not affect the verdict path. Tests pin concurrent-write safety with 10 threading.Thread writers and assert all 10 thread_ids land exactly once with no JSON corruption.
- **Verifier Stats footer in local-mode presenter** (`commands/start.md`). New section below Dismissed Findings rendering per-reviewer FP rate + override counters, the justification rate + rejection rate, and the Premise MEDIUM cumulative count vs threshold. Audit banner for `--no-verify` runs (with the operator-supplied reason). One-line override telemetry summary when `override_hits` or `override_invalidated` are non-empty.
- **Operator-flag documentation in `commands/start.md`.** New subsection documenting `--justified-only` (presenter filter), `--re-assert` (calls `re-assert` subcommand), `--review-dismissed` (two-phase haiku second-opinion), `--no-verify` + `--no-verify-reason` (emergency bypass), plus mutual-exclusion enforcement and the override precedence rule for stage_22b (overrides/ checked BEFORE verifications/).
- **Step 6e in `prompts/github-review.md`.** Writes `.closedloop-ai/code-review-verifier-stats.md` with a collapsible `<details>` block carrying the same stats as the local-mode footer. Posted as a single comment so the metrics are visible to PR reviewers without polluting inline comments. Audit banner for `--no-verify` runs prepended outside the `<details>` for visibility.
- **README Configuration + Override Flow sections** documenting `justification_rate_alert` and the three new operator flags. Cross-references to `verification-gates.json` (PLN-722) so all operator-tunable knobs live under one section.
- **Autouse pytest fixture `_isolate_pending_learnings` (conftest.py)** redirects the module-level pending-learnings base dir to `tmp_path` for every test so the suite cannot pollute the real repo's `.closedloop-ai/pending-learnings/` directory. Caught during Phase 6 by an integration test that accidentally wrote a real event file; the fixture prevents the regression class entirely.
- **40+ new tests** across schema (RE_ASSERTED enum + sub-block round-trip), telemetry stats (NaN-safe edge cases, threshold toggle, by_subcategory canonical-only buckets, per-reviewer FP rate + RE_ASSERTED counting), override cache (file-hash stability + drift, write/load round-trip, valid-vs-drift, verify-prepare short-circuit + fall-through), `--no-verify` (reason-required gate, all-skipped routing, false-flag default-empty audit fields), `re-assert` (promote from rejected, no-op when verified, not-found, empty-id error, multi-id batch), `--review-dismissed` (haiku manifest, auto-promote, no_change, missing_output), pending-learnings (single-line append, multi-call, parent-dir creation, concurrent safety, end-to-end JUSTIFIED-INVALID wiring).

#### Fixed
- **Rule 4 (cumulative Premise MEDIUM) no longer excludes `JUSTIFIED-INVALID` findings (PR #113 review, thadeusb).** v2.9.0 and v2.9.1 treated `JUSTIFIED-VALID` and `JUSTIFIED-INVALID` symmetrically — both excluded from the gate's count. That was backwards: `JUSTIFIED-VALID` means the verifier *accepted* the author's defense and the finding is dismissed (correctly excluded — lives in `justified[]`, not `verified[]`); `JUSTIFIED-INVALID` means the verifier *refused* the defense and the original concern survives, so it must count toward the gate the same way a plain `CONFIRMED` would. As shipped in v2.9.0/v2.9.1, three MEDIUM Premise findings the author tried to wave off — and the verifier then refused — would not trip the cumulative gate, while three plain MEDIUM findings would. `_count_gateable_premise_medium` now excludes only `JUSTIFIED-VALID`; the docstring spells out the asymmetry. The previous `test_justified_invalid_excluded_from_count` is renamed to `test_justified_invalid_counts_concern_survived` and asserts `NEEDS_ATTENTION`; new `test_valid_vs_invalid_are_asymmetric` pins the per-helper count delta directly. The shared-counter telemetry invariant still holds (Rule 4 and `premise_cumulative_medium_count` agree on the new policy).

### code-review v2.9.1

#### Fixed
- **`verifier_prompt.txt` J1/J2 vs fall-through emission contradiction (PR #113 review MED, CONFIRMED 0.88).** v2.9.0's justification audit instructed the verifier to emit `JUSTIFIED-INVALID` and fall through to the six-check protocol on J1 / J2 failures, but the "After the justification audit" block stated the opposite: on the fall-through path the final verdict is whatever the six checks produce (CONFIRMED / DOWNGRADE / TENTATIVE / REJECTED) — **not** `JUSTIFIED-INVALID`. Same contradiction on the Premise subcategory-specific check ("→ JUSTIFIED-INVALID even if J2 looked plausible"). Rewrote J1 / J2 and the Premise subcategory bullet to describe the audit failure state (`J1 fails` / `J2 fails`) without naming a verdict to emit; the "After the justification audit — verdict emission rules" block is now the single source of truth for emission. `JUSTIFIED-INVALID` is reserved in the enum for a future extension; no current code path emits it. Updated the top-of-file role description and the Output Rules block to match.
- **`premise_cumulative_medium_count` telemetry now matches the count Rule 4 fires on (PR #113 review MED, CONFIRMED 0.9).** v2.9.0's Rule 4 verdict gate excluded `verifier_verdict in {JUSTIFIED-VALID, JUSTIFIED-INVALID}` from its count, but the telemetry stat in `_stats_from_findings` did not — operator-reported `premise_cumulative_medium_count` could overcount by 1+ relative to the value Rule 4 actually triggered on, especially in any future scenario where JUSTIFIED-INVALID lands in `verified[]`. Extracted the counting policy into a new module-level `_count_gateable_premise_medium(verified)` helper that owns the exclusion logic; both `_compute_canonical_verdict` Rule 4 and `_stats_from_findings` now delegate to it. New parametrized regression `test_telemetry_count_matches_rule_4_count` pins the invariant across the five `verdicts` shapes (all-CONFIRMED, JUSTIFIED-VALID leak, JUSTIFIED-INVALID leak, DOWNGRADE mix, all-justified) that triggered the divergence.
- **`cmd_verify_consolidate` docstring output-shape no longer omits the `justified[]` bucket (PR #113 review HIGH, CONFIRMED 0.97).** v2.9.0 added the `justified[]` bucket and `justified_count` stat to `findings_verified.json` but did not update the docstring at lines 2007–2024 that documents the output shape. The CLAUDE.md Learned Pattern explicitly flags this: "audit adjacent comments and docstrings for accuracy — remove or update references to non-existent files, incomplete field lists, or scope descriptions narrower than actual behavior." Added `justified` and `justified_count` to the documented shape; clarified that `verified[]` may also carry the reserved (currently unemitted) `JUSTIFIED-INVALID` verdict for future extensions.
- **DRY: extracted `_load_optional_settings_dict` shared frame for operator-settings loaders (PR #113 review MED, CONFIRMED 0.88).** `_load_verdict_thresholds` and `_load_verification_gates` shared ~70% structural similarity — both checked `if path is None: return defaults`, called `_read_optional_json(path, None)`, gated on `isinstance(data, dict)`, built a fresh defaults copy, then iterated canonical keys. The new helper owns "open optional operator JSON, return `(data_or_None, fresh_defaults_copy)`"; each loader layers per-key validation on top. No behavior change — the v2.9.0 contract is preserved byte-identically.

### code-review v2.9.0

#### Added
- **PLN-721 — Premise Reviewer Hardening (Option B slice).** Restructures the Premise Reviewer around four well-defined subcategories — `necessity` (non-existent bug fix / fictional threat model / regressive fix), `cohesion` (duplicate abstraction / naming drift / layering violation), `workaround` (symptom suppression / caller-side normalization with an identifiable in-repo root cause), and `complexity` (machinery whose use-site count cannot justify it). Every Premise finding must now emit a `reasoning_certificate` whose `kind` matches its `subcategory` and whose fields document the claim chain (e.g., `necessity.counter_evidence[]`, `cohesion.prevailing_pattern.examples[]` ≥ 5 (≥ 1 for duplicate-abstraction), `workaround.root_cause_location`, `complexity.use_site_count` + `sites[]`). Findings without a populated certificate matching the subcategory are rejected by the verifier as malformed.
- **New `premise_prompt.txt` per-run asset.** The Premise Reviewer's prompt is now an external asset on the same contract as `verifier_prompt.txt` — `cmd_prep_assets` copies it from `tools/prompts/premise_prompt.txt` to `<CR_DIR>/premise_prompt.txt`, and `cmd_compute_hashes` gains an optional `--premise-prompt` flag that folds its bytes into `<PROMPT_HASH>` so prompt edits bust both the BHA cache and the `verifications/` cache namespace. Back-compatible: callers that omit the flag produce a hash byte-identical to v2.8.1. `start.md` Reviewers table and both Premise prompt blocks (standard flow and Fast Path) now delegate to the asset instead of inlining the prose. `shared_prompt.txt` advertises the optional `subcategory`, `reasoning_certificate`, `justified`, and `justification` canonical fields with a note that the validator preserves them through the pipeline.
- **MEDIUM allowance + cumulative-3 verdict gate (Rule 4).** Premise findings may now be emitted at MEDIUM (P2) in addition to BLOCKING/HIGH — a single MEDIUM does not block, but ≥ 3 verified MEDIUM Premise findings on the same PR trigger `NEEDS_ATTENTION` even when no individual finding is HIGH. The threshold is operator-tunable via the new `.closedloop-ai/settings/verdict-thresholds.json` config (key: `premise_cumulative_medium`, default `3`). `_compute_canonical_verdict` gains an optional `thresholds` kwarg; both `cmd_finalize_result` and `cmd_verdict`'s fallback path load thresholds via the same default-or-override pattern as `verification-gates.json`, so the gate behaves consistently across both entry points. The gate counts only `verified[]` findings and excludes any whose `verifier_verdict` is `JUSTIFIED-VALID` / `JUSTIFIED-INVALID`; DOWNGRADE findings count at their corrected severity (consistent with v2.8.1's `_merge_verifier_fields` reconciliation).
- **Justification Escape Hatch + verifier justification audit.** Reviewers (Premise and any other category) may flag a finding with `justified: true` and a populated `justification` object when the author left an inline comment, PR body paragraph, or commit message that directly addresses the specific concern. Findings carrying a justification are NOT discarded by the reviewer — instead, the verifier runs a dedicated audit pass BEFORE the six standard checks: J1 (existence — the cited source actually contains the claimed comment) and J2 (responsiveness — the justification engages with the specific failure mode, not a generic disclaimer). Premise findings get extra subcategory-specific strictness (e.g., a `complexity` justification must cite expected near-term use-site growth). Two new verifier verdicts: `JUSTIFIED-VALID` (audit passed; finding lands in `envelope.justified[]` for transparency but does not block or escalate) and `JUSTIFIED-INVALID` (audit failed; finding stays in `verified[]` with original severity — or the verifier may fall through to the six-check protocol and emit whatever it produces). `cmd_verify_consolidate` routes `JUSTIFIED-VALID` into a new `justified[]` bucket at the consolidate boundary; `cmd_finalize_result` populates `envelope.justified[]` from that bucket; the `stats.by_reviewer` aggregation gains a `justified` counter; the consolidate stats block gains `justified_count`. Sensitive-path tags (`mandatory_human_review_paths` etc.) outrank both JUSTIFIED-* verdicts — the operator's "always-tentative" tag wins and the finding is escalated to TENTATIVE regardless.
- **Justified Findings output surface.** `start.md` gains a `## Justified Findings (PLN-721)` presenter section in local mode, rendered verbose-by-design (operator must see what the verifier let through on the author's defense), capped at 20 displayed with a pointer to `review_result.json.justified[]` for overflow. `github-review.md` gains Step 6d that writes `.closedloop-ai/code-review-justified.json` and `.closedloop-ai/code-review-justified-summary.md` with collapsible `<details>` blocks per finding; the workflow posts these as a separate "ℹ️ N findings justified by author" PR comment so they do not pollute inline review comments. Both surfaces note the sensitive-path interaction explicitly: a finding lifted from `JUSTIFIED-VALID` to `TENTATIVE` by a sensitive-path tag appears in the primary BLOCKING/HIGH/MEDIUM sections with a `[verifier uncertain — sensitive path]` annotation, NOT in the Justified Findings section.
- **README Configuration section.** `plugins/code-review/README.md` gains a `## Configuration` section documenting `verdict-thresholds.json` (PLN-721 key + effect + default + disable trick) and a cross-reference to `verification-gates.json` (PLN-722). All operator-tunable knobs now live under `.closedloop-ai/settings/`; absent or malformed files fall back to built-in defaults.

### code-review v2.8.1

#### Fixed
- **Sensitive-path BLOCKING severity cap is no longer dead code (PR #111 review HIGH #1, bha_p0).** `cmd_verify_consolidate`'s sensitive-path escalation set `finding["verifier_severity"] = "HIGH"` on a REJECTED-BLOCKING-then-escalated finding but left `finding["severity"]` as `"BLOCKING"`. `_compute_canonical_verdict` reads `severity` (not `verifier_severity`) for Rule 2's BLOCKING short-circuit, so the escalated finding still routed to `CHANGES_REQUESTED` — much stronger than a REJECTED-then-escalated finding should ever produce, and the documented HIGH cap had no effect on the verdict. Now lowers both canonical `severity` and `verifier_severity` on escalation. New verdict-level assertion in `test_sensitive_path_escalates_rejected_blocking_to_tentative` pins that the escalated finding produces `NEEDS_ATTENTION`, not `CHANGES_REQUESTED`.
- **DOWNGRADE verdict now reconciles canonical severity (PR #111 review HIGH #1 broader scope, bha_p0).** The same `severity` vs `verifier_severity` asymmetry made DOWNGRADE inert at the verdict layer: a verifier knocking BLOCKING down to MEDIUM still left `severity="BLOCKING"`, so Rule 2 short-circuited to `CHANGES_REQUESTED` regardless. The verifier prompt explicitly promises "the finding still counts toward verdict — at the corrected severity"; v2.8.0 broke that promise. `_merge_verifier_fields` now overwrites `severity` when the verdict is DOWNGRADE and `verifier_severity` is in the canonical `SEVERITIES` enum (defense: an invalid `verifier_severity` leaves the original untouched). Two regressions: `test_downgrade_reconciles_canonical_severity` and `test_downgrade_with_invalid_severity_does_not_rewrite`.
- **`tentative_on_paths` gate now handles REJECTED (PR #111 review HIGH #2, bhb).** v2.8.0's inner condition was `verifier_verdict in (None, "CONFIRMED", "DOWNGRADE")` — REJECTED was omitted. A REJECTED finding on a path the operator had flagged for "always-tentative" treatment landed in `verified[]` with `verifier_verdict="REJECTED"` and `rejection_class` intact: simultaneously "disproved" and in the legitimate bucket, triggering `NEEDS_ATTENTION` via Rule 3 while being absent from the Dismissed Findings presenter section. Now treats REJECTED the same way the `sensitive_paths` gate does — converts to TENTATIVE and clears `rejection_class`. New regression test `test_rejected_on_tentative_on_paths_lifts_to_verified`. The doc comment on `_VERIFICATION_GATE_KEYS` was also misleading ("any finding → TENTATIVE") and now spells out the actual per-gate semantics.
- **Verifier cache key now invalidates on `verifier_prompt.txt` edits (PR #111 review HIGH #3, bhb).** v2.8.0's CHANGELOG promised "a prompt rev invalidates everything globally", but `cmd_compute_hashes` only hashed `shared_prompt.txt` + `bha_suffix.txt` — editing `verifier_prompt.txt` left `<PROMPT_HASH>` unchanged, so stale verifier verdicts were served from the `verifications/` cache namespace. Added an optional `--verifier-prompt` flag to `cmd_compute_hashes`; when supplied (always, in the run plan after this fix), the verifier prompt bytes fold into the canonical `prompt_hash`. Back-compatible: callers that omit the flag produce a hash byte-identical to v2.8.0, so existing cache entries stay valid across the upgrade. Run plan now passes `--verifier-prompt <CR_DIR>/verifier_prompt.txt` to `stage_18_compute_hashes`. Two new regressions: `test_verifier_prompt_changes_hash` and `test_omitting_verifier_prompt_matches_pre_v2_8_1_hash`.
- `cmd_finalize_result` docstring referenced a non-existent `--no-verify` flag (PR #111 review MED #4, auditor). Replaced with "verify-prepare/consolidate infrastructure failure". The `--no-verify` override is planned for v2.9.0, not v2.8.x.
- `start.md` § stage_22b note mis-named the verification cap constant (PR #111 review MED #5, auditor). `MAX_VERIFICATIONS = 50` → `VERIFY_MAX_VERIFICATIONS = 50` so the prose matches the actual symbol in `code_review_helpers.py`.
- `test_max_verifications_cap_keeps_highest_priority` comment inverted which IDs get deferred (PR #111 review MED #6 + #9, auditor + bha_p0_p2). The sort key `(-priority_score, finding_id)` is ascending on `finding_id` when priorities tie, so the 10 with the highest IDs get deferred — not the lowest. Comment corrected; added explicit ID-set assertions pinning that `f000–f049` are retained and `f050–f059` are deferred so a future sort change breaks the test loudly instead of silently changing which findings get verified.
- `_make_validated_finding` test factory now delegates to `conftest.minimal_diff_finding` (PR #111 review MED #8, bhb). v2.8.0 rebuilt the same 14+ fields locally, violating the CLAUDE.md learned pattern on delegating to adjacent helpers. The new wrapper only carries the PLN-722-specific overrides (`evidence`, `reasoning_certificate`, severity/confidence/category/source parametrization).
- CHANGELOG v2.8.0 entry referenced the wrong subagent type slug (PR #111 review MED #10, bha_p0_p4). `code:code-review-worker` → `code-review:code-review-worker`. The worker lives in the `code-review` plugin and every authoritative reference (including `start.md:738`) uses the fully-qualified `code-review:` namespace.

### code-review v2.8.0

#### Added
- **PLN-722 — Finding-Verification Pass (Option B slice).** New verifier pipeline between `stage_22_validate` and `stage_25_finalize_result`. Each finding emitted by reviewers gets an independent second opinion from a verifier agent prompted to *falsify* (not confirm) the underlying claim — `REJECTED` requires positive disconfirming evidence; ambiguity defaults to `TENTATIVE`. Findings dismissed by the verifier are never silently dropped; they surface in a `Dismissed Findings` section so humans can falsify the dismissal.
- **`cmd_verify_prepare` helper (stage_22b).** Tier-selects findings per the canonical "What gets verified" table — BLOCKING/HIGH always; MEDIUM with confidence < 0.85 yes; MEDIUM with confidence ≥ 0.85 no; LOW (P3) no; `category: "Hygiene"` no (deterministic producer); `source: "injection-detector"` no (deterministic producer); `category: "Premise"` always (strict adversarial framing). Ranks the eligible set by `severity_weight × confidence`, caps at `VERIFY_MAX_VERIFICATIONS = 50` (≈ $2/PR at current Sonnet pricing) with a deterministic secondary sort by `finding_id`, defers overflow into `pending_verification[]`, and writes (a) `<CR_DIR>/verify_manifest.json` and (b) per-finding input files at `<CR_DIR>/verifier_inputs/<finding_id>.json`. The Verifier Fleet walker section in `start.md` reads the manifest and spawns one `code-review:code-review-worker` Task per `to_verify[]` entry.
- **`cmd_verify_consolidate` helper (stage_24a).** Reads the per-finding `agent_verifier_<id>.json` outputs the Verifier Fleet wrote, applies sensitive-path escalation from `.closedloop-ai/settings/verification-gates.json` (REJECTED on `sensitive_paths` + BLOCKING/HIGH → TENTATIVE with severity capped at HIGH; any finding on `tentative_on_paths` → TENTATIVE; any finding on `mandatory_human_review_paths` → TENTATIVE + `force_human_review: true`), and writes `<CR_DIR>/findings_verified.json` with the bucket-split shape `{verified[], rejected[], pending_verification[], force_human_review, stats}`. Missing fleet outputs degrade to `pending_verification[]` — never silently confirmed.
- **`verifier_prompt.txt` asset.** New top-level prompt asset copied by `stage_02_prep_assets` from `tools/prompts/verifier_prompt.txt` to `<CR_DIR>/verifier_prompt.txt`. Implements the six-check falsification protocol from PLN-722 §Verifier prompt: EXISTENCE / EVIDENCE / GUARD / REACHABILITY / SEVERITY / UNCERTAINTY. Includes the canonical output JSON shape, the `REJECTED requires positive evidence` rule, the rejection_class enum (`evidence_not_found` / `evidence_contradicted` / `guard_exists` / `unreachable`), and the extra-strictness path for Premise findings (re-execute the embedded `reasoning_certificate`'s claim chain independently). `cmd_prep_assets` now copies three assets instead of two; the `prep_assets` stdout summary gains a `verifier_prompt` key.
- **Sensitive-path config (Phase 6).** `.closedloop-ai/settings/verification-gates.json` schema with three keys: `sensitive_paths`, `tentative_on_paths`, `mandatory_human_review_paths`. Bootstrap does NOT auto-generate the file (per `00-discovery.md`); projects create it by hand when they want path-aware verifier escalation. Absent file → empty gates, no escalation, identical to pre-PLN-722 behavior. Glob matching supports `**` recursive segments (`lib/auth/**`, `**/migrations/**`, `**/credentials.*`), `*` non-segment wildcards, and `?` single-char matches; non-string entries in any gate list are dropped silently.
- **`verifications/` cache namespace (Phase 7).** PLN-719 pre-registered the namespace and TTL (30 days); PLN-722 wires it up end-to-end. `cmd_verify_prepare` checks the cache before declaring a finding eligible — on hit, materializes the cached verdict at the canonical `agent_verifier_<id>.json` path and skips fleet spawn, logging the id under `cache_hits[]`. `cmd_verify_consolidate` writes fresh verifier outputs back to the cache (atomic via tmp + rename). Key tuple: `(finding_id, sha256(code_snippet), verifier_model, verifier_prompt_hash)` — so a code change at the cited location invalidates the cached verdict via the snippet hash, and a prompt rev invalidates everything globally. Coarse but correct: false-misses cost a verifier re-spend; false-hits would be a correctness bug.
- **Three-state canonical verdict.** `_compute_canonical_verdict` gains two rules per PLN-722: (rule 2.5) `force_human_review` → `NEEDS_ATTENTION` (sits between BLOCKING and HIGH — BLOCKING still trumps, but HIGH does NOT escalate a force-review-path PR past NEEDS_ATTENTION); (rule 3.5) any verified finding with `verifier_verdict == "TENTATIVE"` → `NEEDS_ATTENTION` (the verifier could not confirm or disprove; the plan calls this out explicitly: "TENTATIVE counts toward NEEDS_ATTENTION (not CHANGES_REQUESTED)"). REJECTED findings live in `envelope.rejected[]` and don't count toward verdict math at all.
- **`cmd_finalize_result` reshuffle.** Prefers `<CR_DIR>/findings_verified.json` (the verify-consolidate output) when present and honors its `force_human_review` flag in the canonical verdict computation; falls back to `findings_validated.json` (everything to `verified[]`, no verifier) when consolidate didn't run (stage_23 disabled, infrastructure failure, or pre-PLN-722 cache hit). The stdout summary gains `rejected_count`, `pending_verification_count`, `force_human_review`, and `used_verifier` keys so operators can see at a glance whether the verifier engaged on a given run.
- **Run plan wiring.** `stage_22b_verify_prepare`, `stage_23_verify_findings` (flipped enabled), and `stage_24a_verify_consolidate` all enabled with `on_failure: continue`. Stage_25_finalize_result depends on stage_24a (was: stage_22_validate). New `test_pln_722_verify_pipeline_enabled_with_pinned_args` pins the wiring; `test_emits_thirty_two_stages` (was: thirty) covers the count change. The `_<NN>_` prefix is a stable label, not a strict ordinal; `_22b_` and `_24a_` mark stages inserted between original ordinals without renumbering downstream.
- **Output surface (Phase 4).** `start.md` gains a `Verifier Fleet (stage_23_verify_findings)` walker dispatch section (mirrors `Reviewer Fleet`) and a `Dismissed Findings` presenter section in local mode. `github-review.md` gains a Step 6c that writes `code-review-dismissed.json` and `code-review-dismissed-summary.md` with collapsible `<details>` blocks per finding, plus a `force_human_review` banner when the gate fires.
- **58 new tests** covering: validate-preserves-evidence + reasoning_certificate (2); `_needs_verification` tier table parametrized × 8 + 4 category/source edges; `_verification_priority` ranking + missing-confidence defense (3); `cmd_verify_prepare` empty/tier/cap/per-finding-inputs/manifest-on-disk/cache-hit (6); `cmd_verify_consolidate` no-manifest/CONFIRMED/REJECTED/TENTATIVE/missing-output/deferred-budget + three sensitive-path gates + cache-writeback (10); `_load_verification_gates` absent/malformed/non-string-dropped/None-path (4) + `_glob_to_regex` parametrized × 12; `_compute_canonical_verdict` PLN-722 rules (4); `cmd_finalize_result` fallback / preference / force_human_review propagation (3).

### code-review v2.7.3

#### Fixed
- `_score_text_for_injection` — capped `html_comment_exfil` (weight 25) at a single match's contribution per scan. Before the fix, `finditer` counted every long `<!-- ... -->` block in the body; GitHub's default PR template ships three instructional comment blocks past 50 chars, which accumulated to 3 × 25 = 75 ≥ `_INJECTION_SCORE_HIGH`, quarantining the PR and emitting a BLOCKING `InjectionAttempt` finding on template boilerplate alone. Introduced `_INJECTION_CLASS_MAX_MATCHES: dict[str, int]`, a per-class cap on how many matches contribute to the score; classes where *presence* is signal but count is not proportionally more dangerous get capped at 1. Classes absent from the map (e.g. `instruction_override`, `system_prompt_forgery`) still accumulate unbounded — multiple `<system>` forgery tokens or repeated "ignore previous instructions" are genuinely more dangerous in proportion. New regression tests `test_github_pr_template_does_not_quarantine` (mimics the default GitHub PR template, asserts severity ≤ low) and `test_html_comment_class_capped_at_single_match` (asserts ten long HTML comments yield exactly one reported match). Surfaced by thadeusb on PR #109 (comment 3325330078).
- `role_reversal` pattern narrowed to require an actor-noun after `act as`. Previous pattern `act\s+as\s+\S` matched any following non-whitespace token — including common PR-description phrasings like "act as a thin wrapper" or "act as the source of truth" — contributing 40 points toward quarantine on benign wording. Replaced with `\bact\s+as\s+(?:an?\s+|the\s+)?(?:AI|LLM|model|assistant|chatbot|agent|expert|admin|root|sysop|sudoer|developer|maintainer|reviewer|approver|owner|operator|moderator|user|hacker|attacker)\b`. The other branches of the alternation (`you are now`, `pretend to be`, `roleplay as`, `from now on you are`) were already specific enough and are unchanged. New regression tests `test_role_reversal_skips_benign_act_as_phrasing` (three benign payloads must not match) and `test_role_reversal_still_matches_persona_injection` (three adversarial payloads must still match). Surfaced by thadeusb on PR #109 (comment 3325332843).
- `_append_injection_audit_log` docstring + constant comment corrected to match implementation. The function was documented as "append-only … sweep-on-read" but actually does read-modify-write on every call (loads all existing lines, filters by TTL, writes them all back along with the new entry) and sweeps on write (the log has no reader — operators read it manually for triage). Two concurrent runs in the same workdir can clobber each other's new entries; this is accepted because the log is observational, not a source of truth. Rewrote the docstring and the constant comment at `_INJECTION_AUDIT_LOG` to spell out the read-modify-write semantics, the sweep-on-write timing, and the concurrent-clobber caveat. No behavior change — implementation was correct, only the docs lied. Surfaced by thadeusb on PR #109 (comment 3325333665).

### code-review v2.7.2

#### Fixed
- `start.md` § Reviewer Fleet — removed the fabricated `partition_patches: { "p0": "...patch text...", ... }` line from the inlined `partitions.json` shape hint. `cmd_partition` writes `partition_patches` as a list of patch filenames (e.g. `["patches_p0.txt", ...]`) emitted by `_write_per_partition_patches`, not a dict keyed by partition id, and it's only present when `--cr-dir` is set. The PR #110 hint that was meant to keep the walker model from guessing wrong instead invented a fourth key with a fabricated shape — a model trusting it would hit a fresh `KeyError` on `data["partition_patches"]["p0"]`. Surfaced by thadeusb in post-merge review of PR #110.
- `test_partitions_json_is_top_level_dict_not_list` now asserts the **exact** top-level key set (`partitions` / `test_file_paths` / `force_merged_count`) instead of just per-key membership. The previous shape (`assert "x" in result` × 3) couldn't catch a new key being added to the inlined shape hint that the producer never writes — which is exactly how the fabricated `partition_patches` dict slipped past the contract test in PR #110. The test harness `_run_partition` constructs the `argparse.Namespace` without `cr_dir`/`workdir`, so the optional `partition_patches` is never produced in this fixture and exact-set equality on the three core keys is safe. Surfaced by thadeusb in post-merge review of PR #110.

### code-review v2.7.1

#### Fixed
- `_append_injection_audit_log` no longer crashes with `AttributeError` when a pre-existing log line is valid JSON but not a dict (e.g. a list, string, number, or `null`). The inner exception tuple was `(ValueError, KeyError, TypeError)` — `obj.get("timestamp")` on a non-dict surfaced `AttributeError` which propagated past it, then past the outer `OSError` guard, then past `cmd_detect_injection`'s own `OSError`-only catch — exiting with an uncaught traceback that contradicted the docstring's "malformed lines are dropped silently" promise. The pipeline's `on_failure: continue` absorbed the crash but the audit-log feature stayed broken on every subsequent run until the file was removed. Added an explicit `isinstance(obj, dict)` guard before the `.get` call. New regression test `test_sweep_handles_non_dict_json_lines` verifies four pathological non-dict JSON values (list, string, number, null) are dropped and the fresh run still appends.
- Selective-redaction comment in `cmd_detect_injection` aligned with actual behavior. Comment had claimed "preserve original title/commits if they were clean — only redact what triggered" but `body` is unconditionally redacted on quarantine regardless of `body_score`. Rewrote to make the asymmetry explicit: `title` and `commits` are preserved when their per-section score is 0; `body` is always redacted because it's the highest-risk surface (longest free-form attacker-controlled text), and a sub-threshold score may still carry signals the catalogue missed. Surfaced via the CLAUDE.md "scope descriptions narrower than actual behavior" mistake pattern.
- `test_malformed_intent_context_returns_empty_report` now actually asserts the contract it promises. Previously the only assertion was `assert rc == 0` — a regression where `cmd_detect_injection` returned 0 but printed nothing (or garbage) would still let the test pass. Now mirrors the sibling `test_missing_intent_context_returns_empty_report` assertions on `report['score'] == 0` and `report['severity'] == 'none'`. While there, replaced ~12 lines of duplicated stdout-capture / cwd-swap boilerplate with the existing `_run_detect_injection` helper (CLAUDE.md "delegate instead of duplicating" pattern).
- `golden_injection_quarantine` fixture's `README.md` listed `intent_context.json` as a pre-baked input, but no such file existed under `inputs/`. Added the file as concrete documentation of the post-quarantine field shape (`title` preserved when clean, `body` redacted, `quarantine: true`, `injection_score`, `injection_severity`). The post-collection harness pipeline doesn't read it, so the existing expected envelope still passes byte-identical — the file is documentation-only, but a fixture reader studying the post-quarantine state will now see the actual JSON instead of a missing-file reference.

### code-review v2.7.0

#### Added
- **PLN-720 — Prompt-Injection Defense.** The first feature plan downstream of the PLN-719 foundation. New `cmd_detect_injection` subcommand scores PR-author-controlled content (PR title, body, commit messages) against a 9-class deterministic regex catalogue — instruction override, role reversal, system-prompt forgery, directive injection, output coercion, tool coercion, encoded payloads, Unicode tag chars (U+E0000–U+E007F), HTML-comment exfiltration. Each pattern carries a weight; matches accumulate to a section score; the total maps through severity tiers `none` (0) / `low` (1–29) / `medium` (30–69) / `high` (70+). Position-aware weighting downweights `>`-quoted lines (citing, not commanding) by 0.5× and content buried past the first 500 chars by 0.75×, matching the imperative-context heuristic from the plan. Foundation pre-stubbed `stage_09_detect_injection` with `enabled: False`; this release flips it to `True` and pins the runtime-args contract (`--cr-dir`, `--intent-context`) via `test_stage_09_detect_injection_enabled_with_pinned_args`.
- **Quarantine semantics.** On severity ≥ Medium, `cmd_detect_injection` rewrites `<CR_DIR>/intent_context.json` in place with `quarantine: true`, `injection_score`, `injection_severity`, and redacted fields using the *real* field names from `cmd_fetch_intent` (`title`, `body`, `commits` — not the v1-draft `description`, `commits: []` shape). `cmd_classify_intent` short-circuits on `quarantine == true` to `{"intent": "mixed", "source": "quarantine"}`, skipping the LLM-classification path entirely so the redacted body never reaches the classifier. On severity ≥ High, the helper writes a canonical `InjectionAttempt` finding to `<CR_DIR>/agent_injection-detector.json`; the `agent_*` naming makes `cmd_collect_findings` pick it up via the standard glob with no new merge wiring required. The finding flows through `normalize_legacy_finding` (which preserves the canonical `source: "injection-detector"` via setdefault) into `review_result.envelope.verified[]`, and the existing canonical verdict precedence routes any BLOCKING `InjectionAttempt` to `CHANGES_REQUESTED`.
- **Audit log.** Append-only JSONL at `.closedloop-ai/injection-log.jsonl`, one entry per `detect-injection` run. Each entry records `timestamp`, `score`, `severity`, `matches` (pattern class names only — *never* the raw payload, to avoid re-amplifying injection content into the log itself), `quarantined`, and `stripped_token_count`. Sweep-on-read TTL of 90 days mirrors PLN-719 Phase 7's cache TTL pattern; malformed pre-existing lines are dropped silently since the log is observational.
- **Reviewer prompt hardening.** `shared_prompt.txt` gains a top-level `<untrusted_content_policy>` block before `<constraints>` that tells every reviewer (BHA, BHB, Auditor, Premise, Domain Critic) to treat `<untrusted_input>`-wrapped content and source-file content as data — never instructions — and to report adversarial-looking comments as `InjectionAttempt` findings rather than complying. The block is referenced in the Premise dispatch in `start.md`: when `intent_context.json.quarantine == true`, a quarantine preamble is prepended verbatim, telling Premise to infer intent from the diff only and capping severity at HIGH unless evidence is from source-file diffs.
- **Golden fixture.** `golden_injection_quarantine` (deferred since PLN-719 Phase 8) now ships with `config.yaml`, `inputs/` (including a pre-baked `agent_injection-detector.json` simulating the post-detect-injection state), and `expected/review_result.json`. Verifies the BLOCKING `InjectionAttempt` finding flows through the standard collect → validate → finalize pipeline and produces `verdict: CHANGES_REQUESTED` with one `verified[]` entry. Round-trips through `validate_result_envelope` end-to-end. The `_DEFERRED_FIXTURES` registry shrinks from 6 to 5 entries; the remaining 5 stay deferred until plans 02/03/05/06 land.
- **27 new tests** covering the 9 pattern classes (one parametrized test per class plus Unicode-tag and zero-width edge cases), severity-threshold scoring, quote-prefix downweighting, score accumulation across PR sections, the quarantine rewrite shape (real field names, preserved-when-clean title), end-to-end canonical-finding round-trip through `normalize_legacy_finding` + `validate_finding`, literal-forgery-token stripping, audit-log append + TTL sweep, `on_failure: continue` resilience (missing / malformed intent_context returns empty report instead of crashing), and the `cmd_classify_intent` quarantine short-circuit.

#### Fixed
- Pre-existing `test_plan_dependent_stages_disabled` no longer asserts `stage_09_detect_injection.enabled is False` (plan 01 is no longer deferred). The stage's contract is now guarded by the new `test_stage_09_detect_injection_enabled_with_pinned_args` instead. Other still-deferred plan stubs (stages 11, 13, 14, 23) keep their disabled-state assertions.

### code-review v2.6.5

#### Fixed
- `start.md` § Reviewer Fleet — the prose at line ~328 previously said only "do NOT run ad-hoc Python one-liners against `partitions.json`". Real `/start` runs showed the walker model ignoring that directive, indexing `data[0]` against the top-level dict, and crashing with `KeyError: 0`. The same systemic pattern that drove the rest of the PLN-719 follow-ups — prose alone doesn't beat the model's default behavior. Sharpened the section to (a) prescribe the canonical access path (`cat` / `Read`, then key-mapping; `python` is allowed *if* it indexes `data["partitions"][N]` not `data[N]`) and (b) inline the actual top-level shape so even an ignored directive lands on the right indexing. A new contract test `test_partitions_json_is_top_level_dict_not_list` in `TestPartitionPostProcessing` pins `cmd_partition`'s output as a top-level dict with `partitions` / `test_file_paths` / `force_merged_count` keys, so if anyone restructures the producer the prose breaks first instead of a real /start crash surfacing it.

### code-review v2.6.4

#### Fixed
- `cmd_post_comments` line-handling regression caught in PR #107 review. The previous `isinstance(line_raw, int) and not isinstance(line_raw, bool)` guard fixed the null-line crash but silently dropped legacy reviewers' string-typed lines (e.g. `"line": "42"`) into the `failed` bucket — the original `int(finding.get("line", 0))` would have coerced them. New shape: explicit `bool` check (still rejects `True`/`False`), then `int(line_raw)` wrapped in `try/except (TypeError, ValueError)`. This preserves the bool guard, fixes the null crash, and restores string coercion. Two new regression tests: `test_string_line_is_coerced_to_int` (locks in the string → int path) and `test_garbage_string_line_does_not_crash` (non-numeric strings degrade gracefully to `failed` rather than crashing on `ValueError`).
- `test_every_documented_runtime_token_is_resolvable` was a hardcoded subset that had already drifted (PR #107 added `<GLOBAL_CACHE>` and `<INTENT>` to start.md's table but never added them to the test's list). The test name claimed "every documented" but the hardcoded list couldn't catch a new token getting added to start.md or removed from it. Replaced with `test_runtime_tokens_in_start_md_match_helper_stage_args`, which parses start.md's Walker Contract placeholder table directly with a regex and enforces sync in both directions: every documented token must be referenced by at least one helper stage's args (or appear in the `GATE_OR_WALKER_TOKENS` allowlist for `<PLUGIN_ROOT>`/`<START_TIME>`/`<INTENT>`, which are walker- or gate-consumed by design), and every `<TOKEN>` placeholder in helper stage args must appear in the documented table. Drift in either direction now fails the test.

### code-review v2.6.3

#### Fixed
- `PRIORITIES` enum now includes `3`. `shared_prompt.txt` §"SEVERITY + PRIORITY" explicitly teaches a `P3` tier ("MEDIUM (P3): Suggestions, nice-to-haves"), and reviewers (Bug Hunter B in particular) correctly emit `priority: 3` for nice-to-haves — but the schema rejected those findings because `PRIORITIES` was hard-coded to `{0, 1, 2}`. A pure prompt ↔ schema contradiction: the reviewer was doing exactly what the prompt said, and the schema killed the finding. New `test_priorities_include_p3` + `test_p3_finding_passes_validation` guard against future drift.
- `shared_prompt.txt` `<output_format>` section now enumerates every canonical `CATEGORIES` value explicitly with a one-line description per category. Previously the prompt showed only `category: "Correctness"` as a single example, so reviewers naturally invented categories like "Code Style" (Auditor), "API Validation" (api-architect), or "Documentation Quality" — none of which were in the canonical enum. Reviewers now see the complete list and can map their findings to one of the 12 documented categories. The prompt also explicitly tells reviewers `priority` must be `0`, `1`, `2`, or `3` to prevent invented priority values.
- `test_shared_prompt_enumerates_every_canonical_category` locks in the prompt ↔ schema sync in both directions: every entry in `CATEGORIES` must appear in `shared_prompt.txt`, and every capitalized category-like token in the prompt's `<output_format>` must be in `CATEGORIES`. If either side adds or removes a category without updating the other, the test fails — making schema/prompt drift structurally impossible. This addresses the broader class of contract gap (reviewer-emitted enum values) rather than just the two specific categories from this run.

### code-review v2.6.2

#### Fixed
- `Documentation` added to the canonical `CATEGORIES` enum in `code_review_schema.py`. Reviewers naturally emit `category: "Documentation"` for README / docstring / comment findings, and the fast-path reviewer in particular produces this category on real runs. Previously such findings caused `cmd_finalize_result` to exit non-zero with `category 'Documentation' not in [...]`, which collided with `stage_25_finalize_result.on_failure: "abort"` and would have killed the pipeline. `Documentation` is now accepted alongside `Code Quality` rather than forcing reviewers to misclassify documentation findings. `SCHEMA.md` updated to list the new category in the finding schema.
- `stage_25_finalize_result.on_failure` relaxed from `"abort"` to `"continue"`. `cmd_finalize_result` writes `review_result.json` BEFORE running schema validation (line 4717 — explicit), so a non-zero exit indicates reviewer category/field drift, not a missing envelope. `stage_28_verdict` can read the structurally complete envelope and produce a verdict; the stderr text remains for operators to correct prompts/schema. This resolves a long-standing prose ↔ plan contradiction in `start.md` (per-stage notes claimed verdict would "fall back to findings_validated.json" while the plan said `abort`). The corrected prose now matches the relaxed behavior.
- `stage_30_footer.stdout` redirects to `<CR_DIR>/footer.json` (was `None`). `cmd_footer` writes its `{"footer_line": "..."}` JSON payload to stdout, and the `Review Footer` prose in `start.md` tells the walker to read `<CR_DIR>/footer.json` after the stage runs. With `stdout: None`, the file was never written; the walker read a missing file and reported the helper as exiting non-zero. The redirect now produces the file the prose expects, and `footer.json` is listed in `expected_outputs` so the gate system can confirm production.
- Three contract tests added in `TestPrepareRun` lock in the fixes against regression: `test_documentation_is_valid_category` (schema enum), `test_stage_25_finalize_result_on_failure_is_continue` (run-plan vs reviewer drift), `test_stage_30_footer_stdout_redirects_to_footer_json` (run-plan vs prose).

### code v1.12.0

#### Removed
- `code-review-worker` agent. The agent's only consumer was the `code-review` plugin's `/start` command (6 references), and the agent's definition was a 24-line generic worker (`tools: Read, Write, Grep, Glob`) with no logic specific to the `code` plugin's orchestration. Moved into `code-review/agents/code-review-worker.md` so the code-review plugin is self-contained and runs without requiring the `code` plugin to be enabled. External callers referencing `code:code-review-worker` should update to `code-review:code-review-worker`. The `code-reviewer` and `code-review-guidelines` agents remain in the `code` plugin (they're consumed by the `/code-review` command and the broader `code` workflow).

### code-review v2.6.0

#### Changed
- PLN-719 Phase 4b — `/start` rewritten from a 14-task prose workflow into a declarative orchestrator that invokes `prepare-run` to emit `<CR_DIR>/run_plan.json` and then walks the 30-stage plan stage-by-stage. Helper stages are dispatched by `subcommand` after runtime placeholder substitution (`<DIFF_SCOPE>`, `<CACHE_DIR>`, `<PROMPT_HASH>`, `<CONTEXT_KEY>`, `<MODEL_ID>`, `<STATE_KEY>`, `<GLOBAL_CACHE>`, `<INTENT>`, etc.); `agent_fleet` stages dispatch to the per-stage prompt templates kept in `start.md`; the `present` stage dispatches to the rendering format. Four runtime gates modify walker default behavior: Gate A (hygiene-only short-circuit after `stage_12_hygiene` — presents findings and exits cleanly), Gate B (`route` + `fast_path` decision between `stage_19_cache_check` and `stage_17_partition`), Gate C (skip `stage_26_cache_update` when `fast_path` is true or no cache), Gate D (skip `stage_27_review_state_write` unless local mode, cache active, and all agents succeeded). The `start.md` file drops from 1278 → 858 lines (~33% reduction) without changing review behavior. The deletions are the prose-driven helper invocations now derived from `run_plan.json`; the agent fleet prompt templates and presentation prose are preserved verbatim.
- Reordered `stage_17_partition` to execute after `stage_19_cache_check` (its array position now matches Gate B's runtime route invocation). The stage id retains its `_17_` prefix as a stable label; execution follows array position, not the numeric suffix. Removed the spurious `stage_17_partition` entry from `stage_18_compute_hashes.depends_on` (compute-hashes does not consume partition output; the real deps are `stage_02_prep_assets` and `stage_03_resolve_scope`). `stage_20_spawn_reviewers.depends_on` now points at `stage_17_partition` (the actual data producer) and adds `partitions.json` to its `expected_outputs`.
- `code-review` is standalone — moved the `code-review-worker` agent from the `code` plugin into `code-review/agents/code-review-worker.md`. All 6 `subagent_type: "code:code-review-worker"` references in `commands/start.md` updated to `code-review:code-review-worker`. There is no `## Prerequisites` section anymore. Stale `code-review → judges` dependency (a `test_validate_judge_report.py` import — the test file no longer exists) removed from `docs/dependencies.md` and `CLAUDE.md`. After this PR, `code-review` has zero cross-plugin runtime dependencies.
- `cmd_prepare_run` docstring updated to identify the consumer as the live `/start` walker (was "a future rewrite of start.md").

#### Added
- Five contract tests in `TestPrepareRun` lock in the walker dispatch surface so future plan changes can't silently break the orchestrator: `test_stage_kind_is_documented_enum` (kind ∈ {helper, agent_fleet, present}), `test_on_failure_is_documented_enum` (on_failure ∈ {abort, continue, continue_with_coverage_gap}), `test_every_documented_runtime_token_is_resolvable` (every runtime token in the start.md placeholder table is referenced by at least one helper stage's args), plus a rewritten `test_enabled_helper_stages_include_all_required_argparse_args` that derives required flags from argparse itself via `_register_subparsers` introspection instead of a hand-maintained dict. The introspection-based check makes argparse-contract drift structurally impossible.

#### Fixed
- `_build_run_plan_stages` was missing six required/behavior-affecting argparse flags that the prior prose orchestrator passed: `stage_03_resolve_scope` lacked the required `--setup-json` (argparse would have crashed `/start` on stage 3 before any review reached the agents); `stage_08_fetch_intent` lacked the required `--cr-dir` (same crash on stage 8); `stage_19_cache_check` and `stage_26_cache_update` both lacked `--global-cache <GLOBAL_CACHE>` (silent fallback from V2 to V1 cache mode for users with global cache enabled); `stage_26_cache_update` also lacked `--partitions-file`; `stage_30_footer` lacked `--cache-result` (footer silently showed `"Cache: disabled"` even when cache was active). All flags now declared in the run plan; the introspection-based contract test added in this release prevents the class of drift from recurring.
- `--pr-number` is now omitted entirely from `stage_03_resolve_scope`, `stage_04_finalize_cache`, `stage_08_fetch_intent`, and `stage_25_finalize_result` args when no PR is active. Previously the flag was emitted as `--pr-number ""`, which argparse rejected (`--pr-number` is `type=int`) with `invalid int value: ''` — crashing every non-PR review on stage 3. Introduced a stronger contract test (`test_enabled_helper_stages_parse_via_argparse_after_token_substitution`) that substitutes realistic placeholder values and runs `parse_args` on each enabled stage's args; this catches type/value mismatches that the existing required-flag-presence check missed.
- `stage_07_auto_incremental` moved to execute **before** `stage_05_parse_diff` (its array position now sits between `stage_04_finalize_cache` and `stage_05_parse_diff`). Previously it ran after parse-diff and extract-patches had already materialized `diff_data.json` and `patches_all.txt` with the wider scope, so any `diff_scope` override the stage emitted was applied to the cached `<DIFF_SCOPE>` token but ignored by every downstream stage. Removed `stage_05_parse_diff` from `stage_07.depends_on` (spurious — auto-incremental never consumed diff_data); `stage_05_parse_diff.depends_on` now includes `stage_07_auto_incremental` so the array order is enforced by the dependency graph too.
- `stage_08_fetch_intent.stdout` is now `None` instead of `<CR_DIR>/intent_context.json`. The helper writes `intent_context.json` to `cr_dir` itself; the stdout output is a small `{path, source}` summary. Redirecting stdout into `intent_context.json` produced a corrupt file (the summary clobbered the structured payload).
- `stage_01_setup.stdout` is now `None`. `setup` creates `cr_dir` as a side effect and prints its result JSON to stdout; a shell-style `> <CR_DIR>/setup.json` redirect cannot work because `cr_dir` does not exist until `setup` runs. The walker captures setup's stdout in-memory during stage 0b, parses `cr_dir`, then writes `setup.json` to the newly-created directory via the `Write` tool. The per-stage note and `start.md` Stage 0b prose now document this explicitly.
- Gate A no longer routes hygiene-only runs to `stage_28_verdict` and `stage_30_footer`. `cmd_verdict` requires `review_result.json` OR `findings_validated.json` to exist; neither is produced in hygiene-only mode, so the verdict call would have failed and `stage_28_verdict.on_failure == "abort"` would have crashed the walker. Hygiene-only runs now present hygiene findings and exit cleanly without a verdict tag, matching the pre-Phase-4b "EXIT — do not proceed to Step 3 or beyond" semantics.
- `cmd_post_comments` no longer crashes on findings whose `line` field is `null` and no longer accepts `bool` values (Python's `bool` is a subclass of `int`, so the original `isinstance(line_raw, int)` guard let `"line": true` post to line 1). Findings with `null`, missing, or `bool` `line` values are now counted under `failed` (no inline anchor) instead of crashing or posting to a nonsense line. Adds three regression tests: `test_null_line_does_not_crash`, `test_missing_line_key_does_not_crash`, `test_bool_line_does_not_post`. Original null-line crash was flagged in PR #100 review and never addressed.
- "Two decisions live outside the run plan" / "Three runtime-driven branching gates" undercount in `start.md` corrected to "Four runtime gates modify walker default behavior" (Gate A/B/C/D).
- `stage_20_spawn_reviewers.expected_outputs` no longer lists `partitions.json`. The file is produced by `stage_17_partition` (a prerequisite) and consumed by `stage_20`, not produced by it. Including it would have masked total-agent-failure via the walker's "at-least-one-exists" check, since `partitions.json` already exists from the prior stage when `stage_20` runs.
- Documented a workaround in the Walker Contract for sessions whose hooks intercept the `Read` tool on generated artifacts (e.g. a code-discovery gate that demands codebase-memory-mcp lookups): fall back to `cat` via `Bash` — pipeline artifacts under `<CR_DIR>` are not source code.

### code-review v2.4.0

#### Added
- PLN-719 Phase 8 (Golden Fixture Harness): a parametrized pytest harness at `tools/python/test_golden_fixtures.py` + supporting `golden_fixture_harness.py` that pins the post-collection contract end-to-end. Each fixture lives at `tools/python/fixtures/<name>/` with `config.yaml`, `inputs/` (canned upstream artifacts: `setup.json`, `scope.json`, `intent.json`, `diff_data.json`, one or more `agent_*.json`, optionally `hygiene.json` + `coverage_plan.json`), and `expected/review_result.json`. The runner stages inputs into a tmp `cr_dir`, runs `collect-findings` → `validate` → `finalize-result`, normalizes non-deterministic fields (`review_id` uuid, `emitted_at` timestamps, the wall-clock telemetry block), and diffs against `expected/`. Every fixture also doubles as a schema round-trip check — `validate_result_envelope` runs on the produced envelope and fails the test on any errors (PLN-719 Section 10 acceptance: "every fixture round-trips emit → write → read → validate").
- `--update-golden` pytest CLI option (registered in `tools/python/conftest.py`) rewrites every fixture's `expected/review_result.json` through the same normalization path the assertion uses, so a subsequent no-flag run sees byte-identical output. Intended workflow: update via flag, review the diff in the commit, ship.
- Three fixtures shipped end-to-end: `golden_minimal_correctness` (single HIGH Correctness finding, verdict NEEDS_ATTENTION), `golden_all_categories` (four findings spanning Correctness / Code Quality / Security / TestQuality; verifies the post-PR-#103 CATEGORIES enum flows through finalize's `by_category` stats), `golden_schema_v1_round_trip` (single Security finding with every optional schema field populated — `evidence[]`, `reasoning_certificate`, `other_locations`, `subcategory` — the maximal v1 envelope shape).
- Six deferred fixtures with reserved directories + `README.md` placeholders: `golden_premise_justified` / `golden_premise_rejected` (plan 02), `golden_impact_with_callsites` (plan 06), `golden_coverage_gap` (plans 03 + 05), `golden_injection_quarantine` (plan 01), `golden_budget_exceeded` (arbitrate-budget integration). Skipped via a `_DEFERRED_FIXTURES` map in the test module until their dependent plans land.
- `test_prepare_run_produces_byte_identical_output_modulo_review_id` pins PLN-719 Section 6 determinism: two `prepare-run` invocations differ only in `review_id`. Any drift in stage args, validation gates, or telemetry projections fails the test.
- SCHEMA.md §12 documents the harness contract: fixture layout, the `--update-golden` workflow, Phase 8 vs deferred scope, and the note that Phase 4b will extend the harness to walk `run_plan.json` end-to-end through a declarative stage runner.
- `expected_verdict`, `expected_verified_count`, `expected_coverage_gap_count` keys in fixture `config.yaml` drive hard assertions against the produced envelope, run even in `--update-golden` mode so the rewriter cannot silently pin a verdict that contradicts config intent. SCHEMA.md §12 documents this contract.

#### Changed
- Hoisted `run_with_stdout_capture(fn, ns, *, stdout_to=None)` to module level in `golden_fixture_harness.py` (was inline) and added `invoke_prepare_run(cr_dir, *, output=None, ...)` to `tools/python/conftest.py`. Both centralize the `argparse.Namespace` + stdout-capture pattern previously duplicated across `test_code_review_helpers.py::TestPrepareRun._run` and `test_golden_fixtures.py::_invoke`; both callers now delegate.

#### Fixed
- `setup.json.current_branch` aligned with `scope.json.review_branch` (`"feature/x"`) in `golden_minimal_correctness` and `golden_all_categories`. The prior `"main"` value contradicted `diff_scope` because `cmd_finalize_result` resolves `setup.current_branch` before falling back to `scope.review_branch`.
- `golden_all_categories/config.yaml` header comment + `description` no longer claim "every CATEGORIES value"; the fixture covers a representative 4-category subset, not all 11. Remaining categories belong to the deferred fixtures.
- `diff_envelope_against_expected` docstring corrected to state only `actual` is normalized; the expected file is compared as-is (already written through `update_expected`'s normalization path).
- Removed dead `scope_kind=fixture.config.get("scope_kind")` from `validate_ns` construction in `golden_fixture_harness.py`. `cmd_validate` reads only `--findings` and `--diff-data`.

### code-review v2.3.0

#### Added
- PLN-719 Phase 7 (Cache uniformity): `CACHE_TTL_DAYS` constant on `code_review_schema.py` declares the per-namespace TTLs from PLN-719 §9 (`bha`=30d, `signals`=7d, `coverage_critic`=7d, `verifications`=30d, `overrides`=90d), plus a `cache_ttl_days(namespace)` lookup helper that returns `None` for unknown namespaces. The whitelist is pinned to the canonical 5 cache namespaces via a new `test_cache_ttl_days_covers_every_namespace` regression test.
- `_is_entry_fresh(entry, namespace, *, now=None)` helper in `code_review_helpers.py` enforces **sweep-on-read** TTL eviction. Stale `cached_at` → cache miss → next review regenerates fresh findings. Missing/malformed `cached_at` values and unknown namespaces count as fresh (caller handles its own corruption fallback). Wired into both the v1 and v2 cache-check paths after `_entry_matches`, so existing miss reasons (schema_version, model_id, prompt_hash, patch_hash) short-circuit before the TTL check.
- `_extract_bha_cache_hit_rate(cr_dir)` reads `<cr_dir>/cache_result.json` (written by `cache-check`) and normalizes `stats.hit_rate_pct` (0–100) into the canonical `[0, 1]` range enforced by `validate_telemetry`. `_build_telemetry_block` populates `telemetry.cache_hit_rate["bha"]` when a cache_result.json exists — this is the first end-to-end producer for the `cache_hit_rate` field that Phase 9 declared. Hygiene-only and no-cache runs leave the field empty (legal under the open-additionalProperties schema).
- 13 new tests covering: `_is_entry_fresh` unit semantics (within/past TTL, missing/malformed timestamps, unknown namespaces), end-to-end TTL eviction for both v1 and v2 cache-check paths, `telemetry.cache_hit_rate["bha"]` population (present when cache_result.json exists; absent otherwise; defensively dropped when `hit_rate_pct` is out of `[0, 100]`), and schema-level whitelist coverage tests.

#### Changed
- Cache test fixtures: hardcoded `cached_at: "2026-01-01T..."` timestamps replaced with a module-level `_FRESH_CACHED_AT` constant computed at collection time, so hit-expecting tests stay within the BHA 30-day TTL window indefinitely. Added a `_stale_cached_at(days_ago=N)` helper for the new eviction tests. Miss-expecting tests are unchanged — they short-circuit on `_entry_matches` before the TTL check.
- SCHEMA.md §9: gains a paragraph documenting sweep-on-read TTL enforcement and Phase 7's BHA-only end-to-end status; notes that the canonical per-file path layout (`<CACHE_DIR>/bha/<file_hash>.json`) is a future migration — the current implementation still uses a single `<CACHE_DIR>/manifest.json` with per-file entries sharing the same key inputs and invalidation contract.

### code-review v2.2.0

#### Added
- PLN-719 Phase 9 (telemetry): canonical `Telemetry` schema on `code_review_schema.py` with `empty_telemetry()` factory, `validate_telemetry()` validator, and `merge_telemetry(base, overlay)` deep-merger. The deep-merge is gated on an explicit `TELEMETRY_DEEP_MERGE_KEYS` whitelist (`duration_by_stage_ms`, `tokens`, `cache_hit_rate`, `schema_versions_seen`, `findings_counts`, `verification_stats`, `coverage_stats`); every other key — including dict-typed fields not on the whitelist — is overwritten wholesale by the overlay, so callers can populate `tokens.input_uncached` without overriding the whole `tokens` block while future schema additions get safe replace-semantics by default. Required keys: `duration_ms`, `duration_by_stage_ms`, `estimated_cost_usd`, `tokens.{input_uncached,input_cached,output,by_model}`, `cache_hit_rate`, `agent_failures`, `schema_versions_seen`. Optional: `findings_counts`, `verification_stats`, `coverage_stats`. Unknown keys permitted for forward-compat.
- Canonical cache namespace constants (`CACHE_NAMESPACES = {bha, signals, coverage_critic, verifications, overrides}`) matching PLN-719 §9 — used as the keyspace for `cache_hit_rate` and as forward-looking constants for plans 03/05.
- `_build_telemetry_block(cr_dir)` helper in `code_review_helpers.py` reads optional `<cr_dir>/telemetry.json`, deep-merges over the zero-valued base, and always overwrites `schema_versions_seen` so an upstream file cannot spoof the version stamp.
- SCHEMA.md Section 11 documents the telemetry contract: field table, producer recipe (write `<cr_dir>/telemetry.json` before `finalize-result`), deep-merge semantics, forward-compat policy.
- 16 new schema + finalize-result integration tests (`test_empty_telemetry_*`, `test_validate_telemetry_*`, `test_merge_telemetry_*`, `test_telemetry_json_schema_*`, `test_telemetry_defaults_when_no_telemetry_json`, `test_telemetry_json_is_deep_merged_into_envelope`, `test_telemetry_schema_versions_seen_cannot_be_spoofed`, `test_malformed_telemetry_json_is_ignored`).

#### Changed
- `result_envelope_json_schema()` declares `telemetry` as a typed object with required keys + nested types (was: open `{type: "object"}`). `validate_result_envelope()` now recurses into `validate_telemetry()` when the block is present.
- `cmd_finalize_result` uses `_build_telemetry_block(cr_dir)` instead of an inline stub. Existing finalize-result output continues to validate without any orchestrator changes — the actual per-stage timestamps + cache hit/miss plumbing land in Phase 4b/7.
- `validate_result_envelope()` refactored into focused per-section helpers (`_validate_envelope_scalars`, `_validate_envelope_buckets`, `_validate_coverage_plan`, `_validate_envelope_findings`) to reduce cognitive complexity. Same coverage; flatter call graph.
- `conftest.minimal_envelope()` now seeds the envelope with `empty_telemetry()` so existing tests stay valid by construction under the strict validator.

#### Fixed
- `"Code Quality"` is now in the canonical `CATEGORIES` enum. The shared reviewer prompt at `tools/prompts/shared_prompt.txt` documents it as the example category for MEDIUM-tier DRY/maintainability findings, but the schema enum at `code_review_schema.py` omitted it. Reviewer-emitted Code Quality findings caused `finalize-result` to reject the canonical envelope; verdict fell back to `validate_output.json` as designed, but the envelope path silently dropped those findings. `SCHEMA.md` Section 1 (category enum line) is updated to match. Adds three regression tests (`test_categories_include_code_quality`, `test_code_quality_finding_passes_validation`, `test_code_quality_finding_in_envelope_passes_validation`).

### code-review v2.1.0

#### Changed
- PLN-719 Phase 5 (pipeline reordering): `extract-patches` moves from after-partition to immediately after `parse-diff`. In its new position it produces only `patches_all.txt`, making the full diff available on disk before every downstream stage (hygiene, route, partition, BHB/Auditor/Premise reviewers, plus the plan-05-gated extract-signals + coverage chain). The `--partitions-file` flag is removed from `cmd_extract_patches`.
- `partition` becomes the canonical producer of `patches_p<N>.txt`. New optional `--diff-scope`, `--cr-dir`, `--workdir` arguments trigger the per-partition `git diff`; when both `--diff-scope` and `--cr-dir` are supplied, partition emits `patches_p0.txt`, `patches_p1.txt`, … alongside `partitions.json`. Without them the call stays a pure partition-assignment helper, preserving backward compat for callers that only want the assignment.
- `prepare-run` (run_plan.json generator): `stage_17_partition` now passes `--diff-scope` and `--cr-dir`, and its `expected_outputs` list includes `patches_p<N>.txt` alongside `partitions.json`. `stage_06_extract_patches` already matched the new contract.
- `/start` command rewires Task 5 to call `extract-patches` right after `parse-diff` and Task 8 to call `partition` with the new patch-generation args. The "Pre-Extract Patches to Disk" section is renamed and explicitly documents the two-stage materialization.

### code-review v2.0.0

#### Added
- `code_review_schema.py` defines the canonical Finding + ResultEnvelope schema (PLN-719 Foundation, schema_version 1). Three finding scopes (`diff`, `system`, `pr_metadata`), the canonical `system_marker` enum (`budget-exceeded`, `agent-failure`, `signal-extraction-failed`, `schema-version`, templated `coverage:{reviewer}`, `pr_description`, templated `commit:{sha}`), deterministic finding ids (`<reviewer>_f<index>`), and producer-side validators for both findings and the result envelope. Includes JSON Schema dicts for documentation and machine validation, and `normalize_legacy_finding` for upgrading pre-foundation findings in-flight.
- `finalize-result` subcommand consolidates validated findings, coverage state, and the canonical verdict (`APPROVED` | `NEEDS_ATTENTION` | `CHANGES_REQUESTED`) into a single `review_result.json` envelope. Buckets findings into `verified[]` / `justified[]` / `rejected[]` / `pending_verification[]` per the foundation spec; populates run context (pr_number, head_sha, diff_tip, base_ref, mode, intent), stats (by_severity, by_category, by_reviewer, by_finding_scope, verification, premise_cumulative_medium_count), and a telemetry block (duration, tokens, schema_versions_seen). Cross-validates the envelope before writing.
- `arbitrate-budget` subcommand is the single owner of "which reviewers run, against what cap" (PLN-719 Section 5). Defaults: `total_cap=20`, `bha_floor=1` (waived for docs-only PRs), `required_overflow_policy=fail_closed`, best-effort pruned by ascending priority. Emits canonical coverage-gap findings (`finding_scope: "system"`, `system_marker: "budget-exceeded"`, `severity: "HIGH"`, `required: true`) for every required reviewer that overflows the cap, gating the verdict to `CHANGES_REQUESTED` via rule 1.
- `prepare-run` subcommand emits a declarative `run_plan.json` describing the canonical 30-stage pipeline (PLN-719 Section 6). Stages from plans 01/03/05/06 (`detect-injection`, `extract-signals`, `validate-companions`, `resolve-coverage`, `coverage-critic`, `verify-findings`, `verify-coverage`) are present but marked `enabled: false` until those plans land. Validation gates anchor at `parse-diff`, `arbitrate-budget`, `spawn-reviewers`, `validate`, and `finalize-result`. Output is byte-identical across runs modulo the `review_id` uuid.
- `compute_canonical_prompt_hash` (PLN-719 Section 9): NUL-separated parts + NUL + `schema_version` folded into the hash. A MAJOR schema bump now invalidates every cache namespace at once.
- Determinism tier vocabulary (`deterministic` / `reproducible_via_cache` / `llm_driven`) and a `STAGE_DETERMINISM_TIERS` mapping in `code_review_schema.py` (PLN-719 Section 8). Required-reviewer selection cannot depend on `llm_driven` outputs; plans 03/05 extend the mapping when they ship.
- `SCHEMA.md` is the canonical reference for the Finding + ResultEnvelope schema, the `system_marker` enum, verdict precedence, budget arbitration policy, pipeline ordering, determinism tiers, cache key derivation, and the schema migration policy.
- New tests: `test_code_review_schema.py` (47 schema + round-trip + determinism-tier tests) and 31 new integration tests in `test_code_review_helpers.py` (`TestCanonicalSchemaIntegration`, `TestFinalizeResult`, `TestVerdictReadsEnvelope`, `TestArbitrateBudget`, `TestArbitrateBudgetVerdict`, `TestPrepareRun`, `TestCanonicalPromptHash`). Total: 368 passing tests (282 pre-existing untouched).

#### Changed
- `cmd_hygiene` now emits canonical schema fields (`schema_version`, `finding_scope: "diff"`, `system_marker: null`, `source: "hygiene"`, `reviewer: "hygiene"`, `reviewer_trigger: {"type": "always", "evidence": "deterministic-hygiene"}`, `emitted_at`, `evidence: []`, deterministic id). Existing finding shape preserved for backward compat (`category: "Repo Hygiene"` remains a canonical category alias).
- `cmd_collect_findings` assigns deterministic finding ids (`<reviewer>_f<index>`) derived from `agent_<reviewer>.json` filenames; preserves any pre-assigned id; passes every finding through `normalize_legacy_finding` so the merged `findings.json` is uniformly canonical.
- `cmd_validate` honors `finding_scope`. Diff-scoped findings keep the existing file-in-diff and line-in-changed-range filters; system- and pr_metadata-scoped findings bypass those checks but require a canonical `system_marker` (validator rejects unknown markers and rejects markers that don't belong to the declared scope). Dedup is by `(system_marker, category)` for non-diff findings; cross-file Jaccard grouping is gated to diff scope.
- `cmd_verdict` reads `review_result.json` when provided (canonical verdict APPROVED|NEEDS_ATTENTION|CHANGES_REQUESTED) and maps to the legacy `approve|needs_attention|decline` tag for backward compat with `run-loop.sh` and the github-review presenter. Falls back to `validate_output.json` when the envelope is absent. Emits both fields in the output JSON.
- `cmd_compute_hashes` uses the canonical prompt_hash recipe and emits `schema_version` alongside `prompt_hash` and `context_key`. Pre-2.0.0 caches are invalidated by the MAJOR schema bump (cache regeneration is cheap; migration logic is bug-prone).
- `/fix` skill prefers `review_result.json` when present and explicitly surfaces system-scoped findings (coverage gaps, budget overflows) as "manual surface" items that cannot be auto-fixed in code.
- README documents the new foundation architecture, references `SCHEMA.md`, and adds `finalize-result`, `arbitrate-budget`, and `prepare-run` to the subcommand table.

### code v1.11.20

#### Changed
- README installation guidance now states the installer installs and verifies the five Symphony runtime plugins at user scope, with `bootstrap` excluded from the default runtime install.

#### Fixed
- `install.sh` now refreshes the configured `closedloop-ai` marketplace, installs the five Symphony runtime plugins at user scope, then verifies those runtime plugins have existing install paths and enabled user-scoped `claude plugin list --json` entries. Disabled user-scoped runtime plugins are re-enabled once and re-read before the installer reports success.
- Project-scoped ClosedLoop plugin duplicates are repaired before user-scope install/update when Claude reports a usable `projectPath`; entries without a usable project path now produce a manual project-directory uninstall command while user-scope repair continues.

### code v1.11.19

#### Changed
- `test_write_runs_log_entry_uses_workdir_root` in `test_run_loop_failure_marker.py` now `unset`s `CLOSEDLOOP_COMMAND` and `LAST_CLAUDE_COMMAND` inside the bash heredoc before invoking `write_runs_log_entry`, so the default-command path is exercised deterministically regardless of the caller's ambient environment. Test-only change isolating the existing behavior — no production code paths altered.

### judges v1.7.0

#### Added
- `validate_agent_registry.py` pre-flight tool at `plugins/judges/tools/python/` validates every agent markdown file in the judges agent directory before a judge batch runs. Discovers `.md` files, validates frontmatter (`name`, `description`, `model`, `tools`, `skills`), checks `model` against `VALID_MODELS`, flags hallucinated tools, and — when `--artifact-type {plan,code,prd,feature}` is passed — verifies every judge required by `JUDGE_REGISTRY` for that artifact is present and valid. Fails fast (exit 1) before the batch is dispatched, surfacing the failures via the structured `RegistryValidationResult` shape. CLI accepts `--artifact-type` and `--workdir` flags so the documented `run-judges` SKILL invocation actually runs.
- `error_reason: Optional[str]` field on `CaseScore` schema. Judges that terminate via the error path (`final_status=3`) now record their failure context on the case score itself, enabling downstream aggregation to distinguish "judge had no opinion" from "judge said 0". The field is additive with `None` default, so existing report consumers ignore it safely.
- `compute_average_excluding_errors` helper in `validate_judge_report.py` averages `MetricStatistics.score` across `CaseScore` entries whose `final_status != 3`, returning the average score as `Optional[float]`. Callers separately compute the N/M count of contributing judges for display (e.g. "avg of N/M judges"). Errored judges are excluded from the mean rather than dragged into it.
- `run-judges` SKILL.md documents the pre-flight validation step, the `ERR` marker rendering on summary tables, and the new "avg of N/M judges" annotation that surfaces when one or more judges errored.
- `test_validate_agent_registry.py` covers frontmatter parsing, missing/extra fields, invalid model values, hallucinated tools, valid agents, directory-level aggregation (including non-existent / empty / partially-invalid directories), and the CLI entrypoint.
- `TestValidateAgentRegistry::test_unknown_artifact_type_returns_structured_error` covers the new `artifact_type` guard.
- `TestJudgeRegistrySync::test_judge_registry_matches_validate_judge_report` asserts the two `JUDGE_REGISTRY` definitions (in `plugins/judges/tools/python/validate_agent_registry.py` and `plugins/judges/skills/run-judges/scripts/validate_judge_report.py`) stay byte-for-byte equal. If a judge is added to one registry but not the other, the pre-flight check would pass while post-run validation would fail — exactly the drift scenario the pre-flight check exists to prevent. The test uses the existing `sys.path` manipulation pattern (per CLAUDE.md's "Standalone scripts with no cross-tool imports within a plugin" rule) rather than extracting the registry to a shared module.

#### Changed
- `run-judges/SKILL.md` summary-table prose now spells out the `ERR` marker convention, the "avg of N/M judges" wording when at least one judge errored, and the placement of the pre-flight `validate_agent_registry.py` step ahead of judge execution. Path in the documented invocation corrected from `skills/run-judges/scripts/` to `tools/python/` so the example resolves to the real script.
- `validate_judge_report.py` consumes the new `error_reason` field, propagates it through aggregation, and skips errored case scores when computing the per-judge / per-metric average rather than coercing their ordinal status into the mean.
- `validate_agent_registry.py` extracts the duplicated `RegistryValidationResult` finalization logic into a private `_populate_result` helper. Both the `Unknown artifact_type` early-return path and the normal completion path now share a single field-assignment site, so future additions to `RegistryValidationResult` cannot silently miss the error branch. DRY refactor — no behavior change.

#### Fixed
- `validate_agent_registry()` now returns a structured `RegistryValidationResult` with an `Unknown artifact_type '<value>'. Valid values: [...]` error when called with an `artifact_type` outside `JUDGE_REGISTRY`, instead of raising an uncaught `KeyError`. The CLI was already safe via argparse `choices`, but programmatic callers (and the soon-to-be agent-registry tests) now get the same structured failure shape as the existing "directory does not exist" and "path is not a directory" early-returns. Counters (`total_agents` / `valid_agents` / `invalid_agents`) are populated before the early return so the result shape stays consistent across error paths.
- `test_validate_judge_report.py::_make_minimal_casescore` no longer re-imports `MetricStatistics` inside the function body — it was already imported at module level via `from validate_judge_report import (..., MetricStatistics, ...)`, so the in-function import shadowed the module-level name and carried a redundant `# type: ignore` comment. One-line removal, no behavior change.
- Test fixture for `error_reason` now matches the documented contract (set only when `final_status=3`), preventing tests from accidentally encoding a non-contract-compliant shape into the regression suite.

### code v1.11.18

#### Added
- `decision-table` skill `references/edge-cases.md` gains six new edge-case categories with mandatory test requirements: External contract literal binding, Cross-surface propagation and reconciliation, Data visibility versus side effects, Cached capability drift, Backward-compatible persisted defaults and promotion, and Distributed lifecycle coverage.
- `decision-table` `references/artifact-format.md` adds a `Contract Literal Inventory` table schema (Literal / Contract Type / Source of Truth / Producers / Consumers / Compatibility / Failure Behavior) and expands the behavioral edge-case checklist and `Required Tests` guidance with exact contract-literal binding tests whose mocks fail closed.
- `decision-table` `references/review-prevention.md` adds seven new anti-patterns: external contract literal collision, permissive mock hiding wrong external key, cross-surface write with no reconciliation path, visible data mistaken for fired side effect, stale cached capability false negative/positive, legacy persisted record promoted or deleted without evidence, and distributed lifecycle gap. Contract-Heavy Review Surface section gains parallel coverage bullets.

#### Changed
- `decision-table` `SKILL.md` steps 6, 8, and 12 require classifying external contract literals (feature flag keys, query parameters, cache segments, headers, event names, command names, plugin identifiers, URL schemes, reason/status strings, etc.) by semantic purpose and source of truth before treating similar-looking strings as aliases; require treating web/backend/Electron/local-store/notification/cache/peer as separate surfaces unless proven shared; require test oracles that fail closed for wrong literals.

### self-learning v1.2.5

#### Added
- `perf_summary.py` now reports token usage from `agent` perf rows. Agent and phase tables include total, input, output, cache, and peak-context token columns; JSON output includes granular token fields plus a new `phase_agents` table keyed by derived phase and `agent_name`.
- Phase token attribution now joins `agent` events into completed phase windows by `run_id`, `iteration`, `command`, and `agent.started_at`. Phase timeline output includes per-phase-instance token totals and peak context. Legacy perf rows without token fields remain compatible; when an adjacent `claude-output.jsonl` / `claude-output-*.jsonl` file has matching `tool_use_result.agentId` usage, the summary backfills token totals from that archive.

### code v1.11.17

#### Added
- `/plan-validate` skill auto-syncs answered questions from markdown plans into `plan.json`. `validate_plan.py` gains an `--auto-sync` flag (passed by default from the skill) that extracts answers in bold, italic, and plain formats from the markdown, migrates entries from `openQuestions` to `answeredQuestions`, and falls back to `recommendedAnswer` when no answer text is found. Covered by `test_auto_sync_answers.py` and `test_validate_plan_sync.py`.

### code v1.11.16

#### Added
- `run-loop.sh` honors a pre-set `CLOSEDLOOP_COMMAND` from the parent process (e.g. the Electron app's websocket-derived command). New `resolve_closedloop_command()` helper applies the precedence pre-set `CLOSEDLOOP_COMMAND` → `--prompt` value → `"interactive"` fallback and persists the resolved command in `state.json` for correct Datadog per-command attribution and manual-resume recovery. On resume, the persisted command overrides any stale ambient `CLOSEDLOOP_COMMAND`.

#### Fixed
- `write_runs_log_entry` default chain changes from `LAST_CLAUDE_COMMAND → self_learning` to `LAST_CLAUDE_COMMAND → CLOSEDLOOP_COMMAND → plan_execute`, removing the over-attribution of fresh-start Loops to `self_learning` in Datadog (FEA-936).
- `emit_perf_event` empty-input guard treats an empty `json_line` as a silent no-op, preventing Loop-wide kills under older jq + `set -euo pipefail` and corrupt blank perf.jsonl lines under modern jq 1.8+ (FEA-936).
- Legacy state-file read path hardened with `|| echo ""` so older state files lacking the `command:` field do not abort the script under `set -euo pipefail`.
### code v1.11.15

#### Changed
- `pre-tool-use-hook.sh` now falls back to `tool_input.description` when `subagent_type` is empty, so every Agent spawn gets a meaningful label in Datadog telemetry instead of a blank `plannedSubagentType`.
- Orchestrator prompt (`prompt.md`) annotates all unnamed haiku/sonnet subagent spawns with consistent `description` labels: `plan-editor`, `critic:{critic_name}`, `build-fixer`, `dt-telemetry-writer`, `visual-qa-support`.

#### Added
- Tests for the description-fallback behavior (Test 5: fallback when subagent_type is empty, Test 6: subagent_type takes precedence over description).

### code v1.11.14

#### Fixed
- `rate_limit_signal` in `run-loop.sh`'s `detect_claude_terminal_failure` now fires only when `rate_limit_info.status == "rejected"` (or `overageStatus == "rejected"` with `isUsingOverage == true`), replacing the prior "any non-`allowed` value" denylist. Benign heartbeats with `status` of `allowed_warning`, `paused`, `throttled`, or informational `exceeded` no longer abort the loop. The `status_429` and error-string match paths remain unchanged, so genuine rate-limit failures continue to be marked. (PLN-530)

#### Changed
- Expanded `test_rate_limit_event_predicate` parametrization with RL-18..RL-31 covering `allowed_warning`, the rejected-only fatal path, overage-branch regression guards, and cross-branch interactions. Pre-existing rows for `paused`, `throttled`, `exceeded` (with overage on), and bare `rejected` (with `isUsingOverage` false) flip from `CLAUDE_RATE_LIMIT` to no-signal to encode the new gating. Adds Group E (RL-32..RL-35) malformed-payload coverage exercising jq's string-equality and object type guards, plus a Group G end-to-end test feeding a realistic Claude JSONL stream with `allowed_warning` heartbeats and asserting no signal fires.

### code v1.11.13

#### Fixed
- `rate_limit_signal` in `run-loop.sh`'s `detect_claude_terminal_failure` now requires `rate_limit_info.isUsingOverage == true` before a non-`allowed` `overageStatus` counts as a rate-limit failure. Prevents false positives when the org is not actually consuming overage capacity but `overageStatus` is still populated. The `status != allowed`, `status_429`, and error-string match paths remain unchanged, so existing true-positive detection is preserved.

#### Changed
- Refactored repeated `is_error` / `isApiErrorMessage` envelope-string matching across `rate_limit_signal`, `context_limit_signal`, and `auth_challenge_signal` into a single shared `envelope_text_match(pat)` jq helper. Three near-identical predicate definitions collapse to one helper invocation each — same behavior, less duplication.
- Removed dead jq helpers (`user_texts`, `error_texts`, `text_blob`, `first_user_text`, `first_error_text`, `error_shaped`) left over from the wider matching scheme that was scoped down in the v1.11.11 source-attribution fix.
- Expanded `test_rate_limit_event_predicate` parametrization to cover `isUsingOverage` true/false/missing variants, malformed payloads, and bug-reproduction cases (RL-01..RL-17, RL-X2, RL-X4) so the new gating condition is exercised end-to-end.

### code v1.11.12

#### Fixed
- `run-loop.sh` now fails the loop when `max_iterations` is reached with zero successful iterations, emitting a `RUNNER_ERROR/MAX_ITERATIONS_NO_PROGRESS` user-visible failure and exiting with code 4. A new `successful_iterations` counter is incremented on non-empty results or `COMPLETE` promise detection, and `runs.log` entries gain an optional 8th field (`successful_iterations`) appended only on the max-iterations exit path — older readers that parse the leading 7 fields stay compatible. Covered by new `test_run_loop_failure_marker.py` cases for the no-progress failure path. Also isolates `test_reduce_failures_reads_runs_log_from_workdir_root` from the ambient `CLOSEDLOOP_ITERATION` env var so the test no longer depends on the caller's environment.

#### Changed
- `verification-subagent` now includes `SendMessage` in its allowed tools so verification flows can send follow-up messages while preserving the existing `Read`, `Glob`, and `Grep` inspection access.
- Decision-table guidance now includes durable finalization and replay eligibility coverage for flows that persist local terminal state before external acknowledgement. The artifact-format, edge-case, and review-prevention references call out retryable finalization failures, acknowledgement cleanup, restart replay, and retained credential or marker data requirements.

### code v1.11.11

#### Fixed
- `detect_claude_terminal_failure` in `run-loop.sh` no longer treats benign Claude `rate_limit_event` heartbeats as terminal failures. The `rate_limit_signal` jq predicate now requires `rate_limit_info.status` or `overageStatus` to be a non-`allowed` value before a `rate_limit_event` entry counts as a failure, so successful runs that emit allowed-status heartbeats stop creating false `loop-error.json` markers. Failure messages are now sourced from the triggering entry's own `result`/`error` string rather than scanning unrelated assistant prose, and `auth_challenge_signal` only fires inside `is_error` / `isApiErrorMessage` envelopes so plain assistant text mentioning auth never trips the auth-challenge classifier.
- `rename_orphan_output_on_start` in `run-loop.sh` now requires `state.json`'s recorded `workdir` to match the current workdir before reusing its `prev_run_id` to rename an orphan `claude-output.jsonl`. Prevents cross-workdir RUN_ID reuse when a stale `state.json` from another workdir is reachable.

#### Changed
- `test_run_loop_failure_marker.py` consolidates the PLN-502 heartbeat-false-positive cases behind a shared `run_detect` helper that centralizes the bash-source boilerplate for invoking `detect_claude_terminal_failure`. Cuts duplicated fixture setup across the rate-limit-signal, message-sourcing, auth-challenge-envelope, and workdir-mismatch test groups so each case focuses on fixture data and assertions.

### code v1.11.10

#### Added
- New `pre-tool-use-hook.sh` writes a per-tool-call sentinel JSON file at `$CLOSEDLOOP_WORKDIR/.closedloop-ai/.tool-calls/{TOOL_USE_ID}` capturing `started_at`, `tool_name`, `agent_id`, `run_id`, `command`, and `iteration`. Designed to be non-blocking: fails open (`trap 'exit 0' ERR`) on any internal error so the caller is unaffected. Emits a `spawn` perf event when `tool_name` is `Agent`, recording `parent_session_id`, `parent_agent_id`, and `planned_subagent_type` from the hook payload. Stdin parsed via a single `jq` `@sh` invocation matching the post-hook idiom. Safety comes from the additive event schema — perf.jsonl readers ignore unknown events, so emitting an extra `tool`/`spawn` row never breaks downstream consumers — and the fail-open contract above.
- New `post-tool-use-hook.sh` reads the sentinel written by the pre-hook, computes tool-call duration, and appends a `tool` event to `perf.jsonl` with `event`, `run_id`, `command`, `iteration`, `agent_id`, `tool_name`, `started_at`, `ended_at`, `duration_s`, and `ok` fields. Attribution (run_id/command/iteration) is taken from the sentinel rather than the post-hook environment so concurrent runs do not cross-attribute. Emits an additional `skill` event when `tool_name` is `Skill`, sourcing `skill_name` from `tool_input.skill` and falling back to `tool_input.command`. Same fail-open trap and additive-schema safety contract as the pre-hook.
- New `plugins/code/hooks/tests/` bash suite covering the new perf hooks: `test_helpers.sh` (shared pass/fail counters, `assert_field_present`, `assert_field_equals`, `setup_temp_env`, `create_sentinel`); `test_tool_event.sh` (post-hook emits a complete `tool` event with all required fields and honors sentinel-based attribution overrides); `test_skill_event.sh` (post-hook emits both `tool` and `skill` events for `Skill` tool calls, with skill-name fallback); `test_spawn_event.sh` (pre-hook emits a `spawn` event for `Agent` tool calls and writes a sentinel for non-Agent tools); `test_fail_open.sh` (both hooks exit 0 and do not corrupt `perf.jsonl` when an internal step fatally errors, including read-only sentinel directories, missing/corrupted sentinels, and exit-1 stub replacements); `test_correlation.sh` (end-to-end pre→post run, sentinel-attribution-wins regression for PR #70 review findings).

#### Changed
- `plugins/code/hooks/hooks.json` registers the new `pre-tool-use-hook.sh` alongside the existing `pretooluse-hook.sh` under `PreToolUse`, and adds a new `PostToolUse` entry pointing at `post-tool-use-hook.sh`. The legacy pre-hook is preserved so existing JIT-pattern injection behavior is unchanged.

### code v1.11.9

#### Added
- `subagent-stop-hook.sh` agent perf event extended with token aggregation and routing metadata. The hook now parses the agent transcript JSONL, sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` across assistant turns, and tracks `total_context_tokens` as the per-turn high-water mark (max of any single turn's full usage) rather than a cumulative running total — preserving a peak-pressure signal instead of collapsing to the final sum. The event also carries `model` and `parent_session_id` from the hook payload (emitted as `null` when absent) and a `command` field that defaults to `"interactive"` when `CLOSEDLOOP_COMMAND` is unset, matching `record_phase.sh` and `run-loop.sh`'s `emit_perf_event` so phase, iteration, pipeline_step, and agent rows can be joined by command in Datadog. Transcript selection keys on top-level `type == "assistant"` reading `.message.usage` (mirroring `stream_formatter._accumulate_usage`); a malformed or missing transcript fails open and emits zero-token fields without aborting the hook. Every numeric field defaults to `0` on missing or malformed input, and existing `perf.jsonl` consumers ignore unknown fields, so the additive shape is safe. New tests in `test_subagent_stop_hook.py` cover token sums with cache reads, per-turn HWM, missing/malformed transcripts, model/parent_session_id null handling, and the command-default join contract.

#### Changed
- `command:` field is now populated on every `perf.jsonl` event row produced by the orchestrator and producer scripts. `run-loop.sh::emit_perf_event()` adds `command:` (defaulting to `"interactive"` when `CLOSEDLOOP_COMMAND` is unset) so every `phase`, `iteration`, and `pipeline_step` event carries it; `record_run.sh` emits its singular `run` event on every fresh-start Loop; `record_phase.sh` always includes `command:` in the emitted JSON. The fail-open `trap 'exit 0' ERR` contract on the producer scripts is preserved. `test_record_run.py` and `test_record_phase.py` are updated to assert the `command:` field is present on every event; `plugins/code/README.md`'s `record_run.sh` description now reads "Emitted unconditionally and fails open".

### code v1.11.8

#### Fixed
- `run-loop.sh` now classifies known Claude terminal failures before generic exit-code retry handling. Structured JSONL/stderr rate-limit, context-limit, and auth/account challenge signals write signed `loop-error.json` markers with stable subcodes, archive `claude-output.jsonl` through the existing `claude-output.name.txt` sidecar, release lock/state, and stop retrying. Unknown or malformed failures remain generic, and successful prose mentioning rate limits no longer creates false markers. Marker messages derived from Claude JSONL are clamped before reaching the existing 1000-character marker writer limit. New tests in `test_run_loop_failure_marker.py` cover observed rate-limit JSONL, camelCase API status, stderr context limits, auth/account challenges, oversized messages, false-positive prose, and rate/context marker finalization.

#### Changed
- Decision-table review guidance now calls out adapter-variant ORM/database error metadata and existing-data migration blockers for new uniqueness constraints or stricter persisted invariants. The edge-case and review-prevention references require rows and tests for constraint-name strings, field/column arrays, missing or unrelated metadata, duplicate/invalid existing rows, cleanup/backfill paths, explicit preflight failures, and migration races.

### code v1.11.7

#### Added
- Per-run `claude-output.jsonl` archival in `run-loop.sh`. New helpers `sanitize_output_run_id`, `rename_orphan_output_on_start`, and `rename_output_on_exit` rename the live JSONL to `claude-output-<run_id>.jsonl` on every loop exit (including spurious-complete, interrupt, and error paths) and write a `claude-output.name.txt` sidecar pointing at the latest archived file. On startup, any orphaned `claude-output.jsonl` left from a prior run is renamed using the previous `RUN_ID` from `state.json` or the last entry in `runs.log` (or an `orphan-<timestamp>` fallback), and the sidecar is cleared so consumers do not read stale prior-run pointers. Run id values are sanitized (`[^A-Za-z0-9._-]` collapsed to `_`) before being interpolated into the destination filename. New tests in `test_run_loop_failure_marker.py` cover the rename-on-exit, orphan-rename-from-runs.log, and workdir-root `runs.log` paths.
- Claude session-id capture in `run-loop.sh`. New helpers `extract_claude_session_id` (jq-based extraction across `session_id`/`sessionId`/`message.*`/`item.*` shapes), `record_claude_session_id` (sets `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID`, exports `CLOSEDLOOP_SESSION_ID`), and `sanitize_runs_log_field` (strips `\r`/`\n` and replaces `|` with `_`). `record_claude_session_id` writes `$workdir/session-id.txt` only for the `plan_execute` command so post-loop `code_review` and fix sessions do not overwrite the operation-level correlation id consumed by desktop finalization. Plan/execute, post-loop review, and fix invocations now capture session ids and route them into the runs.log entry for that step. New tests cover the primary plan/execute write, the code-review preservation of the primary session, and the runs.log workdir-root location with sanitized command/session fields.

#### Changed
- `write_runs_log_entry` in `run-loop.sh` now writes to `$workdir/runs.log` instead of `$workdir/.learnings/runs.log`, matching the new `self-learning` `prune-learnings.sh` and `evaluate_goal.py` location. Keeps the runs ledger at the workdir root next to `state.json` and `plan.json` rather than nested inside `.learnings/`.
- `runs.log` row format extended to `run_id|timestamp|goal|iteration|status|command|last_session_id`. The first five fields are the legacy contract; `command` (e.g. `plan_execute`, `code_review`, `self_learning`) and `last_session_id` are append-only so older self-learning readers stay compatible. `write_runs_log_entry` accepts optional 4th/5th arguments for explicit command/session overrides and falls back to `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID` (or `session-id.txt`) otherwise.
- `--codex-model` default in the `/code:plan-with-codex` README documentation updated from `gpt-5.4` to `gpt-5.3-codex` to match the actual command default.

### self-learning v1.2.4

#### Fixed
- `evaluate_reduce_failures` in `self-learning/tools/python/evaluate_goal.py` only consults the `CLOSEDLOOP_ITERATION` environment variable as a fallback when the current `run_id` is not found in `runs.log`. Previously the env var unconditionally overwrote the iteration count parsed from `runs.log`, which could mis-score goals when an outer loop exported a stale `CLOSEDLOOP_ITERATION` value.

### self-learning v1.2.3

#### Changed
- `perf_summary.py` agent-event schema docstring promotes `command` to a required field on both `agent` and `phase` events, matching the producer behavior in `subagent-stop-hook.sh`, `record_phase.sh`, `record_run.sh`, and `run-loop.sh::emit_perf_event()`. `model`, `parent_session_id`, and the four token-count fields (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) plus `total_context_tokens` remain marked optional because they fall back to `null`/`0` when the SubagentStop payload or transcript is missing or unparseable. Coordination version bump alongside `code` v1.11.9 so the two plugins ship together as a matched set.

### self-learning v1.2.2

#### Changed
- `prune-learnings.sh` and `evaluate_goal.py` now read and rotate `runs.log` from `$WORKDIR/runs.log` instead of `$LEARNINGS_DIR/runs.log` (`<workdir>/.learnings/runs.log`). The runs ledger now lives at the workdir root alongside `state.json` and `plan.json`, matching where `run-loop.sh` writes it. New tests `test_prune_learnings.py` and a `test_reduce_failures_reads_runs_log_from_workdir_root` case in `test_evaluate_goal.py` lock in the new location.
- `goal-stats` command documentation (`commands/goal-stats.md`) now describes the pipe-delimited `runs.log` row format `run_id|timestamp|goal|iteration|status[|command|last_session_id]` and notes that `command` and `last_session_id` are optional append-only fields so legacy 4+ field rows remain valid. The `runs.log` data-source description was updated to mention the optional command/session correlation columns.
- `evaluate_goal.py` comment on `RUNS_LOG_MIN_FIELDS` clarifies that reduce-failures only needs `run_id` and `iteration`, so legacy 4+ field rows and newer session-correlated rows are both accepted.

#### Fixed
- `prune-learnings.sh` session enumeration in `prune_sessions()` no longer relies on `mapfile` piped through `tac`. Replaced `mapfile -t all_sessions < <(ls -1t "$sessions_dir" | tac)` with a `while IFS= read -r ... done < <(ls -1tr ...)` loop, which avoids the `tac` external dependency (not present on default macOS) and keeps the oldest-first ordering needed for FIFO pruning.

### code v1.11.6

#### Added
- New `record_run.sh` script emits exactly one `run` event per Loop to `perf.jsonl` carrying `command`, `repo`, `branch`, and `started_at`, so every perf record can be attributed to the slash-command that launched the Loop. Fails open on any unexpected error (`trap 'exit 0' ERR`). Invoked synchronously from `run-loop.sh:main()` with `|| true` and only on fresh-start invocations (resumed Loops do not re-emit), so the `run` event is appended before the first `phase` event without ever changing the Loop's exit code and without violating PRD-254 AC-1's "exactly one `run` event per Loop" guarantee.
- New `CLOSEDLOOP_COMMAND` environment variable exported by `run-loop.sh` next to `CLOSEDLOOP_RUN_ID`, derived from `PROMPT_NAME` and defaulting to `interactive` for bare `/code:code` invocations. The launching command is also persisted in `state.json` (`command:` field in the YAML frontmatter) and restored on resume so `CLOSEDLOOP_COMMAND` keeps its original value instead of degrading to `"interactive"` when the `--prompt` CLI flag isn't re-passed. Older state files lacking the `command` field preserve prior behavior. Hooks and child processes inherit the variable automatically.
- New `command` field on every `phase`, `iteration`, `pipeline_step`, and `agent` perf event. Implemented in `record_phase.sh`, `subagent-stop-hook.sh`, and the `emit_perf_event` helper in `run-loop.sh` (single `jq -n -c` filter per event — no extra `jq` invocation cost).
- `record_run.sh` captures `repo` and `branch` via `git -C` with GNU `timeout` as a hang guard when available, falling back to bare `git -C ...` when `timeout` isn't on `PATH` (default macOS without `coreutils`) so dev machines never silently emit empty `repo`/`branch` fields.
- New `plugins/code/tools/python/test_record_run.py` (covering JSON shape, fail-open paths, repo/branch capture under a fake-`git` PATH shim, and a no-`timeout`-on-PATH regression case) and `plugins/code/tools/python/test_record_phase.py` (covering field correctness and missing-state fail-open). Both files run under `pytest` with no extra fixtures.
- One-line note in `prompts/prompt.md` documenting that `record_run.sh` is invoked automatically by `run-loop.sh` at the start of every Loop (before Phase 0.9) and requires no orchestrator action.

### self-learning v1.2.1

#### Changed
- Coordination version bump alongside `code` v1.11.6 per the PRD-254 producer-side rollout (FEA-887). No functional changes; the bump exists so the two plugins ship together as a matched set, mirroring the FEA-764 precedent.

### code v1.11.5

#### Fixed
- Phase 1 of the orchestrator prompt (`plugins/code/prompts/prompt.md`) now tolerates a `plan.json` whose contents are raw markdown instead of JSON — a shape produced by older gateway versions that wrote the plan source straight to `plan.json`. Before activating the `code:plan-validate` skill, the orchestrator validates `plan.json` with `python3 -m json.tool`; if parsing fails, it renames the file to `plan-source.md`, sets `CLOSEDLOOP_PLAN_FILE` to that path, marks `plan_was_imported = true`, and routes through `@code:plan-importer`. A new branch in the "plan.json does NOT exist" path also picks up a pre-existing `plan-source.md` for import. This unblocks runs that previously failed at Phase 1 with `EMPTY_FILE`/`FORMAT_ISSUES` against markdown content.

### code v1.11.4

#### Added
- Three new common-misses items (13-15) and two new contract-heavy review-surface bullets in the `decision-table` skill's `references/review-prevention.md`: **replay or continuation path bypasses an initial-entry gate** (conflict replays, retry callbacks, confirmation callbacks, and deferred command callbacks must enforce the same guard, policy, validation, target resolver, or health check as the original entry path); **owner-scoped pending state leaks across surfaces** (loading, disabled, or label state reading a global pending/checking flag without matching the current owner, command, document, target, or attempt id); and **sentinel value semantics collapse** (omitted, `undefined`, `null`, empty, and explicit payload values that have different downstream meaning but are defaulted, coalesced, or serialized as the wrong shape).

#### Fixed
- `detect_spurious_complete` in `run-loop.sh` was firing on legitimate `AWAITING_USER_SEQUENCE` hard stops (most visibly the Phase 1.1 plan review checkpoint), causing `/code:code` to fail with a `PENDING_TASKS_BLOCKED_BY_QUESTIONS` marker the moment the orchestrator drafted a new plan. The detector inspected only `plan.json`, where pending tasks and open questions are expected on a freshly drafted plan. It now reads `state.json.status` first and short-circuits when the status is `AWAITING_USER` — final-completion regressions (`status: "COMPLETED"` with leftover `pendingTasks`) are still flagged as before. New tests in `test_run_loop_failure_marker.py` cover the AWAITING_USER skip plus the existing positive/negative cases for `detect_spurious_complete`.
- Phase 5.5 telemetry instruction in the orchestrator prompt now writes `decision-table-verifications.jsonl` directly under `$CLOSEDLOOP_WORKDIR` instead of `$CLOSEDLOOP_WORKDIR/.closedloop-ai/`, matching where the rest of the run's per-loop artifacts (`plan.json`, `log.md`, `state.json`) live and avoiding a bespoke nested directory the haiku subagent had to `mkdir -p` on every Phase 5.5 exit.

### code v1.11.3

#### Added
- Four new edge-case sections in the `decision-table` skill's `references/edge-cases.md`: **State propagation across isolation boundaries** (subprocesses, workers, callbacks, transactions, child tasks — require explicit propagation rows for success, validation failure, dependency failure, cancellation/timeout, and partial-output branches, plus a real production-sequencing test); **Finalizer-visible cleanup state** (deferred finalizers, traps, disposers, signal handlers, process-exit hooks — require rows describing handle scope, clearing, and exit-via-error paths, plus a failure-path test that exits through the real finalizer); **Transformed input validation parity** (trim/parse/decode/normalize/canonicalize/default/coerce flows — require rows for raw, transformed, validated, and consumed values plus mutations that prove validation runs against the consumed value); **Canonical value persistence** (paths, identities, endpoints, workspaces, profiles, tenants — require rows distinguishing raw, expanded, normalized, canonical/resolved, and serialized output, plus alternate-spelling tests proving durable output uses the canonical value).
- Five new common-misses items (8-12) and six new contract-heavy review-surface bullets in the `decision-table` skill's `references/review-prevention.md` covering: cleanup/finalizer state scoped too narrowly for the actual cleanup mechanism; durable output that serializes raw input after validation used a transformed value; validation that checks a different representation than the consumed value; state produced inside an isolated execution context without an explicit propagation mechanism; and distinct modeled states whose observable status/message/affordance/styling/telemetry/response signal is indistinguishable in implementation despite the table treating them as different outcomes.

### code-review v1.5.5

#### Fixed
- `/start` command now passes `--diff-scope` and `--original-scope` to `code_review_helpers.py` using the `--flag=value` form instead of `--flag "value"` (three call sites: standard-flow `extract-patches`, fast-path `extract-patches`, and `auto-incremental`). The space-separated form caused `argparse` to treat scope values that began with a leading dash as a separate option and fail with `unrecognized arguments`; the `=` form binds the value unambiguously.

### code v1.11.2

#### Fixed
- Migrated 6 SKILL.md files (`build-status-cache`, `codex-review`, `critic-cache`, `cross-repo-cache`, `extract-plan-md`, `plan-validate`) and the `plan-with-codex` command from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable (commands use `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`). The `<base_directory>` placeholder was relying on the model to infer the path from context — Claude Code's harness only pre-substitutes `${CLAUDE_SKILL_DIR}` (per the [official skills docs](https://code.claude.com/docs/en/skills.md)), so the prior pattern was unreliable. Removed the now-stale "shown above as 'Base directory for this skill'" explanatory text from the affected SKILL.md files.
- Phase 5 build-cache stamp instruction in the orchestrator prompt was using a relative `bash scripts/check_build_cache.sh` path that resolved against the orchestrator's CWD (typically wrong). Replaced with the absolute `bash "$CLAUDE_PLUGIN_ROOT/skills/build-status-cache/scripts/check_build_cache.sh" "$CLOSEDLOOP_WORKDIR" stamp` pattern that matches the other cache-stamp invocations in `prompt.md`.
- Migrated bare `python ...` invocations to `python3 ...` in `find-plugin-file` SKILL.md (7 examples + the slash-command integration snippet), `find_plugin_file.py` docstring, and the `amend-plan` command (12 invocations of `python "$AMEND_STATE_PATH" ...`). Modern macOS and many Linux distros do not symlink `python` → `python3`, so bare `python` was failing with `command not found: python` mid-orchestration when the orchestrator activated the `find-plugin-file` skill or ran `amend-plan` from `prompt.md`-driven workflows.
- `run-loop.sh` now guards against spurious `<promise>COMPLETE</promise>` emissions. The orchestrator's Phase 7 contract forbids emitting `COMPLETE` when `plan.json` has pending tasks, but it sometimes violates that contract — typically when tasks are blocked by unanswered questions. The runner now reads `plan.json` directly (not via `validate_plan.py` extraction, which would mask `pendingTasks` on a `FORMAT_ISSUES` plan), and if `pendingTasks` is non-empty after `COMPLETE` is detected, it routes through `fail_loop_user_visible` (from v1.11.1) with `RUNNER_ERROR` plus `PENDING_TASKS_BLOCKED_BY_QUESTIONS` (when open questions remain) or `PENDING_TASKS_AT_COMPLETION`. The `loop-error.json` marker carries an actionable user message; post-loop code review is skipped. New helpers `detect_spurious_complete()` and `handle_spurious_complete()` keep the orchestration loop readable. `iteration` perf events use `status="spurious_complete"` instead of `"completed"` for these cases.
- `run-loop.sh` now signs user-visible `loop-error.json` markers with the per-run `CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET` provided by Electron, then unsets the exported env var before spawning Claude. This lets the parent harness emit trusted intentional failure markers while preventing repository/tool commands from forging the marker by writing JSON directly into the workdir. Failure-marker tests now cover signed output, missing-secret rejection, and secret removal from the exported environment.

#### Changed
- Flattened `CHANGELOG.md` structure: removed the `## [Unreleased]` and `## [Releases]` separator headings. Every plugin entry is now listed newest-first under the top-level `# Changelog` heading and is treated as released when merged to `main`. Updated `.claude/commands/update-documentation.md` to teach `/update-documentation` runs not to reintroduce those headings.

### code-review v1.5.4

#### Fixed
- Migrated 25+ bare `python <HELPERS> ...` invocations in the `/start` command to `python3 <HELPERS> ...`. Same root cause as the corresponding `code` plugin entry — bare `python` is unresolved on modern macOS and many Linux distros.

### judges v1.5.2

#### Fixed
- Migrated `eval-cache` SKILL.md from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable. Removed the stale "shown above as 'Base directory for this skill'" explanatory text. See the corresponding `code` plugin entry for context.

### platform v1.1.3

#### Fixed
- Migrated `upload-artifact` SKILL.md (both `--list-projects` and upload invocations) from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable. See the corresponding `code` plugin entry for context.

### code v1.11.1

#### Added
- New runner-side user-visible failure marker infrastructure in `run-loop.sh`. Helpers `write_loop_user_visible_failure()` and `fail_loop_user_visible()` emit a structured `{code, message, result.subcode}` JSON marker to `$CLOSEDLOOP_WORKDIR/loop-error.json` so downstream consumers (e.g. the Electron desktop app's finalizer) can surface actionable runner failures to the user. Inputs are validated: `code` against an allowlist (`RUNNER_ERROR`, `PRE_RUN_VALIDATION_FAILED`, `PLAN_STATE_UNAVAILABLE`), `subcode` against `^[A-Z][A-Z0-9_]{2,63}$`, and `message` length 1-1000 characters. Marker is written atomically (`tmp` then `mv`) under `umask 077`. The bottom-of-file `trap` and `main "$@"` invocation are now guarded by `[[ "${BASH_SOURCE[0]}" == "$0" ]]` so the script can be sourced (e.g. by tests) without launching the loop. New tests in `plugins/code/tools/python/test_run_loop_failure_marker.py` cover the happy path, the unsupported-code rejection, and the fail-and-exit path.

### judges v1.6.0

#### Added
- Feature artifact type support (`--artifact-type feature`) in `run-judges` skill — evaluates feature artifacts using 3 judges (`feature-completeness-judge`, `prd-testability-judge`, `prd-dependency-judge`) in 1 batch and writes `$CLOSEDLOOP_WORKDIR/feature-judges.json`. Explicitly excludes `prd-auditor` (assumes US-###/AC-#.# numbering not present in feature artifacts) and `prd-scope-judge` (assumes In/Out-of-Scope sections not required for feature artifacts). Reuses `prd_preamble.md` — no separate `feature_preamble.md` is needed.
- `"feature"` category in `validate_judge_report.py`: added to `JUDGE_REGISTRY` with 3 expected judges, to `VALID_SUFFIXES` mapping `feature` to `["-feature-judges"]`, and to `DEFAULT_FILENAMES` mapping `feature` to `feature-judges.json`.
- `TestCategoryFeatureValidation` test class in `validate_judge_report.py` tests with 8 test methods covering the new feature category.
- Complete `SKILL.md` documentation for feature mode in `run-judges` skill.

### judges v1.5.2

#### Added
- New `feature-completeness-judge` agent (sonnet) that evaluates incoming Feature/PRD requests for readiness before plan creation. Reads `$CLOSEDLOOP_WORKDIR/prd.md` and emits a CaseScore. Applies five checks: Problem Statement Presence (blocking, user-pain framings only — pure business-opportunity framings no longer satisfy the check), Clarity and Specificity (major, with context-aware suppression of vague qualifiers when the same paragraph supplies a measurable target, observable behavior, or bounded scope reference), Acceptance Criteria (major), Ambiguous Language (minor, capped at 5), and Solution Essence (blocking — Feature must include either a Proposed Solution or a Desired Outcome section).

#### Changed
- `run-judges` PRD mode now runs the 5 PRD judges across **2 sequential batches** (`batch_1`: feature-completeness-judge + prd-auditor + prd-scope-judge; `batch_2`: prd-dependency-judge + prd-testability-judge) to respect the Task tool's 4-concurrent-agent limit. Sub-step numbering renumbered (`batch_1=1`, `batch_2=2`, `aggregate=3`, `validate=4`); skill description, batch tables, success checklist, troubleshooting guide, and PRD Mode Execution Flow narrative all updated.
- `JUDGE_REGISTRY["prd"]` in `validate_judge_report.py` now includes `feature-completeness-judge`; PRD validator tests updated for 5-judge expectations.

### code v1.11.0

#### Added
- New `record_phase.sh` script that appends a `phase` event to `perf.jsonl` from the current `state.json`. Captures `phase`, `status`, `start_sha`, `started_at`, `run_id`, and `iteration` so per-phase wall-clock durations can be reconstructed across an entire run.

#### Changed
- Orchestrator State Tracking section in `prompt.md` now instructs the orchestrator to call `record_phase.sh` after every `state.json` write (non-blocking; failures ignored). Phase events stream into the same `perf.jsonl` file as iteration, pipeline_step, and agent timing events.

### self-learning v1.2.0

#### Added
- New `summarize_phases()` aggregator in `perf_summary.py` that reads `phase` events from `perf.jsonl`, derives per-phase durations from the gap to the next phase event in the same `(run_id, iteration)` (or to the iteration's `ended_at` for the final phase), and reports count/avg/min/max/total. Phases never pair across iteration boundaries.
- Phases summary table added to `perf_summary.py` text output and `phases` field added to its JSON output, alongside the existing Iterations / Pipeline Steps / Sub-steps / Agents tables.
- New `--timeline` CLI flag and `phase_timeline()` function in `perf_summary.py` that emits a chronological per-instance view (one row per phase invocation with `run_id`, `iteration`, `started_at`, `ended_at`, `duration_s`). Incomplete final phases (no following phase event AND no iteration `ended_at`) are emitted with `ended_at=""` and `duration_s=null` so in-progress runs remain visible. Works with `--format json` for machine-readable output.
- Tests for phase summarization and timeline covering iteration boundaries, missing iteration end (final phase skipped vs surfaced), aggregation across iterations, total-time descending sort, and per-row run/iteration provenance.

### code v1.11.0

#### Added
- New `decision-table` skill for generating code-grounded decision-table artifacts that map current vs. intended control-flow behavior, capturing recovery, retry, finalization, validation, and state-machine edge cases under `.closedloop-ai/decision-tables/`. Includes baseline/target table rules, behavioral edge-case expansion guidance (call-site inventory for shared surfaces, exception scope, serverless async side effects, testable invariants), post-implementation verification sections, contract-heavy review checklist, and a referenced artifact format template at `references/artifact-format.md`.
- New `behavior-verifier` agent that activates the `decision-table` skill in verification-only mode (SKILL.md step 17), reads final code against the artifact's Intended Change rows, appends Verification Findings and Final Alignment Status, and emits a structured `ALIGNED` or `MISALIGNED` verdict with a typed `<drift_rows>` JSON block (`code_drift`, `test_drift`, `plan_ambiguity`) for orchestrator routing. Read-and-report only — never modifies code or tests.
- Optional `decisionTable` property on the plan schema (`path` + `status` enum: `pending|aligned|aligned_with_clarifications|verification_failed`) so the orchestrator can persist artifact pointers and verification state across iterations.
- Phase 5.5 Behavioral Verification loop in the orchestrator prompt with a 5-attempt cap, drift routing by kind (`code_drift` → `implementation-subagent`, `test_drift` → `test-engineer`, `plan_ambiguity` → haiku append), parse-failure circuit breaker, and per-run telemetry emit to `.closedloop-ai/decision-table-verifications.jsonl` (timestamp, final status, iteration count, drift counts, parse failures, phase duration).
- `startSha` state-tracking field initialized once per run from `CLOSEDLOOP_START_SHA` in `config.env` and propagated on every `state.json` write so Phase 5.5 can scope the changed-file set without re-reading config.

#### Changed
- `plan-writer` Finalize Mode now generates the decision-table artifact via a snapshot/set-difference algorithm (mkdir → ls before → activate `decision-table` skill → comm -13 to compute new files) and writes `decisionTable.path` + `status: "pending"` into `plan.json`. Skips when `plan_was_imported=true` or `simple_mode=true`. Emits `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH` and withholds `PLAN_WRITER_COMPLETE` when 0 or >1 new artifact files appear, delegating the hard stop to the orchestrator rather than guessing.
- `plan-writer` Completion section adds a decision-table gate that re-verifies `plan.json.decisionTable.path` is non-empty and the artifact file is non-zero bytes before emitting `PLAN_WRITER_COMPLETE`.
- `plan-validate` skill now validates the optional `decisionTable` shape and surfaces `decision_table_path` and `decision_table_status` in the `extract_data` output (always present; empty strings when the field is absent), so the orchestrator can read both values without touching the filesystem. PLAN_VALID example in `SKILL.md` updated.
- Phase 2.7 in the orchestrator prompt now passes `plan_was_imported` and `simple_mode` flags through to `plan-writer` and inspects the launch output for `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH`. On marker present: executes AWAITING_USER_SEQUENCE pointing at `.closedloop-ai/decision-tables/` and HARD STOPS, treating the marker as authoritative even if `PLAN_WRITER_COMPLETE` was also emitted.
- Phase 7 completion summary now reads `decision_table_status` from the latest `plan-validate` output and logs `Behavioral alignment verified` (or `…with plan clarifications`) referencing the artifact path.
- `loop-agents.json`: registered `code:behavior-verifier` (max 3 iterations, promise `BEHAVIOR_VERIFIER_COMPLETE`, ALIGNED/MISALIGNED criteria with required `<drift_rows>` fields and `kind` enum); extended `code:plan-writer` `verification_criteria` so `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH` is a legitimate detection state, not a loop failure. `code:behavior-verifier` added to `learning_agents.agents` for capture coverage.
- Available Skills table in the orchestrator prompt now lists `code:decision-table` with usage in Phase 2.7 (generation via plan-writer) and Phase 5.5 (verification-only via behavior-verifier).

### code v1.9.4

#### Fixed
- `setup-closedloop.sh` no longer clobbers `CLOSEDLOOP_PLAN_FILE` when the env var is already set by the caller (e.g. closedloop-electron). Previously, omitting `--plan` unconditionally overwrote the env var with an empty string, causing imported plans to be silently ignored and regenerated from scratch.

### code v1.9.3

#### Changed
- Migrated subagent resumption pattern from Task-based re-launch to SendMessage continuation across orchestrator prompt, `visual-qa-subagent` agent, `iterative-retrieval` skill, and `/code` command allowed-tools list
- Orchestrator Phase 6 INCOMPLETE_DOCS and BLOCKED handlers now store `agent_id` from initial Task spawn and continue via `SendMessage(to=<agent_id>)` instead of launching fresh Task instances
- Added async wait rule requiring orchestrator to wait for `<task-notification>` before proceeding after SendMessage dispatch
- `run-loop.sh` now pins `--model claude-opus-4-6` and `--effort high` on the per-iteration `claude` invocation

### code-review v1.5.3

#### Fixed
- Clarified `partitions.json` schema documentation in `/start` command. The partition output's `files[]` entries use the key `file` (not `path`) for the file path, but the prior doc only listed the entry-level shape implicitly via `{filepath_1}` placeholders. The underspecification caused the orchestrator LLM to construct ad-hoc Python one-liners against `partitions.json` using `f['path']`, throwing `KeyError: 'path'` mid-pipeline. The doc now spells out each entry as `{"file", "loc", "is_test", "line_range"?}`, adds a placeholder-to-source mapping for the per-agent prompt template, and instructs the orchestrator to use the Read tool rather than introspect the JSON shell-style.

### code-review v1.5.2

#### Fixed
- Fixed `test_github_mode` test isolation to prevent `CR_GLOBAL_CACHE` environment variable from leaking into test assertions

### code v1.9.2

#### Changed
- `run-loop.sh` and `debate-loop.sh` now consume the `CLAUDE_BIN` environment variable when set, falling back to bare `claude` otherwise. Complements closedloop-electron PR #111 so the Electron desktop app's pre-validated claude binary path is actually used by every subprocess invocation -- fixes silent failures for users whose `claude` is installed outside `/opt/homebrew/bin` (non-Homebrew macOS setups, manual symlinks, etc.)
- `debate-loop.sh` dependency check verifies the resolved `$CLAUDE` path rather than a bare `claude` lookup, so custom binary locations are correctly validated at startup

### code v1.9.1

#### Added
- `--request-file` parameter in `codex-review` skill and `run_codex_review.sh` so Codex reads the original user request before reviewing and judges the plan against the actual request, not just the plan's self-framing
- "Re-scoped" revision-summary bucket in `plan-agent` for findings accepted as the minimal required or enabling change
- Additional tests in `test_setup_closedloop.py` covering unquoted paths with spaces in slash-command arguments

#### Changed
- `plan-agent` scope discipline now distinguishes between required work, justified localized enabling refactors, and true optional scope creep — findings are no longer rejected solely because they look broader than the current task
- `/plan-with-codex` command switched from `Agent(resume=...)` to `SendMessage` for plan-agent continuation across rounds, preserving full prior context via transcript auto-resume
- Round-aware Codex review prompts in `run_codex_review.sh`: round 1 is a broad material audit, rounds 2-4 are delta reviews that verify prior findings, rounds 5+ are blocker-only convergence reviews
- `debate-loop.sh` now forwards the original prompt to `run_codex_review.sh` via `--request-file` and uses the refactor-aware revision guidance when asking plan-agent to revise
- `setup-closedloop.sh` argument parser tolerates unquoted paths containing spaces by joining consecutive non-flag tokens into a single value for `--prd`, `--plan`, `--add-dir`, and the positional workdir
- `/code` slash command now invokes `setup-closedloop.sh` via `bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-closedloop.sh"` for portability
- `run-loop.sh` now emits quoted `/code:code` arguments for workdir, `--prompt`, `--prd`, and `--add-dir` in loop state, preserving argument boundaries for values that contain spaces
- `plan-with-codex` command gains `SendMessage` in its allowed-tools list

### platform v1.1.2

#### Changed
- `upload-artifact` skill renamed terminology from "artifact" to "document" to match the renamed ClosedLoop MCP tools (`create-artifact` → `create-document`, `create-artifact-version` → `create-document-version`). Skill description, prompts, and result reporting updated accordingly.
- `upload-artifact` now supports the `FEATURE` document type alongside `PRD`, `IMPLEMENTATION_PLAN`, and `TEMPLATE`.
- `upload_artifact.py` and the skill's `--artifact-id` flag now accept a UUID or a user-facing slug (`PRD-*`, `PLN-*`, `FEA-*`) for new-version uploads; the MCP server resolves the identifier. `--project-id` and `--workstream-id` similarly accept slugs (`PRO-*`, `WRK-*`).
- Result payloads now include `document_id` (mirroring `artifact_id` for backward compatibility) and report the document slug alongside the ID.
- `context-engineering` skill: Refactoring Existing Prompts section gains a "Dropped qualifiers" pitfall row (load-bearing single modifiers like `only`, `unless`, `when appropriate`, `must`, `never`) and a four-step Validation Pass that requires labeling every removed line as relocated, redundant, or dropped on purpose before declaring a refactor done.

### platform v1.1.1

#### Changed
- `upload-artifact` skill now reads `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` from the current shell environment instead of `.env.local`, and falls back to MCP mode when either variable is missing
- `upload_artifact.py` defaults `--api-key` and `--url` to the `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` environment variables, exiting with a clear parser error when neither the flag nor the env var is set

### self-learning v1.1.2

#### Changed
- `process-chat-learnings.sh` now consumes the `CLAUDE_BIN` environment variable when set, falling back to bare `claude` otherwise — matches the `code` plugin pattern so desktop-spawned learning runs use the pre-validated binary

### bootstrap v1.2.0

#### Changed
- Migrated critic-gates configuration path from `.claude/settings/critic-gates.json` to `.closedloop-ai/settings/critic-gates.json` across `agent-decomposer`, `agent-prompt-validator`, `generation-validator`, and `agent-bootstrap` command
- Migrated schema validation path from `.claude/schemas/` to `.closedloop-ai/schemas/` in `agent-prompt-validator`
- Updated agent output path references from `.claude/runs/` to `.closedloop-ai/runs/` in `agent-prompt-generator`
- Updated bootstrap configuration documentation in `agent-bootstrap.md` to reference `.closedloop-ai/` state directory

### code v1.9.0

#### Added
- Multi-repo planning and exploration support via new `--add-dir` flag in `run-loop.sh`, exposing `CLOSEDLOOP_ADD_DIRS` and `CLOSEDLOOP_REPO_MAP` env vars to downstream agents
- `pre-explorer` agent produces per-repo code maps (`code-map-{name}.json`) when secondary repos are supplied
- `plan-draft-writer` agent emits multi-repo plans with a `## Repositories` table and `@{repo}:path` task prefixes
- `repositories` map field added to the plan root schema in `plan-schema.json` for multi-repo plan traceability, keyed by repo short-name with `path` and `isPrimary` metadata
- Tier 0 explicit-directory discovery and dedup helpers in `discover-repos.sh`, with structured JSON output and a `local: true` marker on `--add-dir` peers
- Tests for `discover-repos.sh` and `setup-closedloop.sh` (`test_discover_repos.py`, `test_setup_closedloop.py`) plus new multi-repo cases in `test_validate_plan.py`

#### Fixed
- `run-loop.sh` now scans the full per-iteration stream for the `<promise>` completion marker instead of only inspecting the final `type==result` record, preventing missed completion signals when the orchestrator emits the promise in an intermediate message followed by additional tool_use or wrap-up output
- `discover-repos.sh` now filters add-dirs that are ancestors of the workdir and deduplicates repo entries to prevent duplicate discovery results

#### Changed
- Consolidated Tier 0 `discover-repos.sh` tests into a single scenario-driven harness, replacing the prior fragmented per-case test files
- Migrated workdir internal state directory from `.closedloop/` to `.closedloop-ai/` across hooks, setup scripts, and loop state management
- Established `CLOSEDLOOP_STATE_DIR` constant as single source of truth for state directory name across shell scripts
- Added `Skill` to `plan-evaluator` agent's allowed tools to enable `code:plan-validate` skill execution

### code v1.6.0

#### Changed
- Migrated all remaining `.claude/` path references to `.closedloop-ai/` across hooks, scripts, agents, skills, and orchestrator prompt -- completes the directory migration started in v1.1.0
- Replaced `gawk` FPAT-based TOON parser with portable `csv_split()` function in `pretooluse-hook.sh` and `subagent-start-hook.sh`, removing the hard dependency on GNU awk
- Refactored awk array usage from associative `patterns[n]["key"]` to parallel flat arrays for POSIX awk compatibility
- Updated `install-dependencies.sh` to verify any `awk` instead of requiring `gawk` with FPAT support
- Updated org learnings copy path in `run-loop.sh` to use `.closedloop-ai/learnings/` with workdir-adjacent state directory resolution

#### Removed
- Removed all legacy `.claude/.closedloop/` session/workdir/env fallback paths from `loop-stop-hook.sh`, `pretooluse-hook.sh`, `session-end-hook.sh`, `subagent-start-hook.sh`, `subagent-stop-hook.sh`, and `setup-closedloop.sh`
- Removed legacy `~/.claude/.learnings/org-patterns.toon` fallback from `pretooluse-hook.sh` and `subagent-start-hook.sh`
- Removed legacy cleanup logic from `session-end-hook.sh` (PID cleanup, stale session removal, legacy directory deletion)

#### Added
- Tests for legacy path ignorance in pretooluse and subagent-start hooks, setup-closedloop, and self-learning flag tests
- Tests for portable awk injection (`test_injects_when_only_plain_awk_is_available`) in both hook test suites

### code-review v1.4.0

#### Changed
- Migrated GitHub mode output file paths from `.claude/` to `.closedloop-ai/`: `code-review-findings.json`, `code-review-threads.json`, and `code-review-summary.md`
- Updated `route` subcommand to read critic-gates from `.closedloop-ai/settings/critic-gates.json`
- Simplified fast-path routing to `total_loc <= 200` threshold only (was `<= 150 LOC AND <= 5 files AND no domain critics`); domain critics are now folded into the fast-path agent as an additional pass

#### Added
- Structured reasoning protocol for Premise Reviewer: `AUTHOR'S CLAIM / COUNTER-EVIDENCE / ALTERNATIVE CHECK / CONCLUSION` validation gate before reporting premise findings
- Reasoning certificate for Bug Hunter A: `PREMISE / TRACE / DIVERGENCE / GUARD CHECK / CONCLUSION` trace-based bug confirmation gate with emission filtering
- Domain critic pass injection in fast-path reviewer via `{DOMAIN_CRITIC_PASS}` placeholder, enabling domain expert review within single-agent fast-path runs
- Replaced shared prompt reasoning checklist with structured `PREMISE / EVIDENCE / GUARD CHECK / SEVERITY CHECK` analysis framework

### judges v1.5.1

#### Changed
- Migrated perf-substep state paths from `.closedloop/` to `.closedloop-ai/` in `run-judges` skill telemetry instrumentation

### judges v1.5.0

#### Changed
- Migrated threshold override paths from `.claude/settings/threshold-overrides.json` to `.closedloop-ai/settings/threshold-overrides.json` in `run-judges` skill (both run-specific and repo-level locations)

### platform v1.1.0

#### Changed
- Version bump to align with cross-plugin `.closedloop-ai/` directory migration

### self-learning v1.1.1

#### Changed
- Established `CLOSEDLOOP_STATE_DIR` constant as single source of truth for state directory name in `bootstrap-learnings.sh`, `compute_success_rates.py`, and `write_merged_patterns.py`

### self-learning v1.1.0

#### Changed
- Migrated org learnings paths from `.claude/learnings/` to `.closedloop-ai/learnings/` across `pull-learnings`, `push-learnings`, and `bootstrap-learnings.sh`
- Migrated run path references from `.claude/runs/` to `.closedloop-ai/runs/` in `process-learnings` command
- Simplified `preflight-check.sh` to verify `awk` availability instead of requiring `gawk` with FPAT support

#### Removed
- Removed legacy `~/.claude/.learnings/org-patterns.toon` fallback from `compute_success_rates.py` and `write_merged_patterns.py`
- Removed legacy session file lookup path from `evaluate_goal.py`

#### Added
- Test verifying CLI ignores legacy home TOON path in `test_compute_success_rates.py`

### code v1.5.10

#### Changed
- Enhanced `plan-agent` with verification-before-proposing requirements: must `Read` every function, type, and validator before writing tasks that modify them; must check receiving validators/schemas when tasks construct events or payloads
- `plan-agent` now requires explicit task dependency declarations ("Depends on T-A.B"), null/empty/missing edge case specification for every new field, and accurate summary language (no overclaiming)
- Added multi-repository plan guidelines to `plan-agent`: absolute file paths for cross-repo references, per-repo file existence verification, repo labels on tasks, and cross-repo contract documentation
- Added self-check gates to `plan-agent`: modification targets verified, validators audited, edge cases specified, dependencies declared, summary accuracy confirmed -- with a concrete good-vs-bad task example

### code v1.5.9

#### Fixed
- `stream_formatter.py` now uses `Optional[str]` instead of `str | None` union syntax,
  making it import-safe on Python 3.9 and preventing silent JSONL pipeline truncation
  on macOS systems using the default system Python

### code v1.5.8

#### Removed
- Deleted `feedback-explorer` agent and removed its integration from `plan-with-codex` debate loop -- plan-agent now receives feedback directly without pre-fetched context briefs
- Removed `{stem}.context` sidecar file from `plan-with-codex` debate loop

#### Changed
- Updated default Codex model from `gpt-5.4` to `gpt-5.3-codex` in `plan-with-codex` command and `debate-loop.sh` (completes model migration started in v1.5.5)
- Reduced Codex reasoning effort from `xhigh` to `high` in `run_codex_review.sh`

### code v1.5.7

#### Added
- Ghost loop detection in `run-loop.sh` -- tracks consecutive empty iterations and aborts after 3 to prevent infinite loops with no output
- Session/context limit detection from `is_error` flag in Claude JSONL result records, with immediate abort and `context_limit` run log entry
- Session/context limit detection from stderr pattern matching (`prompt is too long`, `context limit reached`, etc.), with immediate abort on non-zero exit

### code-review v1.3.0

#### Added
- PR auto-detection in local mode: when the current branch has an open PR, `resolve-scope` now auto-detects it via `gh pr view` and scopes the review to the PR diff instead of `main...HEAD`
- Small-diff fast path: diffs with <=150 LOC and <=5 files now route to a single fast-path reviewer agent instead of spawning the full 5-agent fleet, reducing review time and token usage
- Fast-path reviewer performs three scoped passes (Bug Hunter, Bug Hunter B / Unified Auditor, Premise) in a single agent run
- Partition cap enforcement with unconditional force-merge fallback when budget-respecting merges cannot reduce partition count below the cap

#### Changed
- Deferred cache-status printing from Task 6 to Task 8 (standard flow) or Task 7 (hygiene-only exit) to allow fast-path routing to suppress cache output
- `extract-patches` `--partitions-file` is now optional; omitting it produces only `patches_all.txt`
- Reviewer/model routing lines in local output and GitHub summary are now conditional on `fast_path`
- Footer omits `--cache-result` on fast-path runs (cache intentionally bypassed)
- Renamed Step 4 to Step 4A (standard flow) and added Step 4B (fast-path flow); Step 5.5 now gated on `fast_path == false`

### code v1.5.6

#### Added
- Severity gate for Codex debate rounds 5+ in `run_codex_review.sh` -- only flags findings that would cause functionally wrong behavior (incorrect output, data loss, crashes, security holes); suppresses wording ambiguities, hypothetical misimplementations, and style suggestions

#### Changed
- Split Codex debate round handling into three tiers: round 1 (initial review), rounds 2-4 (standard re-review), rounds 5+ (severity-gated re-review with elevated approval bar)
- Codex responses with no verdict AND no findings now emit `CODEX_EMPTY` instead of defaulting to `NEEDS_CHANGES`, distinguishing truncated/empty responses from genuine review feedback

### code v1.5.5

#### Changed
- Updated default Codex model from `gpt-5.4` to `gpt-5.3-codex` in `codex-review` skill parameter docs and `run_codex_review.sh` default
- Migrated remaining `.claude/work` path references to `.closedloop-ai/work` in orchestrator prompt example and `extract-plan-md` skill usage examples

### code v1.5.4

#### Removed
- Removed self-learning write references from agent prompts: `implementation-subagent`, `plan-importer`, `plan-writer`, `plan-draft-writer`, `generic-discovery`, `cross-repo-coordinator`, `build-validator`, `verification-subagent`, `plan-validator`, `code-reviewer` -- learning capture sections, Organization Learnings sections, and `self-learning:learning-quality` skill references
- Deleted learning prompt files: `plan-writer-learning.md`, `implementation-learning.md`, `discovery-learning.md`

### code v1.5.3

#### Changed
- Migrated work directory paths from `.claude/` to `.closedloop-ai/` across `run-loop.sh` (state file, progress log, directory creation), `amend-plan` command (default workdir), and `cancel-code` command (loop state file path)
- Enhanced `codex-review` prompt with 6 new analysis criteria: canonical state preservation, task specificity, behavioral precision, order-of-operations, lifecycle symmetry, and test fidelity -- plus implementability-focused preamble instructions

### code v1.5.2

#### Added
- Rule 8 in `build-validator` agent: never use `pkill`, `killall`, or broad kill patterns — use `timeout` to bound hung commands and report stuck processes as failures instead of killing them

#### Security
- Added `pkill` and `killall` to credential-theft blocklist in `pretooluse-hook.sh` — broad process killing is now globally denied to prevent worktree agents from killing processes outside their context

### self-learning v1.0.4

#### Changed
- Migrated `.claude/work` path reference to `.closedloop-ai/work` in `process-chat-learnings.sh` usage documentation

### code v1.5.1

#### Removed
- Removed judge integration from `run-loop.sh` — `run_judges_if_needed`, `has_code_changes`, `resolve_judges_agents_dir`, `ensure_agents_snapshot`, `store_agents_snapshot`, and `check_completion` functions removed along with Step 11 judge invocation in `post_iteration_processing`
- Deleted `run_judges_test_helper.sh` and `test_run_loop_imported_plan.py` (tests for removed judge functions)

#### Changed
- Refactored `run-loop.sh` workdir references to use a single `effective_workdir` local variable instead of repeated `${workdir:-$WORKDIR}` expansions

### judges v1.4.0

#### Added
- Agents snapshot pre-step in `run-judges` skill — creates `$CLOSEDLOOP_WORKDIR/agents-snapshot/` with all judge agent `.md` files and a `manifest.json` before judge execution begins (skipped if snapshot already exists)
- New `ensure_agents_snapshot.sh` script in `run-judges` skill scripts

#### Changed
- Renamed plan evaluation output from `judges.json` to `plan-judges.json` for consistency with `code-judges.json` and `prd-judges.json`
- Updated `validate_judge_report.py` default filename for plan category to `plan-judges.json`

### code v1.5.0

#### Added
- `--self-learning` opt-in flag for `run-loop.sh` -- self-learning is now disabled by default
- `CLOSEDLOOP_SELF_LEARNING` config propagation via `config.env` and state frontmatter
- Self-learning guard in `subagent-start-hook.sh` to skip learning injection when disabled
- Self-learning guard in `subagent-stop-hook.sh` to skip entire learning region when disabled
- Self-learning guard in `pretooluse-hook.sh` to skip tool-specific pattern injection when disabled

#### Changed
- `post_iteration_processing()` skips steps 2-10 when self-learning is off; step 1 (changed-files.json) and step 11 (judges) always run
- `bootstrap_learnings()` skips `.learnings/` directory creation when self-learning is off
- `run_background_pruning()` skips pruning when self-learning is off
- Resume restores `SELF_LEARNING` from state frontmatter and re-exports to hooks

### code v1.4.1

#### Added
- New `feedback-explorer` agent (haiku) for pre-fetching codebase context referenced in reviewer feedback, reducing redundant exploration during plan revisions with delta caching across debate rounds
- Deferral detection in `plan-with-codex` -- scans plans for "Deferred", "Out of Scope", "Future Work" items and requires explicit user approval before excluding work from scope
- Exclusions sidecar file (`{stem}.exclusions`) in `plan-with-codex` to persist user-confirmed deferral decisions across debate rounds

#### Changed
- `plan-with-codex` argument-hint updated to positional syntax instead of optional bracket notation
- `plan-with-codex` uses Write tool for state persistence instead of Bash printf
- `plan-with-codex` launches `feedback-explorer` before `plan-agent` revision rounds to pre-fetch context
- `plan-agent` enforces "no silent deferrals" rule -- must not create deferred/out-of-scope sections without explicit user approval
- `plan-agent` supports pre-fetched context briefs from `feedback-explorer`, reads brief before revision to skip redundant exploration
- Added `Write` tool to `plan-agent` tools list

#### Fixed
- Fixed `plan-with-codex` to use fully qualified agent name `code:feedback-explorer`

### platform v1.0.2

#### Added
- New "Refactoring Existing Prompts" section in `context-engineering` skill covering pitfalls for stale cross-references, over-abstraction, lost preconditions, and silent behavior changes

### code v1.2.1

#### Changed
- `plan-agent` now verifies Codex findings against the codebase before acting -- rejects findings that don't hold up with evidence, writes a revision summary for cross-round context
- `codex-review` skill accepts `--revisions-file` parameter, injecting Claude's revision summary into Codex's prompt on rounds > 1 so rejected findings are not re-raised

#### Fixed
- Fixed `plan-with-codex` resume path triggering a redundant user review checkpoint when the user had already confirmed by choosing "resume with existing plan"

### code v1.2.0

#### Added
- New `plan-agent` agent for creating and revising implementation plans via codebase exploration
- New `plan-with-codex` command for iterative plan refinement through Claude + Codex debate loops
- New `codex-review` skill to run Codex plan reviews and return structured verdict feedback
- New `debate-loop.sh` script providing standalone CLI for Claude + Codex debate orchestration
- New `plan-review.sh` hook that triggers Codex review when Claude exits plan mode

### code-review v1.2.0

#### Added
- New `resolve-scope` subcommand in `code_review_helpers.py` -- deterministic scope resolution replacing inline shell logic for PR branch lookup, git fetch, base-ref overrides, and path filter preservation
- New `fetch-intent` subcommand -- fetches PR description or commit messages as intent context for the Premise Reviewer
- New `classify-intent` subcommand -- classifies diff intent (`feature`, `fix`, `refactor`, `mixed`) from PR metadata and file statuses for model routing
- New `collect-findings` subcommand -- merges `agent_*.json` files and hygiene findings into a single `findings.json`, replacing inline Python-in-Bash merge logic
- New `verdict` subcommand -- computes deterministic PR verdict (`approve`, `needs_attention`, `decline`) from validated findings, replacing inline orchestrator logic
- New `prep-assets` subcommand -- copies `shared_prompt.txt` and `bha_suffix.txt` from plugin to CR_DIR in a single step, consolidating scattered `cp` commands
- New `extract-patches` subcommand -- extracts per-partition and full-diff patches to disk with batched extraction for large diffs (>200 files)
- New `bha_suffix.txt` prompt file -- Bug Hunter A persona and focus areas extracted from inline heredoc in `start.md`
- Intent-aware model routing: Premise Reviewer uses Opus for fix/refactor/mixed intents, Sonnet for feature intents; BHA uses Opus for implementation partitions, Sonnet for test-only partitions
- Mixed-partition splitting in `partition` subcommand -- separates test files from implementation files when impl LOC exceeds threshold
- Agent cap enforcement via `--max-bha-agents` parameter in `partition`, computed from `route` output
- Trivial partition merging -- partitions below 20 LOC are absorbed into same-type normal partitions
- Cache status message (`status_kind`, `status_message`) appended to `cache_result.json` by `cache-check`, replacing orchestrator-side message formatting
- `--exclude-test-partitions` flag on `cache-update` to skip caching files from Sonnet-reviewed test-only partitions
- Self-discard validation rule (check 7) in `shared_prompt.txt` -- agents must discard findings they conclude are not actually problems

#### Changed
- Refactored `start.md` orchestrator to delegate workflow steps to Python subcommands instead of inline shell logic
- `setup` subcommand now accepts `--cr-dir-prefix` and creates CR_DIR with random suffix, removing the need for the orchestrator to generate random directory names
- `route` subcommand now accepts `--intent` parameter and outputs `max_bha_agents` for downstream partition cap enforcement
- Reduced default partition LOC budget from 800 to 500

### judges v1.3.1

#### Changed
- `run-judges` skill now accepts a `--workdir <path>` parameter for standalone use outside `run-loop.sh`; resolved in order: `--workdir` arg → `$CLOSEDLOOP_WORKDIR` env var → `.closedloop-ai/judges` default (directory created automatically if absent)

### code v1.1.4

#### Changed
- `run-loop.sh` judge invocations (`plan_judges`, `code_judges`) now pass `--workdir $workdir` explicitly in the `claude -p` prompt, aligning with the updated `run-judges` skill parameter contract

### judges v1.3.0

#### Added
- New `prd` artifact type support in `run-judges` skill — 4 dedicated PRD judges executed in 2-phase execution, output to `prd-judges.json`, validated with `--category prd`
- New `prd-auditor` agent — structural completeness auditor for draft PRDs; checks US/AC coverage, success metrics table completeness, critical open questions, scope section structure, kill criteria presence, and template section inventory
- New `prd-dependency-judge` agent — evaluates PRD dependency completeness and risk assessment; flags missing dependencies, underdefined integration points, and unacknowledged cross-team risks
- New `prd-testability-judge` agent — evaluates whether PRD acceptance criteria are testable and measurable; flags vague or unverifiable criteria and missing success metrics
- New `prd-scope-judge` agent — evaluates PRD scope discipline and hypothesis traceability; flags stories with no traceable origin, out-of-scope overlaps, story count exceeding 8, and unacknowledged dependencies; emits review-delta JSON
- New `prd_preamble.md` in `skills/artifact-type-tailored-context/preambles/` — artifact-type-tailored context preamble injected before PRD judge prompts
- `validate_judge_report.py`: Added `prd` category to `JUDGE_REGISTRY` with 4 expected judges (`prd-auditor`, `prd-dependency-judge`, `prd-testability-judge`, `prd-scope-judge`)
- `validate_judge_report.py`: Replaced `valid_suffixes` list with `VALID_SUFFIXES` dict mapping each category to its accepted `report_id` suffixes (`prd` maps to `["-prd-judges"]`)
- `validate_judge_report.py`: Reconciled `JUDGE_REGISTRY` plan set — removed phantom entries `efficiency-judge` and `informativeness-relevance-judge`; added `brownfield-accuracy-judge`, `codebase-grounding-judge`, and `convention-adherence-judge`
- `judge-input.schema.json`: Added `"prd"` to the `evaluation_type` enum

### code v1.1.3

#### Added
- `stream_formatter.py` now accumulates per-model token usage from assistant events and prints a summary in the format the harness expects, fixing zero token counts for PLAN/EXECUTE loops

#### Fixed
- `stream_formatter.py` returns early on `BrokenPipeError` before printing usage summary, preventing tracebacks when used in pipelines with early-exit consumers

### judges v1.2.0

#### Added
- New `brownfield-accuracy-judge` agent — evaluates how accurately a plan accounts for existing code (reuse vs reimplementation, integration-point accuracy, scope accuracy against investigation findings)
- New `codebase-grounding-judge` agent — detects hallucinated file paths, nonexistent modules, and fabricated APIs by comparing plan claims against the investigation log
- New `convention-adherence-judge` agent — evaluates whether a plan follows the conventions, patterns, and style found in the actual codebase as documented in the investigation log

#### Changed
- Updated `run-judges` skill to support 16 plan judges (up from 13), adding the three new grounding/brownfield/convention judges in Batch 4
- `brownfield-accuracy-judge` and `convention-adherence-judge` now invoke `@code:pre-explorer` to generate `investigation-log.md` when absent, instead of immediately scoring 0.5; fall back to 0.5 only if pre-explorer fails or the file remains absent
- `codebase-grounding-judge`: add validation step to ensure net-new code does not duplicate existing functionality (e.g., utilities/helpers already in codebase)

### code v1.1.2

#### Fixed
- Restored boolean semantics for `has_code_changes` in `run-loop.sh` and updated judge gating to skip code judges when no implementation changes are detected, without relying on numeric stdout parsing

### judges v1.1.0

#### Added
- New `context-manager-for-judges` agent (moved from `code` plugin) to orchestrate context compression for judge evaluation
- New `judge-input.schema.json` — formal JSON schema defining the standard judge input contract with `source_of_truth` field
- Investigation log (`investigation-log.md`) reuse in plan judge context with pre-explorer fallback when no `CLOSEDLOOP_WORKDIR` is set

#### Changed
- Generalized judge input contract to use orchestrator-provided `judge-input.json` (task + context envelope) instead of hardcoded artifact assumptions
- Standardized all judge agents to read `judge-input.json` from `$CLOSEDLOOP_WORKDIR` and load mapped artifacts via source-of-truth ordering
- Centralized judge input-read requirements into shared preamble `common_input_preamble.md`; judge-specific files no longer duplicate input-contract boilerplate
- Enforced strict SSOT by removing residual per-agent `Input Contract` stubs; `common_input_preamble.md` is now the single runtime source for input-loading guidance

#### Fixed
- Added `source_of_truth` to required array in `judge-input.schema.json` — schema now matches SKILL.md and judge agent expectations for evidence prioritization

### code v1.1.0

#### Changed
- Migrated session/hook data directory from `.claude/.closedloop/` to `.closedloop-ai/` across all hooks (`session-start`, `session-end`, `subagent-start`, `subagent-stop`, `pretooluse`, `loop-stop`) and `setup-closedloop.sh`, with legacy fallback for mid-upgrade sessions
- Added legacy directory cleanup in `session-end-hook.sh` — removes stale PID mappings, expired session files, and deletes empty legacy directory on session end

### self-learning v1.0.3

#### Fixed
- Fixed pattern cap trimming to sort by staleness flags only instead of confidence — low-confidence patterns were always dropped before being observed, preventing them from ever earning higher confidence
- Fixed extraneous f-string prefix lint warning in `write_merged_patterns.py` default header

#### Changed
- Updated `process-learnings` cap strategy to trim `[PRUNE]` then `[STALE]` then `[REVIEW]`, with `seen_count` as tiebreaker

### code v1.1.1

#### Added
- Integrated `investigation-log.md` into judge context assembly, sourced from `$CLOSEDLOOP_WORKDIR`

#### Fixed
- Fixed judges agents path resolution in `run-loop.sh` to support monorepo, cache, and marketplace installation layouts via a four-level fallback strategy (`CLOSEDLOOP_JUDGES_AGENTS_DIR` env override → repo-relative path → non-versioned sibling → latest semver-versioned sibling)
- Fixed agent snapshot to read judge agents from the judges plugin rather than the code plugin, and corrected `plugin` field in manifest to `"judges"`

### code-review v1.1.0

#### Breaking
- Removed `github-review` slash command — `/code-review:github-review` is no longer a valid entry point. Use `/code-review:start --github` instead.
- Renamed `review.md` → `start.md` — slash command is now `/code-review:start`
- Moved `github-review.md` from `commands/` to `prompts/` — callers using `${CLAUDE_PLUGIN_ROOT}/commands/github-review.md` must update to `${CLAUDE_PLUGIN_ROOT}/prompts/github-review.md`

#### Changed
- Unified session directory path for all modes — removed `$RUNNER_TEMP` override in GitHub CI, now uses `.closedloop-ai/code-review/cr-<RANDOM>` everywhere
- Replaced Bash heredoc/cat usage with Write and Read tools for PR metadata file operations in `github-review.md`
- Updated temp file path references from `$RUNNER_TEMP/cr-review/` to `<CR_DIR>/*` in GitHub mode constraints
- Fixed usage examples to use `/start` to match the command filename
- Fixed internal references from `code-review-github.md` to `github-review.md`

#### Added
- Compound Bash command prohibition in GitHub mode — no `&&`, `||`, `;`, or `|` pipes allowed

### code v1.0.5

#### Changed
- Updated `review-delta.schema.json` description to reference "code hybrid workflow" instead of "impl-plan hybrid workflow"
- Updated `compliance-checkpoint.md` to reference `/code` instead of `/impl-plan`
- Removed `Bash` from `visual-qa-subagent` tool list to prevent shell access during visual QA

#### Security
- Added credential theft blocklist to `pretooluse-hook.sh`: denies Bash commands and file access targeting macOS Keychain, browser cookie databases, SSH private keys, and cloud credentials
- Blocklist applies to all Claude sessions, not just ClosedLoop-managed sessions

### bootstrap v1.1.0

#### Added
- Schema-aligned constraints in AGENT_FORMAT.md: `tools`, `skills`, `permissionMode` fields, `name` kebab-case/64-char limit, `description` 1024-char limit, expanded 8-color enum with `cyan`/`pink`
- Context-engineering activation in agent-prompt-generator via `platform:context-engineering` skill
- Tools/skills inline format validation in agent-prompt-validator (BLOCKING on block array syntax)
- `additionalProperties` violation detection and `skills`→`Skill` tool cross-check
- Critic Review Schema Alignment (Check 8) and critic-gates.json Structure Validation (Check 9) in generation-validator
- critic-gates.json schema validation in bootstrap-validator
- Context-engineering compliance warnings in anti-pattern detection

#### Changed
- `description` max raised from 120 → 1024 chars (warn >200)
- `model` enum now accepts `inherit`
- `color` field changed from required to optional; enum expanded to 8 values
- Removed legacy `prd2plan/` directory namespace — agent output now writes to `.claude/agents/` (flat)
- Moved `.bootstrap-metadata.json` from `.claude/agents/prd2plan/` to `.closedloop-ai/bootstrap-metadata.json`
- Replaced all `/impl-plan` command references with `/code`
- Removed DAG validation infrastructure (deleted `impl-plan-dag.schema.json`, removed Check 2 from bootstrap-validator)
- Updated default `--target-command` from `impl-plan` to `code`
- Updated default `--output-dir` from `.claude/agents/prd2plan/` to `.claude/agents/`

### code v1.0.4

#### Changed
- Generalized `prd-creator` skill description and replaced analytics discovery step with risks assessment
- Updated PRD template to add compliance checkpoint and remove event instrumentation section
- Revised story patterns and examples references to align with compliance-focused workflow

#### Removed
- Deleted `event-instrumentation.md` reference

### code v1.0.3

#### Changed
- Migrated learnings path from `~/.claude/.learnings/` to `~/.closedloop-ai/learnings/` in `pretooluse-hook.sh` and `subagent-start-hook.sh` with legacy fallback

### self-learning v1.0.2

#### Changed
- Migrated learnings path from `~/.claude/.learnings/` to `~/.closedloop-ai/learnings/` across commands, tools, and skills with legacy fallback

### bootstrap v1.0.0

#### Added
- Initial release
- Bootstrap plugin for ClosedLoop agent creation and validation

### code v1.0.2

#### Added
- Step 8.5 in `run-loop.sh` for deterministic TOON writing via `write_merged_patterns.py`

### code v1.0.1

#### Added
- New `prd-creator` skill for drafting lightweight PRDs through conversational workflow

### code v1.0.0

#### Added
- Initial release

### code-review v1.0.0

#### Added
- Initial release

### judges v1.0.0

#### Added
- Initial release

### platform v1.0.1

#### Added
- New `claude-creator` skill for scaffolding and creating new skills from scratch

### platform v1.0.0

#### Added
- Initial release

### self-learning v1.0.1

#### Added
- New `write_merged_patterns.py` tool for deterministic JSON-to-TOON conversion

#### Changed
- Refactored `process-learnings` command to output `merge-result.json` instead of writing TOON directly
- Updated `process-chat-learnings.sh` to run deterministic TOON write step after classification

### self-learning v1.0.0

#### Added
- Initial release
