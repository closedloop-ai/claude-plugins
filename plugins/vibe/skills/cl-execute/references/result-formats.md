# Result Formats

Use these exact structures for gate and terminal/handoff reporting.

In every free-text field (`Blocker`, `Validation`, `Per-ticket result`,
readiness reasons, and the rest), each causal or state claim carries its
evidence in the same sentence: the command and its output, the artifact path,
or the live URL. Label a claim you did not observe `inferred` (from reading
code) or `unverified`. Never hand Daniel a check you could run: do not return a
blocker, wait, or manual-intervention status that asks a human to run a
command, open a page, or read a log you can reach yourself; run it and report
the result. Write these fields by [writing.md](writing.md).

## CL Execute Gate Result

```markdown
## CL Execute Gate Result
Batch: <not_applicable | stable batch id>
Tickets: <all FEA/ISS slugs and URLs>
Per-ticket gate: <slug -> decision, complexity/risk, requirements contract, readiness summary>
Decision: <GO | GO_WITH_UI_PLAN_APPROVAL | PRODUCT_BLOCKED | ENGINEERING_BLOCKED | ALREADY_DONE_OR_DUPLICATE | HUMAN_REVIEW_REQUIRED>
Split lineage: <top_level | split_child | unknown>
Parent split ticket: <parent FEA/url and split signature, or none>
Complexity: <LOW | MEDIUM | HIGH>
High-complexity execution override: <not_applicable | APPROVED - exact ticket-specific human instruction and atomic-shape acceptance>
Risk: <LOW | MEDIUM | HIGH | EXTREME>
Confidence: <LOW | MEDIUM | HIGH>
UI work: <YES | NO | UNKNOWN>
UI design source: <not_applicable | design | screenshot | prototype | missing>
Human UI plan approval: <not_required | required | approved | blocked>
UI plan approval reason: <why approval is or is not required>

Readiness:
- Requirements: <PASS | BLOCKED | UNKNOWN> - <reason>
- Product answer discovery: <PASS | BLOCKED | UNKNOWN> - <linked PRDs/plans/comments/sibling tickets/semantic facts/prior blockers/product-design artifacts searched, answers found or exact missing decisions, product-contact availability>
- Active surface: <PASS | BLOCKED | UNKNOWN> - <reason>
- UI design guidance: <PASS | APPROVAL_REQUIRED | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <design/screenshot/prototype evidence, planned-approval reason, or blocker>
- Architecture fit: <PASS | BLOCKED | UNKNOWN> - <reason>
- Dependencies: <PASS | BLOCKED | UNKNOWN> - <reason>
- External API/docs freshness: <PASS | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <official docs URLs/date/version or reason>
- Duplication/conflict: <PASS | BLOCKED | UNKNOWN> - <reason>
- Live artifact freshness: <PASS | BLOCKED | UNKNOWN> - <live status check and any stale historical evidence>
- Residual contract testability: <PASS | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <failing-main proof or reason>
- Validation path: <PASS | BLOCKED | UNKNOWN> - <reason>
- Runtime validation command proof: <PASS | BLOCKED | UNKNOWN> - <repo-pinned command proof or limitation>
- Safety/risk: <PASS | BLOCKED | UNKNOWN> - <reason>
- Safety fact: <PASS | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <the one fact the change is safe because of and its planned runnable proof, or reason>

Next action:
- <proceed to execution | create plan and wait for human approval | add Product-decision comment | surface exact missing decisions privately to Daniel/current user or engineering | surface engineering blocker privately to user | manual intervention>
```

If this gate blocks execution, end with the normal `CL Execute Result` using
`Status: BLOCKED_BEFORE_START`, `Feature status: <unchanged status>`, `PR:
none`, `Branch: none`, and the matching `Next parent action`. Never recommend
an engineering/operational ticket comment or DM without exact user
authorization.

## CL Execute Result

