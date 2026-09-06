# Code-Review Canonical Schema

**Schema version:** 1 · **Plugin version:** 2.0.0 · **Source of truth:** `tools/python/code_review_schema.py`

This document is the canonical reference for the wire format emitted by the
`code-review` plugin. Every reviewer, helper, and consumer must conform to it.

The schema is owned by PLN-719 (Foundation). Plans 01-07 add categories,
reviewer triggers, and verifier state — they do not change the envelope.

---

## 1. Finding object

Every finding emitted by any reviewer or deterministic helper conforms to this
shape. Producers may emit dicts directly; the Python convenience type lives in
[code_review_schema.py](tools/python/code_review_schema.py).

```jsonc
{
  "schema_version": 1,
  "id": "<reviewer_id>_f<index>",

  // ── Provenance ────────────────────────────────────────────
  "reviewer": "bug_hunter_a | bug_hunter_b | unified_auditor | test_quality | impact | coverage-verifier | injection-detector | companion-validator | hygiene | <named-critic-id>",
  "reviewer_trigger": {
    "type": "core | always | extension | path_pattern | content_signal | change_class | signal | partition",
    "evidence": "<trigger-specific evidence; required for non-core triggers>"
  },
  "source": "agent | hygiene | injection-detector | companion-validator | coverage-verifier",
  "emitted_at": "<ISO-8601 timestamp>",

  // ── Anchor (depends on finding_scope) ─────────────────────
  "finding_scope": "diff | system | pr_metadata",
  "file": "<repo-relative path; null when finding_scope != 'diff'>",
  "line": <int|null>,
  "system_marker": "<from the canonical enum (Section 3); null when finding_scope == 'diff'>",

  // ── Classification ────────────────────────────────────────
  "category": "Correctness | Code Quality | Documentation | Hygiene | Repo Hygiene | ImpactAnalysis | TestQuality | Coverage | InjectionAttempt | CompanionChange | Security",
  "subcategory": "<category-specific; nullable>",

  // ── Severity ──────────────────────────────────────────────
  "severity": "BLOCKING | HIGH | MEDIUM",
  "priority": 0 | 1 | 2 | 3,
  "confidence": 0.0..1.0,

  // ── Content ───────────────────────────────────────────────
  "issue": "<short imperative title, <=80 chars>",
  "explanation": "<paragraph; cite evidence>",
  "recommendation": "<actionable; specific>",
  "code_snippet": "<verbatim from file at file:line, or '' for system-scoped>",

  // ── Structured evidence (verifier, plan 03, consumes) ─────
  "evidence": [
    {
      "file": "<path>",
      "line": <int>,
      "claim": "<what is cited>",
      "snippet_hash": "<sha256 of cited snippet at emission time>"
    }
  ],

  // ── Reasoning certificate (plans 02, 03, 04, 06 emit) ─────
  "reasoning_certificate": {
    "kind": "necessity | cohesion | workaround | complexity | impact | test_quality | sibling_pattern | bha | bhb | auditor",
    "fields": { /* kind-specific shape */ }
  },

  // ── Justification (plan 02) ───────────────────────────────
  "justified": <bool>,
  "justification": null | {
    "text": "<verbatim author text>",
    "source": "code_comment:<file>:<line> | pr_description | commit_message:<sha>",
    "addresses_specific_concern": <bool>,
    "claimed_by_reviewer": "<reviewer's one-sentence rationale>"
  },

  // ── External impact (plan 06) ─────────────────────────────
  "external_impact": [
    {
      "file": "<path>",
      "line": <int>,
      "impact_type": "signature_mismatch | type_incompatibility | semantic_drift | deleted_reference | stale_string_reference | behavioral_change | guard_needed",
      "description": "<one sentence>",
      "callsite_snippet": "<verbatim source line at file:line>",
      "discovery": "grep | graph",
      "confidence": 0.0..1.0
    }
  ],
  "grep_query_used": "<string|null>",

  // ── Verifier state (plan 03 populates) ────────────────────
  "verifier_verdict": "CONFIRMED | DOWNGRADE | TENTATIVE | REJECTED | JUSTIFIED-VALID | JUSTIFIED-INVALID | null",
  "verifier_severity": "<corrected severity for DOWNGRADE; null otherwise>",
  "verifier_confidence": <float|null>,
  "verifier_reasoning": "<string|null>",
  "verifier_model": "<model id|null>",
  "verification_duration_ms": <int|null>,
  "evidence_checks": [
    {
      "claim": "<verbatim from finding.evidence[]>",
      "verified": <bool>,
      "actual_read": "<what verifier read at the cited location>"
    }
  ],
  "rejection_class": "evidence_not_found | guard_exists | unreachable | out_of_scope | severity_overstated | null",
  "human_review_recommended": <bool>,

  // ── Cross-file grouping ───────────────────────────────────
  "other_locations": [
    {"file": "<path>", "line": <int>, "issue": "<short>"}
  ]
}
```

