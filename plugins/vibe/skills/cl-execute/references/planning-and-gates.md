# Planning And Gates

Use this reference for readiness classification, requirements contracts, plan
drafting/review, proposal contract audits, performance work, UI plan approval,
and cleanup-tooling churn control.

## Readiness Gate

Before planning or execution, classify the ticket:

- Requirements: confirm desired behavior and acceptance criteria are current,
  specific, and testable.
- Active surface: confirm the named UI, route, package, component, service, or
  API exists and is used. For UI work, verify imports, routes, flags, or runtime
  usage; do not work Storybook-only, dead, or unused components unless the
  ticket explicitly calls for reviving, deleting, or testing dead code.
- UI design guidance: for UI work, confirm whether the ticket includes a design,
  screenshot, or prototype. If not, confirm product intent and target surface
  are clear enough to draft a concrete plan for human approval; otherwise block
  for product clarification.
- UI-impacting contracts: manifests, registries, route tables, navigation
  contracts, extension-slot contracts, adapter protocols, enum-like
  vocabularies, feature-gate maps, and shared component contracts are UI work
  when they can affect rendered output or reachability.
- Architecture fit: confirm the work belongs in existing owners, APIs, helpers,
  constants, tests, and data flow without an unrelated rewrite.
- Dependency readiness: confirm required design, product decisions, API
  contracts, data, auth, credentials, flags, migrations, or upstream PRs are
  available.
- Dependency unblock reconciliation: before returning an engineering blocker,
  verify every named blocking ticket, plan, `BLOCKS` link, and upstream PR
  against live ClosedLoop, closedloop-graph, GitHub PR state, current
  `origin/main` ancestry, and the current checkout. A non-terminal ClosedLoop
  status is not enough when a linked or referenced PR is already merged. If the
  blocking PR has landed and the ClosedLoop issue/link is stale, reconcile the
  stale status/link when the lane is authorized to mutate it, then rerun the
  readiness gate. If the lane cannot mutate it, return a stale-state
  reconciliation request instead of classifying the ticket as still blocked.
- Product answer discovery: before returning `PRODUCT_BLOCKED`, suggesting a
  Product contact, or drafting a Product-decision comment, search linked PRDs, plans, comments, sibling tickets, semantic facts, prior blockers, related product/design artifacts, and workflow repo memory for an existing
  authoritative answer. Use closedloop-graph as a primary discovery surface and
  re-fetch material decisions from live ClosedLoop. Treat implementation plans
  as decision records when they contain explicit accepted scope, exclusions,
  section decisions, or requirements mapping. If the Product contact is
  unavailable or out-of-office in current user/session context, first use
  existing answers and otherwise route exact missing decisions privately to
  Daniel/current user or engineering unless the user explicitly authorizes that
  exact Product comment.
- Latency, staleness, and disclosure contracts: verify exact ratified PRD,
  decision record, or linked owner before approving a plan that promises
  freshness ceilings, analytics lag, stale-but-shown behavior, disclosure, or
  rollout sequencing.
- External API/docs freshness: for third-party APIs, SDKs, hosted platforms,
  model providers, auth/billing providers, webhooks, or fast-moving
  integrations, consult current official online documentation and record URLs,
  visible version/date, and used facts.
- Duplication/conflict: confirm the request is not already done, superseded,
  duplicated, covered by active PR, or contradicted by linked plans/comments.
- Live artifact freshness: re-fetch live ticket, plan, blocker, sibling, and
  PRD statuses immediately before uploading or revising a plan, and cross-check
  dependency/blocker statuses against GitHub and current main when any blocker
  has a referenced PR, branch, merge event, or likely implementation artifact.
- Residual contract testability: map each residual contract, fallback, marker,
  selector, or display behavior to at least one test or validation probe that
  would fail on current main or on a representative pre-fix fixture. When the
  repository declares an evidence-capture verification protocol, plan a pre-fix
  reproduction captured with it for user-visible behavior. On bug tickets, name
  which probe is the red-first test that implementation commits before the fix
  (Execution step 6 in
  [implementation-review-pr.md](implementation-review-pr.md)), or why no cheap
  test path exists and which runtime evidence stands in for it.