```markdown
## CL Execute Result
Batch: <not_applicable | stable batch id>
Tickets: <all FEA/ISS slugs and URLs>
Execution surface: <desktop | cli | standalone>
Owner: <task/session id, generation, lease id, and lease token hash | standalone task id>
Callback: <Desktop callback result | CL_SWEEP_EVENT v1 event id/status>
Support lanes: <planning/review/visual request ids and artifact hashes | not_applicable>
Review generations: <review_generation_1 id, review_generation_2 id | not_started>
Cross-family review: <per generation: reviewer CLI/version/model, result path and SHA-256, finding counts per triage category, cross-family consensus findings | unavailable: exact command, exit code, and error, plus same-family fallback lane id | not_started>
Per-ticket result: <slug -> status, plan, requirements/acceptance evidence>
Status: <MERGED | PR_MONITORING_HANDOFF | BLOCKED_BEFORE_START | BLOCKED_AFTER_START | WAITING_UI_PLAN_APPROVAL | WAITING_MANUAL_QA | WAITING_CI | WAITING_REVIEW | WAITING_HUMAN_MERGE | CI_FAILED_NEEDS_HUMAN | REVIEW_BLOCKED | MANUAL_INTERVENTION_REQUIRED>
Feature status: <per-ticket ClosedLoop statuses>
Plan: <plan URL/id per ticket or shared batch plan>
PR: <PR URL or none>
Branch: <branch name or none>
PR head: <current head SHA or none>
Feature PR boundary: <single integrated PR with all member tickets and shipping surfaces | not_applicable before PR>
Manual QA plan comment: <verified owned comment id/url and planned head | none before PR>
Manual QA author: <live human PR author identity | explicitly designated responsible human for nonhuman PR author | pending>
Manual QA record: <durable untracked record path and evidence references | none before PR>
Manual QA state: <passed with PASS/FAIL/BLOCKED/PENDING totals | waiting_human with totals | failed with remediation state | blocked with reason | not_started before PR>
Manual QA head coverage: <current PR head, tested head, merge base and stable patch-id at each, main's changed files between the merge bases when the patch-id is unchanged, affected reruns, and justified unaffected carry-forward | none>
Passive monitor owner: <cl-sweep parent thread id | this standalone thread | none>
Monitor identity: <parent_to_start_or_refresh | PID, state/log files, target thread, watched head/generation | none>
Validation: <commands and result summary>
Performance measurement: <not_applicable | isolated seed/workload, database isolation evidence, baseline/after/control samples, median/spread, mechanism, product-surface relevance, production telemetry query/window and values or evidence gap, verdict, remaining-bottleneck check, stop condition | blocked/inconclusive reason>
Automated E2E display mode: <browser headless and Electron displayless commands/evidence | exact unsupported-local-path limitation and automatic-CI evidence | not_applicable with reason>
Red-first evidence: <not_applicable - not a bug ticket | two reproductions, failing-test commit with its failure output on the base and the assertion it failed on, then fix commit | test and fix committed together because a mandatory hook rejected the red commit, with the recorded failing run | no cheap test path: reason and the pre-fix runtime evidence used>
Root cause: <not_applicable - not a bug ticket | one-sentence cause, the runtime observation that confirmed it, the hypotheses ruled out, and sibling sites fixed or routed | unconfirmed: strongest hypothesis and why it could not be confirmed | not reproducible on current main: attempts, captures, and the fixing commit or PR if found>
Behavior pin: <not_applicable - not a behavior-preserving ticket | pins (tests, snapshots, or captured outputs, shim paths included) recorded on the base and shown unchanged after the move | pin changed: behavior change checked against the requirements contract>
Safety fact: <not_applicable - no auth, permission, data-write, migration, or shared-contract change | fact plus the test, script, or pnpm control command run and its output, with the head and patch-id it ran at, and cleared: <risks checked and why they do not reach> | blocked with exact reason>
Repo verification evidence: <before/after artifact paths captured with the repo-declared protocol (`pnpm control` in symphony-alpha) per touched surface, with the head and patch-id captured at | not_applicable: docs-only, tests-only, CI/config-only, or behavior-neutral refactor proven by tests | blocked with the exact control command and error | no repo protocol declared>
Correction events: <artifact ref for emitted correction events | none | no repo intake declared>
Plan lint: <check-plan.mjs command and exit status at the last plan upload or revision | not_applicable before planning>
Decision log: <private log path, SHA-256, and row count | not_applicable - reason>
Attention: <none | up to five items Daniel should check first, each with its evidence pointer: decision-log flags from `review_generation_2`'s cross-family lane (reviewed by <reviewer model>, or unavailable), lone security or correctness findings rejected, same-family fallbacks, manual-QA carry-forwards, scope exclusions, and translated or inconclusive evidence>
Process feedback: <none | one line per item: cl-* skill file and section; the observed failure with an evidence pointer; the proposed one-line change>
External docs: <not_applicable | official docs URLs/date/version and facts used | blocked/unknown reason>
UI work: <YES | NO | UNKNOWN>
UI design source: <not_applicable | design | screenshot | prototype | missing>
UI visual QA: <passed with pre-PR artifact ids/hashes | not_applicable with production-consumer proof | explicit_exception with Daniel's exact exception | blocked with exact blocker | missing>
Human UI plan approval: <not_required | required | approved | blocked>
CI: <green with every automatic current-head check green or correctly skipped | failing, including any coverage failure | pending | throttled | not_started>
Review state: <approved | changes_requested | pending | not_started>
Requirements contract: <applicable PRD slugs/versions and conformance result | not_applicable with reason>
Product answer discovery: <existing authoritative answer evidence or exact missing product decision and availability routing | not_applicable>
Merge queue: <not_applicable | queued | dequeued_recovering | merged>
Merge queue generation: <entry id, base SHA, PR head SHA, synthetic head SHA | none>
Merge queue recoveries: <none | count and concise attributable/non-attributable reason summary>
Merge disposition: <direct_protected_queue | human_manual_merge | undetermined>
Review learning memory: <not_applicable | comma-separated added/reused workflow-memory titles or ids | blocked with reason>
Completion message: not_posted_by_policy
ClosedLoop blocker comment: <product_comment_posted | explicitly_user_authorized | not_applicable>
ClosedLoop comment id/url: <id/url or none>
Engineering attention DM: <not_required | explicitly_user_authorized | sent | blocked>
Blocker: <none or concrete blocker>
Next parent action: <none | start or refresh one detached PR monitor | resume worker with exact material event evidence | wait for human UI plan approval | continue after human UI plan approval | wait for Daniel's human/manual UI merge | add ClosedLoop comment tagging product contact | surface exact missing decisions privately to Daniel/current user or engineering | surface engineering blocker privately to user | manual intervention>
```

For `UI work: YES`, `UI visual QA: blocked` or `missing` is never a ready or
waiting-human state; pairing it with `WAITING_HUMAN_MERGE`, ready-to-merge, or
queue-ready language is a malformed handoff. The
[Parker Visual-QA Gate](implementation-review-pr.md#parker-visual-qa-gate) says
what to return instead.

`Process feedback` records only gaps in the cl-* skills that would change a
future worker's action: an instruction that was missing, wrong, contradictory,
or did not fire when it should have. Skip one-off facts, SHAs, and
ticket-specific detail. Workers never edit skill files; the parent collects
these lines.

`WAITING_MANUAL_QA` is a human-readable execution state transported through the
existing `WAITING_HUMAN` callback kind with
`payload.summary.wait_kind: manual_qa`, the comment and record artifacts, and a
concrete `payload.routing.recheck_when`. It does not add a callback kind. Use
`Next parent action: resume worker with exact material event evidence` for the
author response. No status may claim functional readiness, queue readiness,
human-merge-only readiness, or terminal completion while required manual-QA
scenarios are `PENDING`, `FAIL`, or `BLOCKED`, or while head evidence is stale.