### Required vs optional fields by source

| Source              | Required                                                                                                                                                                                | Notes                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Reviewer agent      | id, reviewer, reviewer_trigger, source=agent, finding_scope=diff, file, line, category, severity, priority, confidence, issue, explanation, recommendation, code_snippet, evidence      | system_marker=null                                 |
| Hygiene helper      | id, reviewer=hygiene, source=hygiene, finding_scope=diff, file, line, category=Hygiene (or "Repo Hygiene"), severity, priority, confidence=1.0, issue, explanation, recommendation      | system_marker=null                                 |
| Injection detector  | id, reviewer=injection-detector, source=injection-detector, finding_scope=pr_metadata, file=null, system_marker=pr_description or commit:{sha}, category=Security or InjectionAttempt   | code_snippet redacted                              |
| Companion validator | id, reviewer=companion-validator, source=companion-validator, finding_scope=diff (trigger file), file, line, category=CompanionChange, severity, priority, confidence=1.0               | —                                                  |
| Coverage verifier   | id, reviewer=coverage-verifier, source=coverage-verifier, finding_scope=system, file=null, system_marker=coverage:{reviewer-name} or budget-exceeded, category=Coverage                 | —                                                  |

Verifier-populated fields (`verifier_verdict`, `evidence_checks`, etc.) are
null on initial emission; populated by the `verify-findings` subcommand
(plan 03).

---

## 2. Result envelope (`review_result.json`)

The terminal artifact of every review run.

```jsonc
{
  "schema_version": 1,
  "review_id": "<uuid v4>",

  // ── Run context ───────────────────────────────────────────
  "pr_number": <int|null>,
  "head_sha": "<sha|null>",
  "diff_tip": "<sha>",
  "review_branch": "<branch>",
  "base_ref": "<ref>",
  "diff_scope": "<as resolved by resolve-scope>",
  "mode": "local | github",
  "intent": "feature | fix | refactor | mixed",

  // ── Findings bucketed by verifier verdict ─────────────────
  // After verification, every finding is in exactly one bucket.
  // Before verification, all findings are in pending_verification[].
  "verified": [<finding>, ...],               // CONFIRMED + DOWNGRADE + TENTATIVE
  "justified": [<finding>, ...],              // JUSTIFIED-VALID
  "rejected": [<finding>, ...],               // REJECTED + JUSTIFIED-INVALID-promoted
  "pending_verification": [<finding>, ...],   // present only before verification

  // ── Coverage state ────────────────────────────────────────
  "coverage_plan": {
    "required": [<reviewer entry>, ...],
    "best_effort": [<reviewer entry>, ...],
    "deferred_for_budget": [<reviewer entry>, ...],
    "deprecation_warnings": [<string>, ...],
    "budget": {
      "total_cap": <int>,
      "required_count": <int>,
      "best_effort_count": <int>,
      "bha_partitions": <int>
    }
  },
  "coverage_gaps": [<finding with category=Coverage and finding_scope=system>, ...],

  // ── Verdict ───────────────────────────────────────────────
  "verdict": "APPROVED | NEEDS_ATTENTION | CHANGES_REQUESTED",
  "verdict_reason": "<one of the verdict precedence rules; cites the gating finding(s)>",

  // ── Stats ─────────────────────────────────────────────────
  "stats": {
    "by_severity": {"BLOCKING": <int>, "HIGH": <int>, "MEDIUM": <int>},
    "by_category": {"Correctness": <int>, ...},
    "by_reviewer": {"<reviewer>": {"verified": <int>, "rejected": <int>, "tentative": <int>, "justified": <int>}},
    "by_finding_scope": {"diff": <int>, "system": <int>, "pr_metadata": <int>},
    "verification": {
      "verified_count": <int>,
      "rejected_count": <int>,
      "tentative_count": <int>,
      "downgrade_count": <int>,
      "justified_valid_count": <int>,
      "justified_invalid_count": <int>,
      "skipped_count": <int>,
      "false_positive_rate": <float>
    },
    "impact_cumulative_count": <int>,
    "agent_failures": [{"agent_id": "<id>", "reason": "<string>"}]
  },

  // ── Telemetry ─────────────────────────────────────────────
  "telemetry": {
    "duration_ms": <int>,
    "duration_by_stage_ms": {"<stage_id>": <int>},
    "estimated_cost_usd": <float>,
    "tokens": {
      "input_uncached": <int>,
      "input_cached": <int>,
      "output": <int>,
      "by_model": {"<model>": {"in": <int>, "cached_in": <int>, "out": <int>}}
    },
    "schema_versions_seen": {"finding": <int>, "result": <int>}
  }
}
```

---

## 3. Finding scopes and the `system_marker` enum

### Scopes