- Scope ownership: resolve conditional transfer, missed acceptance from another
  ticket, fallback work owned by a sibling, or any proposed out-of-scope item
  before execution. Treat every scope exclusion as a claim to doubt, not a fact:
  use closedloop-graph, live ticket history, linked plans/comments, adjacent
  tickets, and related PRs to understand prior scope decisions and prove the
  work is intentionally outside this ticket and, when applicable, covered
  elsewhere. If the exclusion would create an uncovered requirements or
  acceptance gap, keep it in scope or return the normal blocker/human-review
  result instead of cutting it from the plan.
- Validation path: confirm a realistic local and CI validation path, including
  repository-supported headless/displayless E2E or an explicit automatic-CI
  fallback for unsupported local displayless scenarios.
- Runtime validation command proof: verify runtime pins, package-manager entry
  points, Node versions, browser/Electron harnesses, and E2E commands from the
  current checkout before naming them in a plan.
- Split lineage: identify whether the ticket is top-level or an existing split
  child from split-specific evidence for legacy context only. Existing split
  children are analyzed as the single tickets they now are.
- Safety and risk: identify auth, permissions, billing, data deletion,
  migrations, privacy/security boundaries, release automation, or broad
  cross-package contract changes.
- Safety fact: when the change touches auth, permissions, data writes,
  migrations, or a shared contract, carry `$cl-analyze`'s `Safety fact` into
  the plan's validation section: the one fact the change is safe because of,
  and the exact test, script, or `pnpm control` command that will prove it by
  running code. Re-derive it when planning changes the approach. A plan that
  argues the fact in prose without a runnable proof is incomplete. When the
  fact depends on a library, prove it against the version the lockfile pins,
  including any local patch, not against the latest docs. Before naming the
  fact, check the consumers a symbol search misses: JSON an API returns, a
  database column, a wire or IPC payload, another process reading the same
  bytes, a feature flag, and timing (teardown, retries, async ordering). Find
  them through the [Discovery Routes](../SKILL.md#discovery-routes)
  (`code_importers` and `code_callers` for code consumers, `code_grep` for the
  field, column, channel, and flag names), verified with `rg`. List the risks
  you checked and cleared next to the fact so review does not redo them.

Gate outcomes: `GO`, `GO_WITH_UI_PLAN_APPROVAL`, `PRODUCT_BLOCKED`,
`ENGINEERING_BLOCKED`, `ALREADY_DONE_OR_DUPLICATE`, and
`HUMAN_REVIEW_REQUIRED`. Older `SPLIT_REPAIR_REQUIRED` evidence is legacy and
must not become a new split or repair route. `HIGH` complexity blocks unless an
exact-ticket human override approves the atomic unsplit shape. `EXTREME` risk
always blocks.

Do not approve the plan, create a branch, edit code, open a PR, or merge unless
the gate is `GO`, `Complexity` is not `HIGH` or the override is `APPROVED`,
`Risk` is not `EXTREME`, no readiness item is `BLOCKED` or `UNKNOWN`, and
external docs freshness is `PASS` or `NOT_APPLICABLE`. `GO_WITH_UI_PLAN_APPROVAL`
may proceed through plan upload only, then must wait for explicit approval.

## Requirements Contract

Treat the current approved PRDs linked to or explicitly designated for the ticket
as the product contract throughout execution.

1. Record applicable PRD slugs/versions and requirement IDs in the plan. If no
   PRD applies, state `not_applicable` with evidence.
2. Require planning, implementation, validation, conflict-resolution, and review
   work to read applicable PRDs and check proposed changes against them.
3. Before accepting a plan finding, PR review comment, merge-conflict choice, or
   compatibility change, verify it preserves ticket and PRD contracts. Reject
   incompatible feedback with concrete PRD rationale. Before routing ambiguity
   to Product, run Product Answer Discovery and prove no linked artifact or
   prior decision already answers it.
4. Before merge or merge queue action, perform one bounded conformance check
   from changed behavior/tests to applicable requirement IDs and record it.

## Proposal Contract Audit

Run this audit during plan drafting and plan review when the plan will create,
update, delete, downgrade, preserve, or reinterpret persisted data or durable
contract shape. This includes database rows, artifact links, metadata keys,
feature/status values, selector inputs, reconciliation targets, provider-derived
identities, retry queues, durable wire fields, shared manifests, registries,
navigation contracts, adapter protocols, enum-like vocabularies, and extension
or provider slots.

For each proposed durable write or contract change:

1. Name exact fields, metadata keys, row types, link shapes, or contract values.
2. Identify read, analytics, admission/fallback, delete, downgrade, retraction,
   retry, reconciliation, and export consumers through the
   [Discovery Routes](../SKILL.md#discovery-routes) (`code_callers`,
   `code_importers`, and `code_grep` for field, key, and value names), then
   local source inspection.
3. Prove selectors, crons, retries, or reconcilers can see the claimed target
   population. Check source tables, joins/`EXISTS`, null handling, indexes,
   debounce clocks, and tenant/repository scope.
4. Prove the named writer is authorized to create, update, delete, or preserve
   that row type.
5. Prove live control flow reaches every predicate, fallback arm, or
   admission/retraction path the plan proposes.
6. Search live related tickets, open or landed PRs, and graph facts by touched
   symbols, files, row/link shapes, metadata keys, and product terms
   (`blast_radius_tickets` on the files, `fts_search` on the keys and terms,
   `search_memory_facts` for stated relationships), then verify live.
7. Record controls for fallback predicates, status derivation, freshness gates,
   retry stores/clocks, transaction budgets, file-size ceilings, unique-race
   behavior, version-skew omission/null semantics, and validation coverage.

If the audit fails, narrow the plan, defer invalid work, or return the normal
blocker. Do not split the ticket, and do not encode unresolved behavior as an
implementation detail.

## Ephemeral Cleanup Tooling Guard

Before approving a plan that adds one-off migration, cleanup, backfill, audit,
or operator tooling, classify each new script/test/helper as `durable` or
`ephemeral` and record that classification in the plan.

For `ephemeral` tooling, prefer an existing runbook, committed ops SQL, console
task, or non-committed local artifact when that path can provide reviewable,
auditable evidence without landing short-lived source. If committed source is
still necessary, the plan must state why a non-committed path is insufficient
and include one of these exit paths before implementation starts:

- an explicit follow-up ticket/phase to remove or graduate the tooling;
- a same-ticket removal phase after the operator evidence is captured; or
- a durable ownership statement explaining why the tooling remains maintained
  production/operator surface.

The plan review must check this classification. A plan that lands disposable
tooling without an exit path is incomplete even if the ticket is otherwise ready.

## Performance Measurement Contract

For latency, throughput, profiling, optimization, query/runtime cost, or
regression tickets, measurement evidence is part of acceptance.

1. Load `measurement-discipline` by name (`$measurement-discipline` in Codex or
   `/closedloop-core:measurement-discipline` in Claude Code) before diagnosing,
   optimizing, or reporting a performance result. Search measurement logs, workflow memory, and
   ticket/code history by symptom and mechanism (closedloop-graph `fts_search`
   and `blast_radius_tickets` first, then `git log`).
2. Baseline before editing whenever feasible. Use one discarded warmup plus at
   least five or six warm samples, record samples, median, spread/noise floor,
   and a control path. Change one variable at a time. Interleave base and after
   samples when both builds can run side by side. When the base lacks the
   measured feature, set an absolute budget for the added work and the
   user-visible end state instead of reporting a ratio between unlike
   scenarios.
3. Generate hypotheses from what the baseline shows, not from habit. Check in
   order: can the work be deleted (unconsumed computation, an always-off path,
   a redundant sync); does cost scale with input size (chunk, prune,
   parallelize); does identical work repeat (cache it, and name what
   invalidates the cache before claiming the win); do many small calls each pay
   fixed overhead (batch); is cost paid for results not yet needed (defer);
   must it happen during the interactive moment at all (schedule it elsewhere,
   and measure the interactive path, not total work). A family earns an attempt
   only when the baseline shows its signal.
4. Tie measurements to the product goal. Local helper/SQL microbenchmarks are
   supporting evidence unless related to the slow page/route/workflow stage.
   When production telemetry exists for the product surface (for example
   Datadog RUM/APM page-load, route-span, or service-resource data), record the
   exact query/window and the available baseline/comparison values; if you
   cannot access or export it, report that as an evidence gap rather than
   substituting local-only numbers.
5. After any adopted improvement, re-measure, identify the next bottleneck or
   prove no credible in-scope bottleneck remains, and record a stopping
   condition. Do not stop after the first measured change: iterate until
   further in-scope improvements are within noise or negligible, blocked, or
   outside the approved ticket/PRD/product boundary.
6. Use repo-supported seed, fixture, or workload. Before trusting a baseline,
   prove the workload is sensitive: run it at the size and state that match the
   complaint and at a clearly smaller one, and show the metric separates. If the
   realistic case does not reproduce the slowness, fix the workload before
   changing code. Revert a rejected attempt in full before the next one, and
   rerun the focused regression tests on every kept attempt. In
   `symphony-alpha`, API/branch analytics latency work that depends on branch
   analytics data uses the branch analytics perf fixture or a more specific
   documented perf harness when one exists. For production DB evidence, prefer committed ops
   SQL/runbooks/psql patterns over ad hoc app code.
7. Concurrent performance workers must use worker-isolated local databases or
   datastores; never share a mutable perf database with another active worker.
   If a fixture permits only a fixed database name, isolate by worker-specific
   local instance, container, schema, or port while keeping the permitted name.
8. Tests, typecheck, lint, and CI do not replace performance measurement.
9. Include measurement summary, commands with credentials redacted, dataset,
   isolation evidence, samples, control, mechanism, product-surface relevance,
   telemetry evidence gap or values, verdict, remaining-bottleneck check, and
   stop condition in the plan and result. The PR body carries a summary line
   (verdict, median before and after, noise floor) and a link to that record.
10. If measurement cannot run, return a concrete blocker, `NO_WORK`, or an
    inconclusive or refuted result; never report terminal performance success
    without the measurement.

## Planning Workflow

Start the ticket's private decision log (Execution step 12 in
[implementation-review-pr.md](implementation-review-pr.md)) when planning
begins; planning forks, prototypes, and scope cuts are rows too. Find things
through the [Discovery Routes](../SKILL.md#discovery-routes).

1. Read root and relevant nested `AGENTS.md`, `CLAUDE.md` when present, and
   current repo docs for the touched surface.
2. Inspect existing implementation before proposing changes. Prefer established
   owners, APIs, constants, helpers, tests, and UI surfaces.
3. Settle technical questions by running something. When the plan hinges on a
   fact that running code can observe (whether a library at the
   lockfile-pinned version supports a call, whether a query uses an index,
   which of two approaches is faster, whether a layout fits, whether a harness
   can drive the path), first look for a recorded answer with closedloop-graph
   `fts_search` and `search_memory_facts` and in workflow memory. If none
   holds, build the smallest throwaway prototype in a scratch worktree
   detached at the base commit, never in the ticket worktree or on the ticket
   branch, observe the result, and remove the scratch worktree. Cite the
   command and output in the plan's Risks & Constraints or Test Plan and log it
   in the decision log. Do not return an engineering blocker, or ask Daniel to
   choose between approaches, when one bounded prototype can decide it; if it
   cannot, block as before and include what the prototype showed. Questions
   `$cl-analyze` recorded under `Technical questions for planning` are settled
   here. Product questions still go through Product Answer Discovery.
4. Before the plan changes or removes existing behavior (a guard, retry,
   fallback, special case, flag, limit, or compatibility path), learn why it
   exists and what was tried before. Start with closedloop-graph:
   `blast_radius_tickets` on each touched file (the repo-qualified path from
   `code_symbols`) for the tickets that changed it, `ticket_detail` on those
   tickets and on this one for lineage, branches, and PRs, `fts_search` on the
   symptom and the behavior's names, and `search_memory_facts` for stated
   rationale. Then verify against the checkout and fill gaps with `git log -S`
   or `git log -L` and `git blame` on the lines, and `gh pr view` on the
   introducing PR's body and review comments. Look for prior or reverted
   attempts at this ticket or surface: closed-unmerged PRs, revert commits,
   earlier `CL Execute Result` artifacts, and `cl_sweep_ticket_state` records
   for the slug in workflow memory. Treat the ticket's stated cause or proposed
   fix as a hypothesis, not the answer. In Risks & Constraints, record what to
   Preserve, what to Change, what to Avoid (including approaches tried and
   reverted), and the Risk, citing the commit, PR, or ticket for each. When no
   reason can be found, say so and list the searches run. Never cite code as
   evidence of its own intent.
5. Use planning investigation workers on Desktop for non-trivial scope. In CLI,
   the ticket worker performs investigation and may launch one bounded
   `planning_review` support lane under
   [support-lanes-and-sweeps.md](support-lanes-and-sweeps.md).
6. Before upload/revision, run sibling-ownership and current-checkout proof over
   the linked PRD workstream. Include terminal `DONE` siblings,
   corrected/superseding sections, and directly related plans.
7. Before upload/revision, run live overlap for planned files/surfaces,
   including recently merged and currently open PRs: closedloop-graph
   `blast_radius_tickets` on each planned file and `query_wip` for active work,
   then live GitHub.
8. For UI, feature-flag, or launch-surface work, audit product copy and
   affordances against proposed behavior. Shared rendered code needs a
   closed-by-default plan for every mounted runtime unless reachability is
   proven narrower. When the plan adds or renames a PostHog-backed feature flag,
   include the exact flag key, intended default/off behavior, rollout owner, and
   the pre-merge PostHog creation check in the plan.
9. For shared UI host adapters, discover production guardrails and extend them
   to every new host.
10. Audit tests that seed the target feature flag or host mode for false greens.
    Do not treat code, tests, PR-body attestation, or a green PostHog-existence
    check as sufficient if the flag is absent from the live PostHog project.
11. For UI work, write a specific UI plan section naming route/screen/component,
    placement, design-system reuse, user states, responsive behavior,
    accessibility, visual QA, assumptions, and approval need.
12. Run Proposal Contract Audit when the readiness gate or investigation
    indicates a durable data or contract-shape change.
13. Name the shape before the tasks. When the change adds state, branches on a
    mode or kind, repeats a shape assumption across files, or makes an
    architectural choice with no precedent in the touched code, name in
    Architecture Fit the data shape and the structure that organizes it (a
    state machine over independent booleans, a table or registry over
    branching, one typed model over repeated shape checks), and the strongest
    alternative you rejected with the concrete reason, grounded in code or
    requirements. Skip this for established patterns, bug fixes, and choices
    the ticket or PRD already makes, and never turn the alternative into a
    question for the operator.
14. One-way-door plans (Proposal Contract Audit `REQUIRED`, a new shared module
    or ownership boundary, or `High-complexity execution override: APPROVED`)
    get more design before drafting:
    - Design it twice. Get a second, structurally different approach from the
      other model family with the read-only command in
      [cross-family-review.md](cross-family-review.md), run from a detached
      scratch worktree at the base commit, with a design prompt that carries
      the ticket intent and your grounding but not your approach. This is
      planning, not a review generation.
    - Screen both approaches for four red flags: a shallow module (callers
      coordinate several calls for one operation), information leakage (one
      internal decision repeated across modules), temporal decomposition
      (modules split by execution order instead of by the knowledge they own),
      and pass-through methods. Take as the base the approach a future
      maintainer can extend without breaking invariants, fold in the best part
      of the other by hand, and record the losing shape and why it lost as step
      13's rejected alternative. If the two disagree on which module owns the
      change, resolve that as an Architecture fit finding before drafting.
    - Order the phases riskiest unknown first. End each phase with its own pass
      predicate and the command that checks it, and run that command before
      the next phase starts. Report each check as VERIFIED, NOT VERIFIED, or
      INCONCLUSIVE; INCONCLUSIVE is not a pass. A check that passes on the first
      try against a change that should have moved it is suspect: show it can
      fail (for example on the base) before trusting it.
15. Load `plan-structure` by name (`$plan-structure` in Codex or
    `/closedloop-core:plan-structure` in Claude Code), then read the exact
    `resources/plan_template.md` from that skill's own folder immediately
    before drafting or revising.
16. Use the `mermaid-visualizer` skill before drafting or revising the plan.
    Include at least one Mermaid flowchart code fence that helps Daniel
    understand the implementation scope. Default to paired before/after
    flowcharts when the work changes architecture, control flow, data flow,
    lifecycle states, retry/recovery behavior, persistence, API/wire movement,
    or UI/user flow. For simple or narrow work, include the smallest useful
    flowchart that names the touched owner, the current path, and the planned
    path. Keep diagrams syntactically conservative: stable node IDs, short
    labels, and no unescaped pipes, quotes, brackets, colons, or semicolons in
    node IDs.
17. Before listing any work as out of scope, deferred, or owned elsewhere,
    record the prior scope history and evidence from closedloop-graph, live
    ticket history, adjacent tickets, related PRs, or linked plans/comments that
    proves the exclusion is intentional and covered when coverage is required.
    Doubt the cut: if the plan cannot name where the requirement will be
    satisfied, do not remove it from the ticket's scope.
18. Prepare the ClosedLoop plan with ticket URL/slug, scope, acceptance criteria,
    approach, validation plan, risks, UI design source/approval need, external
    official-doc evidence, and review-findings section. Keep internal
    sweep/worker/orchestrator details out of reviewed plans. The plan is a
    durable artifact for future work, not a review transcript, change log, or
    revision note: do not mention prior plan versions, "this version fixes",
    reviewer names, internal dialogue, review-blocking point lists, or why a
    previous draft changed. Preserve any valid technical constraints as
    forward-looking requirements, gates, risks, or validation items in the
    template sections where they belong. Write plan prose by
    [writing.md](writing.md).
19. Lint the draft before independent plan review and again before every
    upload or revision with this installed skill's `scripts/check-plan.mjs`:
    `node <cl-execute-skill-dir>/scripts/check-plan.mjs <plan.md> --template "<plan-structure-skill-dir>/resources/plan_template.md" [--bug] [--safety-fact] [--narrow]`.
    Pass `--bug` on a bug ticket, `--safety-fact` when the plan carries a
    Safety fact, and `--narrow` only for simple or narrow work where step 16
    allows one flowchart. It checks the template's headings in order, left-over
    template placeholders, Mermaid flowcharts (before and after unless
    `--narrow`), that every `AC-` id maps to a task or test, revision narration
    and sweep internals, and the Safety fact and red-first entries when
    flagged. Fix every line it prints; a nonzero exit is an actionable plan
    defect. Record the command and exit status as `Plan lint`. The plan
    reviewer no longer checks these mechanically and judges substance: whether
    the diagrams explain the scope, the approach is sound, and the evidence
    holds.
20. Run independent plan review, fix actionable findings, and re-upload/revise
    as needed. Never edit skill files from a ticket worker. When a cl-* skill
    instruction was missing, wrong, contradictory, or did not fire when it
    should have, record it in the result's `Process feedback` field: the skill
    file and section, the observed failure with an evidence pointer, and the
    proposed one-line change. Record only items that would change a future
    worker's action.
21. If human UI plan approval is required, do not approve the plan yourself;
    return `WAITING_UI_PLAN_APPROVAL` with the plan URL.
22. If human UI plan approval is not required or is already approved, mark or
    confirm the plan `APPROVED` and begin execution.