| Scope         | `file` field                                                | `system_marker` field                          | Line-in-diff check? |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------- | ------------------- |
| `diff`        | Real repo-relative path; must be in `diff_data.files_to_review` | null                                       | Yes — ±3 line tolerance |
| `system`      | null                                                        | From the `system` category below              | No                  |
| `pr_metadata` | null                                                        | From the `pr_metadata` category below         | No                  |

### Canonical `system_marker` enum

**System category** (`finding_scope: "system"`):

| Marker                       | Used by             | Meaning                                                                     |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `budget-exceeded`            | foundation          | Required reviewer count exceeds budget cap                                  |
| `agent-failure`              | foundation          | An agent crashed during execution                                           |
| `signal-extraction-failed`   | foundation, plan 05 | extract-signals failed; fail-closed over-trigger active                     |
| `schema-version`             | foundation          | Result schema-version mismatch warning                                      |
| `coverage:{reviewer-name}`   | plan 05             | Required reviewer failed to run; suffix templated per reviewer              |

**PR-metadata category** (`finding_scope: "pr_metadata"`):

| Marker            | Used by  | Meaning                                                           |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `pr_description`  | plan 01  | Injection-detector finding on PR body                             |
| `commit:{sha}`    | plan 01  | Injection-detector finding on a commit message; suffix = SHA      |

Adding a new value requires updating this enum and bumping `schema_version`.
The validator rejects unknown values.

---

## 4. Finding IDs

Format: `<reviewer_id>_f<index>` where `reviewer_id` matches `^[a-z][a-z0-9_-]*$`
and `index` is the zero-based emission order within that reviewer's output.

Examples: `bha_p2_f3`, `bhb_f0`, `impact_f7`, `coverage-verifier_f1`,
`injection-detector_f0`.

Stability: deterministic across re-runs of the same reviewer on the same input.
NOT stable across different reviewers, BHA partition changes, or schema versions.

---

## 5. Verdict precedence (canonical)

The `verdict` subcommand applies these rules in order; the first match wins.

1. Any coverage gap with `required: true` (foundation) → **CHANGES_REQUESTED**
2. Any BLOCKING finding (verified or system-scoped) → **CHANGES_REQUESTED**
3. Any HIGH finding (verified or system-scoped) → **NEEDS_ATTENTION**
4. ≥ M BLOCKING/HIGH Impact Analysis findings (plan 06; default M=2) → **NEEDS_ATTENTION**
5. Any TENTATIVE finding (plan 03) → **NEEDS_ATTENTION**
6. Otherwise → **APPROVED**

`verdict_reason` cites the specific finding(s) that produced the verdict.

**Numbering note.** This list is a clean sequential summary. The implementation (`_compute_canonical_verdict`) carries plan-derived rule labels — including the `2.5` (mandatory-human-review short-circuit) and `3.5` (TENTATIVE fall-through) sub-rules, and the cumulative Impact gate labeled **Rule 6** (PLN-726 OQ#6) — so the code's labels do not map 1:1 to the numbers above (e.g. the Impact gate is item 4 here but "Rule 6" in code).

The verdict subcommand writes `<CR_DIR>/verdict.json` with both the canonical verdict and a `verdict` string compatible with `run-loop.sh` (which keys on the legacy form):
- APPROVED → approve
- NEEDS_ATTENTION → needs_attention
- CHANGES_REQUESTED → decline

---

## 6. Budget arbitration

The `arbitrate-budget` subcommand is the single owner of "which reviewers run,
in what order, against what cap." See PLN-719 Section 5.

| Setting                       | Default       | Notes                                          |
| ----------------------------- | ------------- | ---------------------------------------------- |
| `total_cap`                   | 20            | Hard cap on total agent fleet                  |
| `bha_floor`                   | 1             | Waived for docs-only PRs                       |
| `required_overflow_policy`    | `fail_closed` | Drop excess required, emit coverage gap        |
| `best_effort_pruning`         | by priority↑  | Lowest-priority best-effort dropped first      |

---

## 6b. Reviewer spawn spec (`spawn.json.spec`)

Produced by `stage_19b_derive_spawn_spec` (PLN-725 Phase 8; consolidated
into `spawn.json` under the `spec` section in v2.26.0) from the
post-arbitrate `coverage.json.final` + `partitions.json` + `spawn.json.route`;
consumed by the `stage_20_spawn_reviewers` orchestrator. Closes the
deterministic-coverage loop — before Phase 8 the coverage plan was
ignored at spawn time.

```jsonc
{
  // ── Routing ──────────────────────────────────────────────
  "fast_path": false,                  // mirrors route.fast_path
  "gated_by_verify": false,            // mirrors budget.gated_by_verify
                                       // from arbitrate-budget (Phase 7)
  "arbitrate_status": "ok",            // closed vocab: see below
  "fallback_reason": "<string>",       // only present when arbitrate_status="fallback"
  "cr_dir": "<absolute path>",
  "generated_at": "<ISO-8601 timestamp>",

  // ── Agents to spawn ──────────────────────────────────────
  "agents": [
    {
      "agent_id": "bha_p0 | bhb | auditor | domain_<N> | fast",
      "reviewer": "bug_hunter_a | bug_hunter_b | unified_auditor | <critic-name> | fast_path_reviewer",
      "model": "<model id>",
      "partitioned": true,             // only BHA partitions
      "partition_id": 0,               // only when partitioned
      "is_test_only": false,           // only when partitioned (drives BHA model slot)
      "patches_file": "patches_p<N>.txt | patches_all.txt",
      "source": "core | rule | critic | fast_path",
      "bucket": "required | best_effort | fast_path",
      "priority": 2                    // only on critics
    }
  ],

  // ── Reviewers deliberately not spawned ───────────────────
  "skipped": [
    {
      "reviewer": "<name>",
      "bucket": "required | best_effort",
      "reason": "deferred_pln723 | no_partitions | unknown_reviewer | missing_reviewer_name | duplicate_agent_id | budget_capped | gated_by_verify",
      "agent_id": "<id>",              // only on duplicate_agent_id
      "partition_id": 0,               // only on budget_capped (BHA)
      "budget_cap": 0,                 // only on budget_capped
      "partition_count": 0,            // only on budget_capped
      "source": "rule | critic"        // only on gated_by_verify (preserved for presenters)
    }
  ],

  // ── Telemetry ────────────────────────────────────────────
  "stats": {
    "agent_count": 5,
    "bha_count": 1,
    "domain_critic_count": 0,
    "from_required": 4,
    "from_best_effort": 0,
    "required_coverage_gaps": 0       // count of coverage_gaps.json findings emitted
  }
}
```

**Closed-vocabulary fields** (validated at production time; codified as
constants in `code_review_schema.py`):

| Field | Values | Notes |
| --- | --- | --- |
| `arbitrate_status` | `ok`, `blocked_by_verify`, `fallback`, `static` | `ok` = normal arbitration ran; `blocked_by_verify` = Phase 7 BLOCKING gate fired upstream and the plan passed through unchanged; `fallback` = derive failed, orchestrator must walk the static reviewer table in the `code-review:spawn-reviewers` skill; `static` (PLN-807) = shallow tier — the spec was emitted by `derive-static-spec` (fixed BHA + BHB + unified_auditor fleet) without consulting a coverage plan, and `stage_20` treats it identically to `fallback` (use the spec verbatim, skip the bucket walk); the distinct status is a telemetry signal that distinguishes user intent (shallow) from upstream derive failure |
| `source` | `core`, `rule`, `critic`, `fast_path` | Selects the prompt-suffix dispatch in the `code-review:spawn-reviewers` skill (`source: "core"` further branches on `reviewer`; `rule` and `critic` both map to the Domain Critic suffix — `rule` for deterministically matched critic-gates rules including migrated `moduleCritics[]`, `critic` for LLM-proposed additions) |
| `bucket` | `required`, `best_effort`, `fast_path` | Mirrors the source bucket in `coverage_plan.json` |
| `skipped[].reason` | `deferred_pln723`, `no_partitions`, `unknown_reviewer`, `missing_reviewer_name`, `duplicate_agent_id`, `budget_capped`, `gated_by_verify` | Reasons surfaced so operators see why a reviewer was omitted |
| `fallback_reason` | `coverage_plan_missing_or_malformed`, `partitions_missing_or_malformed` | Only set when `arbitrate_status == "fallback"`; names the specific upstream-artifact failure |

**Fallback sentinel invariant:** when `arbitrate_status == "fallback"`,
`agents[]` is empty and `fallback_reason` is set. The orchestrator must
treat this as "ignore the spec; walk the static reviewer table in
the `code-review:spawn-reviewers` skill" — a derive failure must never
block review.

**BLOCKING propagation invariant:** when `gated_by_verify == true`,
`agents[]` is populated from a SANITIZED plan — only `source: "core"`
entries survive; every `rule` and `critic` entry from the verifier-
rejected plan is dropped into `skipped[]` with
`reason: "gated_by_verify"` and the entry's original source preserved.
This keeps the canonical static fleet (BHB, Auditor, BHA per
partition) running so review still produces output, while refusing to
action the closed-vocabulary / shape / evidence / cap violations the
verifier flagged. The canonical BLOCKING finding already lives in
`agent_coverage-verify-blocking.json` from `stage_15c`; the spawn-spec
does not duplicate it. Presenters use `gated_by_verify` to surface
"arbitration bypassed" in the run summary.

**BHA budget cap invariant:** the BHA descriptor count is bounded by
`coverage_plan.budget.bha_partitions` (the post-arbitrate cap), not
by the count of partitions in `partitions.json`. When the partitioner
emitted more partitions than the budget reserved, the first `cap`
partitions spawn and the rest land in `skipped[]` with
`reason: "budget_capped"`. A cap of 0 (docs-only post-arbitrate)
suppresses all BHA spawns regardless of partition count.

**Required coverage-gap invariant:** every entry in `skipped[]`
with `bucket == "required"` and a non-benign reason
(everything except `deferred_pln723`, `no_partitions`,
`gated_by_verify`) produces a coverage-gap finding appended to
`coverage_gaps.json`. `cmd_finalize_result` reads that file into the
envelope's coverage-gap bucket where it contributes to the canonical
verdict. The runtime symmetric pair to this derive-time check is
`stage_20b_verify_spawn` (see §6c).

---

## 6c. Spawn verification (`spawn.json.verification`)

Produced by `stage_20b_verify_spawn` (PLN-725 Phase 8 / v2.22.3;
consolidated into `spawn.json` under the `verification` section in
v2.26.0) AFTER
`stage_20_spawn_reviewers` finishes. Closes the runtime side of the
spawn-spec contract: derive-spawn-spec catches required reviewers the
spec couldn't even describe; verify-spawn catches required agents that
crashed at runtime. Both producers write to `coverage_gaps.json` so
`cmd_finalize_result` sees a unified gap list.

```jsonc
{
  "verified": true,
  "present_count": 4,
  "intended_count": 4,
  "present_agents": ["auditor", "bha_p0", "bhb", "domain_0"],
  "missing_agents": [],            // every missing descriptor (required + best_effort)
  "missing_required": [],          // subset of missing_agents with bucket == "required"
  "missing_required_gaps": 0,      // coverage_gaps.json findings appended
  "generated_at": "<ISO-8601>"
}
```

**No-op shape** — emitted when there's nothing to verify against:

```jsonc
{
  "verified": false,
  "reason": "spec_missing | spec_fallback | spec_empty",
  "present_agents": [], "missing_agents": [], "missing_required": [],
  "generated_at": "<ISO-8601>"
}
```

**Runtime gap invariant:** for each entry in `missing_required[]`,
exactly one coverage-gap finding is appended to `coverage_gaps.json`
with `source: "coverage-verifier"` and reason `spawn_missing_required_agent`.
Missing best-effort agents are recorded for telemetry but emit no
finding — best-effort omissions are budget-driven, not coverage gaps.

---

## 7. Pipeline ordering

| #  | Stage                        | Subcommand               | Produces                                                       |
| -- | ---------------------------- | ------------------------ | -------------------------------------------------------------- |
| 1  | setup                        | `setup`                  | `setup.json`, CR_DIR                                          |
| 2  | prep-assets                  | `prep-assets`            | Prompt asset files in CR_DIR                                   |
| 3  | resolve-scope                | `resolve-scope`          | `scope.json`                                                  |
| 4  | finalize-cache               | `finalize-cache`         | `cache_config.json`                                           |
| 5  | parse-diff                   | `parse-diff`             | `diff_data.json`                                              |
| 6  | extract-patches (moved)      | `extract-patches`        | `patches_all.txt`                                              |
| 7  | auto-incremental             | `auto-incremental`       | `auto_incremental.json`                                       |
| 8  | fetch-intent                 | `fetch-intent`           | `intent_context.json`                                         |
| 9  | detect-injection (plan 01)   | `detect-injection`       | `injection_report.json`                                        |
| 10 | classify-intent              | `classify-intent`        | `intent.json`                                                 |
| 11 | extract-signals (plan 05)    | `extract-signals`        | `signals.json`                                                |
| 12 | hygiene                      | `hygiene`                | `hygiene.json`                                                |
| 13 | validate-companions (plan 06)| `validate-companions`    | `companion_findings.json`                                     |
| 14 | resolve-coverage (plan 05)   | `resolve-coverage`       | `coverage.json` (`initial` section)                            |
| 15 | coverage-critic (plan 05)    | `coverage-critic`        | `coverage.json` (`critic` section, `final` on cache_hit/skipped) |
| 15c| verify-coverage (plan 05)    | `verify-coverage`        | `coverage.json` (`verify` section)                             |
| 16 | arbitrate-budget             | `arbitrate-budget`       | `coverage.json` (`final` section, in-place), `coverage_gaps.json` |
| 17 | partition                    | `partition`              | `partitions.json`, `patches_p<N>.txt`                          |
| 18 | compute-hashes               | `compute-hashes`         | `hashes.json`                                                 |
| 19 | cache-check                  | `cache-check`            | `cache_result.json`                                            |
| 19b| derive-spawn-spec (plan 05)  | `derive-spawn-spec`      | `spawn.json` (`spec` section)                                  |
| 20 | spawn-reviewers              | (agent_fleet)            | `agent_<id>.json`                                              |
| 20b| verify-spawn (plan 05)       | `verify-spawn`           | `spawn.json` (`verification` section) + `coverage_gaps.json` append |
| 21 | collect-findings             | `collect-findings`       | `findings.json` (with deterministic IDs)                       |
| 22 | validate                     | `validate`               | `findings_validated.json`                                     |
| 23 | verify-findings (plan 03)    | `verify-findings`        | `findings_verified.json`                                      |
| 25 | finalize-result              | `finalize-result`        | `review_result.json` (canonical envelope)                     |
| 26 | cache-update                 | `cache-update`           | Cache manifest                                                |
| 27 | review-state-write           | `review-state-write`     | Review state                                                  |
| 28 | verdict                      | `verdict`                | `verdict.json`                                                |
| 29 | present                      | (present)                | Local or GitHub output                                        |
| 30 | footer                       | `footer`                 | Footer line                                                   |

Stages from plans 01/03/05/06 are present in `run_plan.json` but marked
`enabled: false` until those plans land.

---

## 7b. `run-prefix` result contract (PLN-1229)

`run-prefix` runs the **entire** deterministic prefix (stages 01 through Gate B
`route` + `partition` + `derive-spawn-spec`) in ONE process instead of one
orchestrator turn per stage. It reads `run_plan.json` + `setup.json` from
`--cr-dir`, walks from `--resume-from` (default: the first plan stage), and stops
at the next genuine decision point — emitting a status JSON (to stdout, or
`--output <path>`) that tells the orchestrator what to do next. The runner is
**resumable**: after handling a pause the orchestrator re-invokes
`run-prefix --resume-from <resume_stage>`. Because each segment is a fresh
process, the `depends_on` `completed` set is reconstructed from artifacts on disk
(a prior stage counts as done iff its literal `expected_outputs` exist).

**Result fields:**

| Field                  | Type            | Meaning                                                                 |
| ---------------------- | --------------- | ----------------------------------------------------------------------- |
| `next_action`          | string (enum)   | The pause reason — authoritative (read this, not the exit code).        |
| `resume_stage`         | string \| null  | The stage id to pass as `--resume-from` on the next invocation.         |
| `singleton`            | string \| null  | `"extract_signals"` \| `"coverage_critic"` when `needs_singleton`.      |
| `failed_stage`         | string \| null  | The aborting stage id when `next_action == "error"`.                    |
| `ran_stages`           | string[]        | Stage ids executed (or `continue`-failed) this segment, in order.       |
| `message`              | string \| null  | Short diagnostic on `error`, else null.                                 |
| `fast_path`            | bool            | Gate B routing decision. Present **only** on `ready_for_reviewers`.      |
| `max_bha_agents`       | int \| null     | Gate B Bug-Hunter-A agent cap. Present **only** on `ready_for_reviewers`.|
| `cache_status_message` | string \| null  | `cache_result.json.status_message` to print. Present on `ready_for_reviewers` and `hygiene_exit`. |

`next_action`, `resume_stage`, `singleton`, `failed_stage`, `ran_stages`, and
`message` are present on every result. The three Gate-B fields above are
**omitted entirely** (not set to null) on the results that don't carry them —
`fast_path` / `max_bha_agents` appear only on `ready_for_reviewers`, and
`cache_status_message` only on `ready_for_reviewers` / `hygiene_exit`. Read them
with `.get()`, not direct indexing.

**`next_action` values:**

| Value                 | Fires at                              | Orchestrator does next                                                        |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `needs_singleton`     | `stage_11` / `stage_15` `needs_agent` | Spawn the `singleton` agent, write its output, re-invoke from `resume_stage`. |
| `hygiene_exit`        | Gate A (`hygiene_only` after hygiene) | Print `cache_status_message`, present hygiene findings, stop (no verdict).    |
| `ready_for_reviewers` | the whole deterministic prefix is done | Print `cache_status_message` + the `fast_path` notice; spawn the reviewer fleet (`stage_20`). |
| `error`               | a stage aborted / a gate failed       | Fall back to the per-stage walk from `failed_stage`; partials are preserved.  |

On `ready_for_reviewers` the runner has already run Gate B `route` (writing
`spawn.json.route`) and — unless `fast_path` — `stage_17_partition` (with the
`--loc-budget 500 --max-files 25 --max-bha-agents <N>` augmentation, and the
`uncached_diff_data.json` swap when a cache dir is active). In `fast_path` mode
partition is skipped (no `partitions.json` / `patches_p<N>.txt`) and any cached
BHA replay artifact is deleted. The `fast_path` / `max_bha_agents` /
`cache_status_message` fields let the orchestrator print the routing + cache
notices without re-reading `spawn.json`.

The exit code is `0` for every well-formed result (including `error`) — the
`next_action` field is the contract. The `on_failure` policy of each stage is
honored exactly as the Walker Contract prescribes: `abort` → `error`; `continue`
→ proceed; `continue_with_coverage_gap` → proceed after writing an
`agent-failure` system finding to `agent_<stage>-failed.json` (collected by
`collect-findings`). A Gate B `route` failure is surfaced as `error` with
`failed_stage: "stage_19_cache_check"` (route is not a plan stage, so the error
anchors on the stage a per-stage fallback resumes from — re-running cache-check
→ route → partition).

---

## 8. Determinism tiers (PLN-719 Section 8)

| Tier                       | Definition                                                              | Required reviewers may depend? |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| **Deterministic**          | Same inputs → same outputs, no model involved                           | Yes                            |
| **Reproducible via cache** | Same inputs → same outputs *if cache hit*; otherwise LLM-driven         | Limited — additive only        |
| **LLM-driven**             | Same inputs may produce different outputs                               | No                             |

Stage → tier mapping lives in `STAGE_DETERMINISM_TIERS` in
[code_review_schema.py](tools/python/code_review_schema.py).

---

## 9. Cache key derivation (PLN-719 Section 9)

Uniform `prompt_hash`:

```python
prompt_hash = sha256(
    b"\0".join(parts) + b"\0" + str(schema_version).encode()
)
```

A MAJOR `schema_version` bump invalidates every cache namespace at once.

| Namespace           | Path                                              | Key inputs                                                    | TTL    |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ------ |
| BHA findings        | `<CACHE_DIR>/bha/<file_hash>.json`                | file_content_hash + prompt_hash + model_id + schema_version   | 30 d   |
| Signal extraction   | `<CACHE_DIR>/signals/<key>.json`                  | diff_tip + input_hash + taxonomy_hash + signal_prompt_hash     | 7 d    |
| Coverage critic     | `<CACHE_DIR>/coverage_critic/<diff_tip>.json`     | coverage_plan_initial_hash + signals_hash + critic_prompt_hash | 7 d   |
| Verification        | `<CACHE_DIR>/verifications/<finding_id>.json`     | finding_id + file_content_hash + verifier_model + verifier_prompt_hash | 30 d |
| Overrides           | `<CACHE_DIR>/overrides/<finding_id>.json`         | finding_id (file content change invalidates)                  | 90 d   |

TTLs are declared in `code_review_schema.CACHE_TTL_DAYS` and enforced
**sweep-on-read** by `_is_entry_fresh(entry, namespace)` in the
helpers. Stale entries count as a cache miss; the next review
regenerates fresh findings.

Phase 7 ships the BHA producer end-to-end (canonical `prompt_hash`,
TTL enforcement on read, `telemetry.cache_hit_rate["bha"]` populated
from `cache_result.json` by `finalize-result`). The other four
namespaces have their key inputs, paths, and TTLs declared but ship
real producers with plans 03 (verifications, overrides) and 05
(signals, coverage_critic).

The canonical on-disk file layout `<CACHE_DIR>/bha/<file_hash>.json`
(per-file caches) is a future migration; the current implementation
uses a single `<CACHE_DIR>/manifest.json` with per-file entries, which
shares the same key inputs and invalidation contract.

---

## 10. Schema migration policy (PLN-719 Section 12)

`schema_version` is integer-only. MAJOR bumps required when:

- A required field is removed.
- A required field's semantics change.
- The shape of a top-level section changes (e.g., `findings[]` becomes a map).

Consumers must tolerate unknown additive fields. The validator emits a
`system_marker: "schema-version"` MEDIUM finding when reading a version higher
than its understood max (proceed but flag; not BLOCKING, because rolling
deployments mean a newer producer may emit before consumers update).

---

## 11. Telemetry (PLN-719 Phase 9 / Section 11)

The `telemetry` block on `review_result.json` is the single per-run metrics
surface. `finalize-result` always emits one — starting from the canonical
zero-valued factory (`empty_telemetry()`) and deep-merging any
`<cr_dir>/telemetry.json` written by the orchestrator (or any helper that
wraps a stage). The block is validated by `validate_telemetry`; unknown
keys are permitted (forward-compat) but the canonical keys below must be
present and typed correctly.

| Field                    | Type                              | Notes |
| ------------------------ | --------------------------------- | ----- |
| `duration_ms`            | `number ≥ 0`                      | Total wall-clock for the run. |
| `duration_by_stage_ms`   | `{string: number ≥ 0}`            | Keys are stage ids (e.g. `stage_05_parse_diff`) or reviewer agent ids. |
| `estimated_cost_usd`     | `number ≥ 0`                      | Aggregate cost across all model calls. |
| `tokens.input_uncached`  | `integer ≥ 0`                     | Tokens billed without cache hit. |
| `tokens.input_cached`    | `integer ≥ 0`                     | Tokens served by prompt cache. |
| `tokens.output`          | `integer ≥ 0`                     | Tokens emitted by all models. |
| `tokens.by_model`        | `{string: integer ≥ 0 \| object}` | Per-model totals or `{input, output, ...}` breakdown. |
| `cache_hit_rate`         | `{string: number in [0, 1]}`      | Keys are cache namespaces (`bha`, `signals`, `coverage_critic`, `verifications`, `overrides`). |
| `agent_failures`         | `integer ≥ 0`                     | Count of reviewer agents that errored. |
| `schema_versions_seen`   | `{string: integer}`               | Always overwritten by `finalize-result` to the current run's `SCHEMA_VERSION`; cannot be spoofed by upstream. |
| `findings_counts`        | `object` (optional)               | Free-form per-severity / per-category breakdown. |
| `verification_stats`     | `object` (optional)               | Verifier outcomes (populated by plan 03). |
| `coverage_stats`         | `object` (optional)               | Coverage plan outcomes (populated by plan 05). |

Stage producers populate timings and tokens by writing
`<cr_dir>/telemetry.json` before `finalize-result` runs:

```json
{
  "duration_ms": 12340,
  "duration_by_stage_ms": {
    "stage_05_parse_diff": 18,
    "stage_06_extract_patches": 22
  },
  "tokens": {"input_uncached": 4200, "output": 980},
  "cache_hit_rate": {"bha": 0.62}
}
```

The deep-merge in `merge_telemetry` recurses one level **only for keys in
the explicit whitelist** `TELEMETRY_DEEP_MERGE_KEYS = {duration_by_stage_ms,
tokens, cache_hit_rate, schema_versions_seen, findings_counts,
verification_stats, coverage_stats}`. Callers can populate `tokens.output`
without overriding the whole `tokens` block. Every other key — including
dict-typed fields not on the whitelist — is overwritten wholesale by the
overlay. Future schema additions whose merge semantics matter must opt
into the whitelist explicitly; the default for new dict-typed fields is
replace, which is the safe default for blocks where partial overrides
could corrupt the document. Cross-run aggregation is deferred to a future
analytics layer; the per-run schema is forward-compatible.

---

## 12. Golden fixture harness (PLN-719 Phase 8 / Section 10)

The harness pins the post-collection contract end-to-end. Each fixture
lives at `tools/python/fixtures/<name>/`:

| Path                  | Role                                                    |
| --------------------- | ------------------------------------------------------- |
| `config.yaml`         | Description, mode, diff_tip, and config-level oracles (`expected_verdict`, `expected_verified_count`, `expected_coverage_gap_count`). Each `expected_*` key, when present, drives a hard assertion against the produced envelope. |
| `inputs/`             | Canned upstream artifacts (`setup.json`, `scope.json`, `intent.json`, `diff_data.json`, one or more `agent_*.json`, optionally `hygiene.json` and `coverage_plan.json`). |
| `expected/review_result.json` | Normalized envelope diffed byte-by-byte.        |

The runner stages `inputs/` into a tmp `cr_dir`, runs the canonical
post-collection pipeline (`collect-findings` → `validate` →
`finalize-result`), normalizes non-deterministic fields (`review_id`
uuid, `emitted_at` timestamps, telemetry block), and diffs against
`expected/`. Every fixture also doubles as a schema round-trip check —
the harness re-runs `validate_result_envelope` on the produced envelope
and fails the test on any errors. The config-level oracles run even in
`--update-golden` mode, so a fixture whose `config.yaml` contradicts
its envelope cannot be silently pinned by the rewriter.

To update an `expected/` artifact after an intentional contract change:

```bash
pytest plugins/code-review/tools/python/test_golden_fixtures.py --update-golden
```

The flag rewrites every fixture's `expected/review_result.json` through
the same normalization path the assertion uses, so a subsequent
no-flag run sees byte-identical output. Updates are reviewed in the
commit diff, not auto-merged.

**Phase 8 shipped 3 fixtures end-to-end**
(`golden_minimal_correctness`, `golden_all_categories`,
`golden_schema_v1_round_trip`) plus a byte-identical determinism test
for `prepare-run`; PLN-720 promoted a 4th, `golden_injection_quarantine`.
The remaining 3 fixtures requiring plans 03/05/06
(`golden_impact_with_callsites`, `golden_coverage_gap`,
`golden_budget_exceeded`) have reserved directories with READMEs and
are skipped via a `_DEFERRED_FIXTURES` map in the test module until
their dependent plans land. The deterministic prefix (stages `01` through
Gate B) is pinned separately by `prefix_golden_harness.py` (PLN-1229
Phase 0); its subprocess A/B parity oracle guards the in-process
`run-prefix` batch runner byte-for-byte.

---

## References

- [PLN-719: Foundation plan](https://app.closedloop.ai/closedloop-ai/implementation-plans/PLN-719)
- [tools/python/code_review_schema.py](tools/python/code_review_schema.py) — canonical Python module
- [tools/python/test_code_review_schema.py](tools/python/test_code_review_schema.py) — schema tests + round-trips
