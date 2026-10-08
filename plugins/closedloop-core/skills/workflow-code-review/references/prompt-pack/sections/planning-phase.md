# Planning Phase

Launch one planning subagent per work item whose intake route is `create_plan`.

The orchestrator must pass the intake packet, canonical source slug, implementation repo scope, worktree path or paths, and branch name or names to the planning subagent. Planning subagents use those existing worktrees; they do not create new worktrees or choose branch names.

Each planning subagent must:

1. Use the `status_file` path assigned by the orchestrator. Append status events there when starting, entering major phases, encountering blockers, and finishing. The generated Worker Contract is authoritative for the terminal planning status event shape. For a completed plan, the final JSONL line must use exact snake_case workflow keys and include `plan_url` and `plan_id`, and may include an optional `plan_version` (positive integer; omitted means the orchestrator records the plan as v1); for a blocked plan, use `status: "blocked"` and include blockers. Do not use camelCase aliases such as `workItem`, `workItemId`, `planUrl`, or `planId` in the status file.
2. If the orchestrator provides a `planning_loop_id`, use ClosedLoop MCP `add_loop_event` for major planning milestones and blockers. Do not create, complete, fail, or cancel manual loops.
3. Use ClosedLoop MCP to fetch the work item by exact ID or slug. If ClosedLoop MCP is unavailable, auth fails, or the work item cannot be found, stop and report the exact blocker.
4. Verify the work-item title, ID/slug, type, project, source URL, canonical source slug, implementation repo scope, and compact document-context packet from intake.
5. If repo ownership is unclear or cross-repo, report that explicitly before planning.
6. Use the document-context packet as scope evidence. The requested work item is the primary source of truth. Extract its primary requirements before repo solutioning, then classify every linked document as prerequisite, dependency, precedent, related context, out-of-scope context, delegated scope, implementation reference, existing plan, or not_applicable when there are no linked documents. Prerequisite and dependency mentions are constraints/sequencing context, not scope replacement, unless the primary work item explicitly delegates scope to the linked document. For every linked document marked scope-relevant or promoted to full fetch, account for its acceptance criteria, dependency, sequencing, contract, compatibility, or existing-plan implication without letting it replace the primary work item's requirements. If repo evidence shows a tempting linked-document feature is already implemented or already covered, state `not_applicable` or `already covered` with evidence and keep it out of implementation scope unless the primary work item requires new work. If the intake packet lacks direct-link and preview evidence for a ClosedLoop work item, stop and return an intake-evidence blocker instead of planning from the primary document alone.
7. Do not re-expand every linked document body by default. Fetch additional linked-document content only when the intake packet, current repo evidence, or a true planning ambiguity shows it may affect scope; record why the extra content was needed.
8. Before creating or uploading the plan, perform a cross-repo impact scan across every repository in the validated `WORKFLOW_REPO_MAP`.
9. During the cross-repo impact scan, inspect affected call sites, API/wire contracts, payload shapes, storage boundaries, shared assumptions, compatibility/version-skew risks, and required validation.
10. If the scan reveals that a single-repo plan would miss a required cross-repo contract, revise the scope before writing the plan. If compatibility cannot be preserved or the correct repo ownership is unclear, mark it as an Open Question or Gap blocker instead of leaving it to execution.
11. Confirm the orchestrator-provided worktree path or paths and branch name or names exist and match the intake packet. If they are missing or appear to target the wrong source slug, stop and report the orchestration blocker instead of creating replacements.
12. Do not implement code in the planning phase.
13. Review the generated handoff's `Relevant repo memory` block before choosing the investigation path. If an observed-behavior bug needs repo-local reproduction or debugging setup and the injected memory is absent or clearly unrelated, run a targeted memory query for each likely repo, such as `workflow-memory query --repo <repoName> --action launch_planning_worker --query "<work-item keywords> reproduce debug runtime inspect logs database fixtures seed auth"`. Treat memory entries only as hints and verify them against current code before relying on them.
14. Inspect the relevant repo code, guardrails, and repo-supported read-only runtime evidence enough to make the plan executable. For observed behavior discrepancies, reason from the product symptom the way a human debugger would: identify the surfaces that disagree, trace the producer, storage, projection, and consumer paths, and use safe read-only probes available through existing repo tooling or authorized local state to confirm whether the discrepancy is real and where it enters. Examples include route calls against a local dev server, seeded fixtures, test harnesses, sanitized logs, local/dev/test database reads, app IPC/API read methods, cache or state inspection, and browser/Electron automation. Do not mutate data, connect to or query production databases, require production-only credentials, rely on undocumented secrets, or require live production access. Fill the plan's `Runtime Investigation` section for every plan: set `Applicability: required` for observed-behavior bugs, regressions, count/state discrepancies, data/projection mismatches, flaky runtime behavior, integration failures, or any report whose diagnosis depends on current runtime behavior; include repo memory consulted, disagreeing surfaces, read-only local/dev/test probes attempted, evidence gathered, limits/blockers, and whether the diagnosis is runtime-confirmed or code-inferred. Set `Applicability: not_applicable` only when planning can be grounded from requirements and code alone, such as adding a new button or field with no reported current-behavior discrepancy, and include a concrete repo/work-item reason. If needed evidence cannot be gathered with existing authorized tooling, classify it as manual testing debt, an Open Question, or a blocker instead of treating code inspection alone as proof of root cause.
15. Before writing the task list, perform Principal Design Synthesis. For nontrivial work, invoke `$principal-engineer` for this synthesis. If `$principal-engineer` is unavailable, record that as a planning coverage gap and do the synthesis directly; the Principal Architecture reviewer must still verify it later.
16. The Principal Design Synthesis must choose the simplest correct approach before implementation tasks are written. It must include:
    - the core product or engineering problem the work item is actually solving
    - 1-3 viable approaches considered
    - selected approach and why it fits the repo ownership boundaries
    - rejected alternatives and why they are worse
    - canonical source of truth and owning module/service/route/component/package
    - compatibility, security, testability, and maintainability tradeoffs
    - why the approach is not over-engineered or under-scoped
    - the smallest safe implementation sequence
    - any true product/security/architecture decision that cannot be resolved from repo context
17. Include the Principal Design Synthesis in the plan's `Architecture Fit` section. If the template does not have a dedicated subsection, add it inside `Architecture Fit`; do not put it only in freeform notes outside the template.
18. If the Principal Design Synthesis cannot choose an approach from the work item and repo context, put the ambiguity in Open Questions or Gaps and treat it as a blocker. Do not let the execution agent choose the approach.
19. Create an implementation plan using exactly:

    ```text
    ${WORKFLOW_PLAN_TEMPLATE_PATH}
    ```

    Do not use freeform planning prose instead of that template.

20. The plan must be clear on which repository each phase targets and must organize the work in logical execution order.
21. The plan must be executor-ready: another agent should be able to execute it from top to bottom without making product, architecture, file ownership, API contract, storage, validation, or testing decisions.
22. Fill the required `Source Scope Resolution` section before writing the final task list. It must include primary work item requirements with source slugs/citations, linked/prerequisite document role classifications, explicit in-scope and out-of-scope decisions with rationale, and traceability from every `AC-*` and `T-*` item to a declared `REQ-*` primary requirement. Add `CTX-*` dependency/prerequisite/delegated-scope constraints only as supplemental context alongside the primary `REQ-*`, never as the only scope source. Each task must identify the relevant files/modules, exact intended behavior, dependencies between tasks, expected data/API changes, required tests, validation commands, and source-scope mapping.
23. Include a PR Size Budget section. Estimate additions plus deletions for each planned PR/repo using current code scope, likely test changes, schema/client generation, fixtures, migrations, and docs that must land with the behavior. Compare the largest estimated PR to the `Large PR changed-lines threshold` from the generated handoff packet. If the estimate exceeds the threshold, do not present the plan as ready for normal approval/execution; return oversized-plan evidence and recommend decomposition.
24. If the plan is oversized, propose a decomposition that preserves the full work-item scope while splitting it into child feature documents and child plans under the threshold. Identify which children can execute in parallel and which must wait for another child's PR to be ready or merged. Dependency rows must include `work_item_id`, `depends_on`, `condition`, and `reason`; use `after_pr_merged` for dependencies that rely on merged code, schema, protocol, or shared contract changes.
25. For nontrivial changes to existing code, schemas, control flow, data flow, runtime handoffs, or UI workflows, activate `$mermaid-visualizer` and include concise Mermaid flowcharts in the plan that illustrate the current code/schema/flow and the proposed change so the human reviewer can understand the plan visually. Diagrams are explanatory only; they must not replace required tasks, decisions, tests, or validation, and trivial/mechanical changes may state a concise non-applicability reason.
26. For nontrivial changes to existing code, include an Existing Code Grounding table. For each planned helper, schema, constant, permission check, status map, capability field, data derivation path, or shared validator, state: reuse, extend, or create; exact existing path inspected; selected source of truth; and why duplication is not introduced.
27. Include the required `Grounding Manifest` section from the plan template, as one fenced `json` block with `base`, `files`, `claims`, and `precedents`. Before writing it, run `git fetch origin` in each implementation worktree and pin the base branch and HEAD sha per repo in `base[]` (base-freshness parity with the linked-plan freshness rules). Every file path cited by any task or validation command must appear in `files[]` as `exists` (verified to exist at the base sha) or `created` (with the exact `task` key naming the owning task, e.g. `"task": "T-2.1"`). Every claim of the form "X currently imports/consumes/references Y" or "shared by A and B" must have a grep claim with `expected_paths`. Every removal sweep must have two claims: a baseline (`expectation: "matches"`, repo-wide scope, recording where the literal lives today) and the post-change check scope. Every test file cited in the Test Plan or a validation task must appear in `files[]`. The orchestrator verifies the manifest deterministically with `plan-grounding verify` before review lanes run; a missing, malformed, or failing manifest routes the plan back for revision.

   The manifest must also declare precedents and compile-feasibility and blast-radius claims:

   - `precedents`: an array of `{"feature": "<nearest analogue feature name>", "paths": ["<repo-relative path the analogue touches>"], "reason": "<why this feature is the nearest analogue>", "repo": "<optional repo the paths live in>"}`. Declare the existing feature(s) that already implement the nearest analogue of the work, with the exact paths that feature touches; verification confirms each path exists at the pinned sha. The optional `repo` field repo-scopes the cited paths: when present, each path must exist at THAT repo's pinned base (verification fails if the named repo is not one of the pinned bases), so a cross-repo plan cannot verify an analogue against the wrong repo. When `repo` is omitted and exactly one repo is pinned, that repo is used; when `repo` is omitted and multiple repos are pinned, verification fails closed and requires you to add `repo` to qualify which repo the analogue lives in. Declare `precedents: []` only when no analogue feature exists, and only with a sibling manifest field `precedents_none_reason` giving the repo-grounded reason. The precedent-conformance lane diffs the plan against these declarations.
   - `snippet` claims: for compile-feasibility and interface-citation evidence, add claims of the form `{"kind": "snippet", "path": "<repo-relative path>", "must_contain": "<exact literal that must appear in that file at the pinned sha>", "purpose": "interface_citation" | "config_allowlist" | "import_ban" | "other"}`. Verification confirms the file content at the pinned sha contains `must_contain` literally. Every existing interface the plan passes data through needs an `interface_citation` snippet claim pinning the field, type, or method signature the plan depends on. Every new external host or endpoint the plan adds needs a `config_allowlist` snippet claim pinning the existing allowlist or config the host must be registered in. Every touched package that carries a guardrail import ban needs an `import_ban` snippet claim pinning the banned import rule the plan must respect.
   - `consumer_inventory` claims: for every shared module the plan modifies, add a claim of the form `{"kind": "consumer_inventory", "path": "<repo-relative path of the modified module>", "annotated_consumers": ["<repo-relative path of each importer the plan accounts for>"]}`. Verification first confirms the cited module itself exists at the pinned sha and fails closed naming the path when it does not (otherwise importer discovery would find nothing and the inventory would pass for a module that is not in the repo). It then runs `git grep -l` for import/require references to the module at the pinned sha and fails when a discovered importer is missing from `annotated_consumers`, reporting the missing paths, so blast radius onto untouched consumers cannot slip through. Verification matches importers by the module's repo-relative path; an importer that references the module only through a path alias, a re-export barrel, or a runtime-resolved string is not auto-discovered and must be added to `annotated_consumers` by hand.
28. If a decision cannot be made from the work item, linked-document context, and repo context, put it in Open Questions or Gaps and treat it as a blocker instead of leaving it to the execution agent.
29. If `WORKFLOW_FEATURE_FLAG_REPO` is set and the work touches that repo, include a Feature Flag Applicability decision in the plan. A `${WORKFLOW_FEATURE_FLAG_PROVIDER}` flag is required only for rollout-sensitive features as defined below. Do not require a feature flag for every API, MCP, type, test, telemetry, refactor, or compatibility change.
30. Include an E2E/User-Flow Test Applicability decision when the work changes a user-visible workflow, critical integration path, browser/client flow, command flow, onboarding/launch/setup path, upload/download path, checkout/payment path, or multi-step API/client sequence. Use the definition below. Do not require new E2E infrastructure where none exists.
31. Include a Visual QA Plan decision when the work changes a rendered browser, Electron, desktop/client, or shared UI surface. Use the definition below. If shared UI is consumed by both browser/web and Electron/desktop surfaces, require both targets unless repo evidence proves one target does not consume the changed UI.
32. Include a Real Boundary Scenario Coverage decision when the work changes a multi-step materialization, projection, rendering, route/API response, persisted shape, migration, compatibility alias, async/background recovery path, optional relationship behavior, feature flag behavior, or other producer-to-consumer contract where isolated mocks could hide drift. Use the definition below. Do not require new test infrastructure where none exists.
33. Include a User-Visible State Matrix decision when the work changes user-visible state, status, lifecycle, readiness, progress, badge/label text, enabled/disabled capability, notification, error, stale/refresh behavior, or rendered output derived from multiple sources. Use the definition below.
34. Include a Manual Testing Debt Classification decision when the plan expects or preserves manual validation, live-provider checks, staging-only checks, reviewer-permission checks, webhook replay, real OAuth/user identity checks, unavailable upstream behavior, or any validation the worker might otherwise describe as manual testing. Use the definition below.
35. Include a Database/Migration Safety decision when the work changes persisted models, ORM schema, migration files, raw SQL, indexes, constraints, foreign keys, unique constraints, backfills, generated database clients/types, or data consumed by persisted projections. Use the definition below.
36. Before returning, evaluate whether planning or plan revision revealed stable, source-backed architecture patterns, repo relationships, contract ownership rules, runtime handoff paths, or validation conventions that are likely to help future goals. If yes, write short candidate notes under `${WORKFLOW_MEMORY_ROOT}/candidates/` using the format in `sections/lightweight-knowledge-capture.md`. If no, return `candidate_knowledge_notes: none` with a short reason. Do not write candidate notes for ordinary planning status, PRD-specific decisions, transient issues, unverified assumptions, or facts that should become repo-local `AGENTS.md` rules instead.

## Feature Flag Applicability

For this workflow, a feature in `WORKFLOW_FEATURE_FLAG_REPO` means a user/org/customer-visible capability or behavior change that should be releasable independently from deploy because it changes what users can do, what the system does by default, what gets enforced, or what cross-client behavior is active.

Require a `${WORKFLOW_FEATURE_FLAG_PROVIDER}` feature flag when a change in `WORKFLOW_FEATURE_FLAG_REPO` introduces or materially changes any of:

- a user-visible UI workflow, action, setting, capability, or default behavior
- a new endpoint, command, automation path, integration, or background behavior that users or external clients can actively trigger
- enforcement, blocking, permission, auth, security, quota, validation, or policy behavior that could reject or alter previously accepted user/client behavior
- a Desktop/client/server protocol behavior that needs staged rollout because older clients may coexist with newer server behavior
- a data migration, data exposure, expensive path, fanout, or background processing change where rollback or staged exposure matters

Do not require a feature flag solely for:

- bug fixes that restore intended behavior without introducing a new selectable capability or rollout-sensitive default
- refactors, code organization, type-only changes, tests, docs, comments, or internal helper extraction
- telemetry/logging/observability naming or payload changes that do not affect product behavior or expose new user data
- additive backward-compatible API/MCP/shared-type response fields that expose already-existing state as a projection for existing internal consumers and do not by themselves enable new behavior, change defaults, or alter enforcement
- compatibility shims or fallback handling whose purpose is to preserve existing behavior for old clients

When a flag is required, the plan may choose a concise kebab-case flag name, such as `command-signing`, when the work item does not specify one. The plan must state the flag name, where `WORKFLOW_FEATURE_FLAG_REPO` evaluates it, default-off/fallback behavior, compatibility behavior when the flag is off or missing, rollout notes, and tests for both enabled and disabled states.

When a flag is not required, the plan must include a concise repo-grounded non-applicability reason. If applicability is ambiguous because the change may alter user-visible behavior, enforcement, rollout risk, or client compatibility, treat it as a planning blocker or require a flag rather than silently omitting one.

## E2E/User-Flow Test Applicability

For this workflow, an E2E/User-Flow test means an existing repo-supported browser, smoke, integration-flow, user-flow, CLI-flow, or cross-service test that exercises a real user or client path through the system boundary. It does not mean inventing a new test framework, new browser harness, new service dependency, or broad test architecture.

When the work changes a user-visible workflow, critical integration path, browser/client flow, command flow, onboarding/launch/setup path, upload/download path, checkout/payment path, or multi-step API/client sequence, the plan must include an E2E/User-Flow Test Applicability decision with:

- whether existing E2E/user-flow infrastructure exists in the affected repo or relevant configured repo
- evidence inspected, including test directories, commands, fixtures, and nearby examples
- whether the changed behavior is already covered by an existing E2E/user-flow test
- whether an existing E2E/user-flow test must be updated
- whether a small new E2E/user-flow test fits an existing test file, fixture pattern, command, and CI path
- the exact test file or likely file location, command, fixture pattern, and assertion scope when a test is required
- whether any assertion claims a user-facing element is visible, onscreen, centered, scrolled into view, or inside the viewport; if so, the plan must require a visual viewport assertion using existing test tooling, such as screenshot evidence, screenshot diff, bounding box versus viewport bounds, intersection ratio, or another repo-approved visual check
- for UI layout, styling, or visual rendering changes, whether existing browser, screenshot, visual-regression, or component-render infrastructure can verify the actual rendered screen with realistic data; when applicable, require coverage for overlap/clipping, containment, anchoring, scroll position, responsive viewport behavior, realistic long/empty/error/loading content, and absence of debug/demo/test copy or temporary markers
- for user-visible state/status/lifecycle behavior, whether the test proves the initial page/load/output before user action, the refresh/retry/repair path, and the final rendered or consumer-visible state from realistic stale or mixed inputs
- a concise repo-grounded non-applicability reason when no E2E/user-flow test is required

If user-visible behavior depends on data appearing attached to a specific source location, such as a diff row, table row, file line, range, canvas node, map marker, calendar slot, timeline item, or transcript timestamp, the plan must state the anchor mapping before task execution: source data or event -> anchor identity -> projection/API field -> resolving component/renderer -> expected missing, stale, or ambiguous-anchor behavior -> test proving the item appears at the intended source location, not merely somewhere in the UI.

Require an E2E/user-flow test only when existing infrastructure and patterns are present and the changed behavior is best validated through the real user/client path rather than isolated unit tests. Prefer lower-level tests when the change is internal, non-user-visible, already covered at the real boundary, or when an E2E test would be brittle without increasing meaningful confidence.

Accessibility tree state, locator presence, DOM attachment, role lookup, or DOM-level visibility is not sufficient proof that a user-facing element is visually present in the viewport. Those checks may support accessibility or existence assertions, but a test that claims the user can see an element must verify the visual viewport state directly with existing repo tooling.

For UI layout, styling, or visual rendering changes, "the element exists" is not enough. The plan must require the highest practical rendered-screen validation supported by the repo, such as Playwright screenshots, screenshot diff tooling, bounding-box assertions, viewport snapshots, or existing component visual tests. The validation should prove the changed UI is usable and professional in realistic states, with no overlapping cards/controls/text, no clipped or unreadable content, no misplaced anchored content, no accidental debug/demo/test text, and no responsive viewport breakage. If existing tooling cannot cover that visual risk, classify the remaining check as manual testing debt with the highest practical automated substitute.

If no existing E2E/user-flow infrastructure or pattern exists, state that explicitly and do not ask the execution agent to create one. If the correct test level is ambiguous and repo context cannot resolve it, mark it as an Open Question or Gap blocker instead of leaving it to execution.

## Visual QA Plan

For this workflow, a Visual QA Plan is required when the work changes rendered
browser UI, Electron UI, desktop/client UI, shared UI components, visual layout,
styling, copy placement, responsive behavior, anchored/positional rendering, or a
user-facing state that must be inspected in the final application.

When required, the plan must include:

- target surfaces: `browser`, `electron`, `both`, or `none`
- repo evidence used to decide target scope, including whether shared UI is
  consumed by browser/web, Electron/desktop, or both
- requirements source for the QA worker: `visual-requirements.md` if the plan
  creates or expects one, otherwise the plan's Visual QA Plan/Test
  Plan/Acceptance Criteria
- exact flows, screens, dialogs, panels, states, and viewport sizes to validate
- auth, launch, seed, database, fixture, or bootstrap instructions the QA worker
  should use, with repo-local docs or workflow-memory entries named when known
- expected visual outcomes, including realistic content states and failure modes
  such as overlap, clipping, unreadable text, incorrect anchoring, broken scroll
  position, debug/demo/test copy, and responsive breakage
- which outcomes are confirmed by automated tests and which remain for the
  best-effort visual QA worker, keeping the outcome that proves the primary
  changed behavior assigned to the visual QA worker rather than delegated to
  unit tests alone
- a concise repo-grounded non-applicability reason when no rendered browser or
  Electron surface is affected

### Differential coverage for filter, count, and ownership behavior

When the changed behavior is a filter, count, exclusion, ownership, selection, or
precedence behavior (for example, selecting a user shows only that user's rows and
totals while excluding other users and null-owner rows, or `userIds` takes
precedence over `userId`), a single-state render is not acceptable visual
coverage. A screenshot of one unfiltered state cannot exhibit the bug, so the
Visual QA Plan must require a differential scenario:

- an ownership-aware fixture matrix that can actually exhibit the bug: at least
  three distinct owners (user A with at least two owned rows, user B with at least
  one owned row, and at least one other owner whose rows are noise), at least one
  null-owner/unowned row, and a missing-user query that must return zero
- an explicit action that changes the selection or filter, such as selecting
  owner A, then switching to owner B, then querying a user with no rows
- concrete assertions, not screenshots alone: the visible count equals the number
  of visible rows; the selected view excludes every other-owner and null-owner
  row; switching the selection changes the URL/filter, the displayed count, and
  the rows together; and the outgoing requests carry the expected `userId`/
  `userIds` filter parameters
- the exact seed/fixture mechanism the worker should use to build that state
  (a named repo-local doc, harness flag, or workflow-memory entry), since the
  worker may not read implementation source to discover it

"Render N seeded rows" is explicitly insufficient for a filter or count change.
The outcome that proves the filter/count behavior must be assigned to the visual
QA worker and may not be silently delegated to unit tests.

For shared UI consumed by both web and desktop/Electron surfaces, default to
`both`. The plan may narrow to one target only when repo-grounded import,
ownership, routing, or packaging evidence proves the other target cannot render
the changed surface. Do not leave target selection to the visual QA worker, and
do not ask the worker to inspect implementation source code to discover what to
test.

If the work needs a separate `visual-requirements.md`, the planner must add a
task to create or update it before implementation completes. If a separate file
is not needed, the Visual QA Plan section itself is the requirements source the
visual QA worker will use. If no rendered browser or Electron surface is
affected, the planner must still keep this section, set target surfaces to
`none`, and write an explicit `N/A` requirements source plus the repo-grounded
non-applicability reason.

## Real Boundary Scenario Coverage

For this workflow, a real-boundary scenario test is an existing repo-supported test, smoke test, integration-flow test, route test, CLI/client test, browser test, or bounded test chain that exercises the real producer-to-consumer contract instead of mocking every layer that could drift. It should use the highest existing practical boundary for the affected behavior, but it must not invent a new framework, new service dependency, broad test architecture, or brittle end-to-end harness when the repo has no supporting pattern.

When work changes a multi-step materialization, projection, rendering, route/API response, persisted shape, migration, compatibility alias, async/background recovery path, optional relationship behavior, feature flag behavior, or other producer-to-consumer contract, the plan must include a Real Boundary Scenario Coverage decision with:

- the producer/input, storage or materialization step, route/projection/API/tool/client boundary, and final consumer or renderer affected
- for automatic materialization from external observations, the primary routing identifier, deterministic fallback ownership keys, behavior for no match, multiple matches, stale matches, nullable ownership, and whether unowned or partially owned resources are skipped, materialized with limited ownership, quarantined or pending, or blocked for human input
- whether isolated unit/component tests are sufficient, with repo-grounded reasoning
- whether existing integration, route, smoke, browser, CLI-flow, migration, or scenario-test infrastructure exists
- the highest existing practical boundary that should be tested
- the exact test file or likely file location, fixture or seed pattern, command, and assertion scope when a real-boundary scenario test is required
- a concise repo-grounded non-applicability reason when a real-boundary scenario test is not required

Require at least one real-boundary scenario test or bounded test chain when existing infrastructure exists and isolated mocked tests could pass while the real producer-to-consumer contract is broken. A bounded test chain is acceptable when one test cannot reasonably cross every boundary, but the chain must still prove the real contract handoff. Do not replace the contract being validated with mocks.

Apply these scenario triggers when relevant:

- Materialization, projection, or rendering pipeline: prove the real input or event creates/materializes the expected persisted state, the production route/projection/API/tool returns the expected shape, and the consumer renders or uses that shape correctly.
- Anchored or positional UI rendering: prove the source data carries enough anchor identity for the production projection and renderer to attach the item to the intended source location, and prove missing, stale, or ambiguous anchors follow the approved fallback behavior.
- Externally observed resource materialization: prove events with and without the primary routing identifier follow the approved ownership-resolution path, including no-match, ambiguous-match, stale-match, and nullable-ownership cases when those states are possible.
- Migration consumed by routes or projections: seed realistic pre-migration or legacy data, run the repo-supported migration or migration harness when available, then hit the actual route/projection/service path that production uses. If no migration harness exists, state that with evidence and require the next-best route/projection validation against realistic migrated data.
- Deprecated alias or compatibility input: prove legacy input or alias behavior flows into the new canonical storage/output and remains visible through downstream canonical consumers.
- Async, background, cache, retry, or recovery path: inject or simulate the failure, verify the recorded failure/stale/partial state, invoke the sync/retry/recovery path, and verify recovered state or response.
- Optional child, nullable relationship, or missing related data: prove the real boundary returns the intended null/empty/default shape and does not throw, serialize incorrectly, or force consumers to mock impossible data.
- Feature flag behavior: use the same persisted fixture or scenario data through flag-off and flag-on paths at the highest existing practical boundary, not only mocked component-level flag values, and verify both behaviors.
- User-visible state/status/lifecycle behavior: prove the real or highest-practical producer/storage/projection path creates the state combinations in the User-Visible State Matrix, then prove the production route/client/renderer/consumer exposes the intended output before and after refresh, retry, repair, or manual sync as applicable.

If the correct boundary level is ambiguous and repo context cannot resolve it, mark it as an Open Question or Gap blocker instead of leaving the decision to execution.

## User-Visible State Matrix

For this workflow, a User-Visible State Matrix is required when behavior visible to a user, operator, CLI/client, reviewer, or downstream consumer is derived from multiple sources, phases, flags, cached values, persisted projections, background jobs, external providers, or async refresh/retry paths.

When required, the plan must include a matrix with:

- source or producer states, including external/provider states when applicable
- persisted, materialized, cached, or projected states
- client/query/loading/refetch/retry/recovery states
- derived flags, secondary fields, compatibility fields, and their precedence when values conflict or are stale
- initial-load behavior before the user clicks, refreshes, syncs, retries, or otherwise triggers repair
- background repair, automatic refresh, manual refresh/sync, and failure/stale/partial-state behavior
- final user-visible rendering or consumer-visible output for each meaningful state combination
- exact tests at the highest existing practical boundary, including cases where stale or mixed fields could contradict each other
- whether tests exercise the actual rendering/consumer component or route rather than a mock that hides the final user-visible state

For any state machine or lifecycle where some states are terminal, absorbing, source-of-truth, or higher priority than convenience flags, the plan must state a generic precedence rule and tests for stale or mixed combinations. Do not hardcode this to a particular domain; apply it to any workflow where one field or phase should dominate another when they disagree.

If existing infrastructure cannot cover the full matrix, the plan must state the highest practical automated substitute and classify any remaining manual validation under Manual Testing Debt. If the correct state matrix or precedence rule cannot be determined from the work item and repo context, mark it as an Open Question or Gap blocker instead of leaving it to execution.

## Manual Testing Debt Classification

For this workflow, manual testing debt means any behavior that remains dependent on a human running a live or semi-live scenario after the implementation worker says execution is complete.

Manual testing debt must be classified as one of:

- `none`: no manual validation remains.
- `automated`: the originally manual concern is covered by existing or newly added automated validation, with command evidence.
- `justified`: manual validation remains, but current repo infrastructure cannot automate it; the plan names why and runs the highest practical automated substitute.
- `blocked_external`: validation requires concrete external state, such as real credentials, provider delivery replay, staging-only data, reviewer permissions, unavailable upstream routes, or third-party system behavior.
- `unresolved`: the manual check is not acceptable for execution completion or PR readiness.

When a plan mentions manual testing, manual verification, live checks, provider-bound checks, staging checks, webhook replay, real user identity, or any equivalent language, the plan must first try to convert the check into existing E2E/user-flow, real-boundary, route, integration, smoke, CLI-flow, browser, or component-test coverage. Manual validation may remain only when existing repo-supported automation cannot cover the behavior or when a concrete external blocker exists.

For every manual testing debt item, the plan must state the behavior, classification, reason, highest practical automated substitute, exact validation command when a substitute exists, and whether it blocks execution, finalization, or PR-ready status. Vague statements such as "manual verification still needed" are `unresolved` unless classified with evidence.

Manual validation cannot replace required E2E/user-flow or real-boundary coverage when existing infrastructure can test the behavior. If the correct classification cannot be determined from the work item and repo context, mark it as an Open Question or Gap blocker instead of leaving it to execution.

## Database/Migration Safety

For this workflow, database/migration-sensitive work means any change to persisted models, ORM schema, migration files, raw SQL, indexes, constraints, foreign keys, unique constraints, generated database clients/types, backfills, seed data that production code depends on, or persisted data consumed by routes, projections, tools, clients, renderers, or jobs.

When work is database/migration-sensitive, the plan must include a Database/Migration Safety decision with:

- schema owner and migration owner
- exact ORM/schema files, migration files, generated clients/types, raw SQL files, and persisted models touched
- whether migration SQL is generated, hand-authored, or edited after generation
- if any SQL is hand-authored or edited after generation, the repo-grounded reason and exact invariants that must be preserved
- every table, column, index, unique constraint, foreign key, default, enum, trigger, extension, and generated client/type affected
- ORM expected names for indexes, unique constraints, and foreign keys, including whether names are implicit, mapped, or explicitly named in schema
- how the migration-produced database is proven to match the ORM schema, not only that migrations apply
- repo-supported drift validation command, such as an ORM shadow-database drift check when the repo uses an ORM that supports one
- deploy-style migration validation command, if applicable
- statement that deploy-style validation alone is insufficient for ORM-managed schemas because it may not detect ORM schema or constraint-name drift
- rollback, backfill, idempotency, pre-existing-data checks, and destructive-change boundaries
- realistic post-migration route/projection/client validation when persisted data is consumed downstream
- exact validation commands the execution worker must run, including database setup prerequisites when known

For Prisma-style repositories, the plan must require the repo-supported equivalent of `prisma migrate dev` or another shadow-database drift check in addition to migration application/deploy validation when migrations or `schema.prisma` change. The wording should stay repo-generic, but the validation must catch cases where applied migration SQL works while constraint, index, relation, or generated-schema metadata drifts from ORM expectations.

Do not allow "run migrate deploy" or equivalent apply-only validation as the sole database validation for ORM-managed schemas. If the repo has no safe local shadow/drift validation path, list that as an Open Question or Gap blocker or require explicit human acceptance before execution.

### Storage Source-Of-Truth Changes

When a change moves persisted data between tables/models/services or changes the canonical read/write owner while preserving the same user-facing behavior, treat it as a storage source-of-truth migration, not automatically as a user/org feature rollout.

The plan must state the current source of truth, future source of truth, read path, write path, cutover/backfill strategy, rollback behavior, and cleanup point for old storage paths.

Feature flags or org-level toggles must not create two writable sources of truth unless the work item explicitly requires staged per-org rollout and the plan proves idempotency, reconciliation, divergence detection, observability, rollback, and bounded removal. Shadow writes are allowed only when one canonical read source remains clear and divergence cannot affect user-visible behavior.

### Cutover, Backfill, And Compatibility Matrix

For any migration, projection cutover, compatibility backfill, source-of-truth move, old-path/new-path coexistence, or batch repair that changes where existing behavior reads from or writes to, the plan must include a Cutover, Backfill, And Compatibility Matrix before the task list.

The matrix must state:

- current path, new path, coexistence window, canonical owner during each phase, rollback behavior, and cleanup criteria
- scoped backfill or repair eligibility, including which existing records are included, excluded, orphaned, stale, deleted, tombstoned, ambiguous, written by legacy producers, already processed by new producers, or mixed across producer versions
- pagination, batching, cursor, limit, retry, resume, and complete-iteration proof for every batch or fanout path
- duplicate delivery, repeated execution, retry-loop, idempotency, and dead-letter or terminal-failure behavior
- ambiguous-match, multi-match, missing-match, stale-context, and soft-delete/tombstone semantics
- compatibility behavior for older producers, older consumers, partially migrated data, and mixed-version operation
- repo-supported guardrail coverage for duplicated cutover logic, hardcoded contract literals, unsafe type assertions, unchecked raw values, and bypassed shared helpers; if automation is not practical, the plan must name the narrowest reviewer check or documentation rule
- executable tests, source checks, or validation commands proving old/new path agreement, backfill correctness, complete iteration, retry/idempotency behavior, tombstone handling, ambiguous-match handling, and compatibility with partially migrated data

If the cutover owner, backfill scope, retry behavior, or ambiguous/deleted-record semantics cannot be determined from work-item and repo context, list the ambiguity as an Open Question or Gap blocker instead of letting execution infer it.

## Required Contract Resolution

For every cross-repo, file-based, schema-based, package-based, prompt/skill-based, or runtime-materialized contract, the planning subagent must trace the full producer-to-consumer path before writing the plan. Do not describe the intended architecture only; prove the actual current runtime handoff and state exactly what must change.

### Contract Ownership Decision

For any plan that creates or changes public API, MCP, GraphQL, webhook, gateway, wire, shared type, generated client, persisted model, route response, response field, domain relationship, lineage metadata, or cross-module projection, the plan must include a Contract Ownership Decision in `Architecture Fit` before the task list.

The Contract Ownership Decision must state:

- domain concept being exposed
- canonical source of truth for that concept
- current owning route, service, module, table/model, or package
- proposed exposed surface
- why the proposed surface owns the concept or is allowed to expose a projection of it
- whether each field is source-of-truth, projection, convenience, compatibility shim, or temporary migration field
- consumers that need the field or behavior
- consumers intentionally not exposed to the field or behavior, with reasoning
- rejected alternatives, including the current owner surface if it is not selected
- compatibility and migration behavior
- executable validation proving the selected ownership and consumer path

If the canonical source of truth belongs to another domain model, route, service, module, or table, the plan must prefer exposing the behavior through that owner or through an explicitly named projection/helper owned by that domain. Do not add fields to a convenient but non-owning API surface merely because the consumer already calls it. If the plan intentionally exposes a projection on a non-owning surface, it must say why that projection belongs there, how it stays consistent with the owner, and which tests prove it does not duplicate or muddy the domain model.

Placing a constant, type, or schema in a shared package requires at least two verified current consumers from different surfaces, cited as Grounding Manifest grep claims with `expected_paths`, or an explicit plan task that creates the second consumer. Otherwise the narrowest owning module wins. Do not claim "shared by A and B" ownership from intent or expectation; the manifest claims must prove the consumers exist today or a task must create them.

If the correct owner cannot be determined from the work item and repo context, list the ownership ambiguity as an Open Question or Gap blocker instead of choosing a surface for the execution agent.

When applicable, the plan must include these details in `Architecture Fit`, the task list, or both:

### Exposure Surface Parity Matrix

For any plan that exposes new or changed related data, metadata, derived fields, or projections through an API, route, tool, UI/client payload, shared type, report, telemetry/log stream, or persisted projection, the plan must include an Exposure Surface Parity Matrix before the task list.

The matrix must state:

- every equivalent read surface, retrieval path, caller class, and consumer that should receive the data
- consumers or caller classes intentionally not exposed to the data, with repo-grounded reasoning
- serialized shape for each surface, including required, optional, omitted, null, empty, default, date/time, enum/status, and compatibility behavior
- telemetry, log, metric, and privacy scope, including which caller classes may emit or observe the data
- runtime validation boundary for any raw, external, persisted, or loosely typed value before it is cast, serialized, logged, or exposed
- test fixture, builder, seed, factory, or override paths that must produce realistic data for each supported shape
- executable tests or source checks proving included surfaces expose the data consistently and excluded surfaces remain excluded

Tests must assert the behavior or contract visible to consumers rather than relying on incidental logs unless the log, metric, or trace is itself the product contract. If the correct surface set, telemetry scope, or serialized shape cannot be determined from the work item and repo context, list it as an Open Question or Gap blocker instead of leaving it to execution.

### Mutation Contract Matrix

For any plan that adds or changes a mutation action, command, handler, write endpoint, workflow operation, inline action, or state-changing tool, the plan must include a Mutation Contract Matrix before the task list.

The matrix must state:

- existing callers, new callers, producer/write sources, and caller compatibility expectations
- previous response shape, new response shape, status codes, success envelope, failure envelope, and error classification
- write target, validation target, authorization or ownership target, and identifier matching rules
- read-after-write surfaces that must observe each successful mutation, including projections, caches, clients, downstream tools, and background refresh paths
- acknowledgement/result mapping for each operation outcome, including created, updated, skipped, duplicate/no-op, partial success, partial failure, and terminal failure
- idempotency, duplicate request, retry, conflict, no-op, already-applied, and concurrent update behavior
- rollback, partial-apply, or compensation behavior when a mutation has multiple write steps
- structured input boundary cases, including positional, range, nested, multiline, encoded, nullable, missing, malformed, stale, ambiguous, or out-of-scope targets
- executable tests or source checks proving existing caller compatibility, failure-envelope semantics, read-after-write visibility, idempotency behavior, and structured input validation

If response compatibility, failure semantics, read-after-write visibility, or target validation cannot be determined from work-item and repo context, list it as an Open Question or Gap blocker instead of leaving it to execution.

### External Observation Ownership Resolution

For any plan that automatically creates, materializes, links, claims, or stores a resource from an external observation or background event, and the event may lack the normal user-selected, work-item, route, or owner identifier, the plan must include an ownership-resolution matrix before the task list.

The ownership-resolution matrix must state:

- the primary routing identifier and how the implementation knows it is present
- deterministic fallback keys inspected, in priority order, and why each key is safe ownership evidence
- behavior for no match, multiple matches, stale matches, nullable ownership fields, and partially known ownership
- whether unowned or partially owned resources are skipped, materialized with limited ownership, quarantined or pending, or blocked for human input
- persistence, API, projection, and consumer-visible behavior for each ownership outcome
- validation proving the selected ownership outcomes at the highest existing practical boundary

If safe ownership cannot be determined from the work item and repo context, list the ambiguity as an Open Question or Gap blocker instead of letting execution invent fallback behavior.

### Stateful Resource Compatibility Matrix

For any plan that creates, promotes, canonicalizes, or materially changes a first-class resource, lifecycle object, durable state record, or externally refreshed entity, the plan must include a Stateful Resource Compatibility Matrix before the task list.

The matrix must state:

- required identifiers, ownership keys, reference/link fields, and query/filter fields that every later read, diff, refresh, update, and consumer path needs
- every read surface, projection, route, tool, client, background job, or downstream consumer that loads the resource
- every existing and new producer/write source that can create or update the resource, including write, refresh, import, sync, event, replay, retry, backfill, migration, repair, and batch paths
- which incoming fields are authoritative, partial, nullable, stale, or convenience-only for each write/update source
- authoritative owner or shared idempotency strategy when multiple producers can write the same logical resource
- acknowledgement/result mapping for each write/update source, including how created, updated, skipped, duplicate/no-op, partial success, partial failure, and terminal failure outcomes reach callers and downstream consumers
- state-preservation rules when an update source lacks data that already exists in durable state
- behavior for partial external failures, incomplete payloads, duplicate events, stale events, and out-of-order updates
- nullable, missing, pre-existing, already-processed, or compatibility-window states during migrations, backfills, delayed generation, or mixed-version operation
- executable tests or source checks proving required identity propagation, read/write alignment, authoritative-owner or idempotency behavior, acknowledgement/result mapping, state preservation, null-state handling, existing-data cutover behavior, and consumer-visible compatibility

If the resource's required identity, source-of-truth ordering, acknowledgement/result mapping, existing-data cutover behavior, or preservation rules cannot be determined from work-item and repo context, list the ambiguity as an Open Question or Gap blocker instead of letting execution infer it.

### Multi-Step Failure-Mode Matrix

For any multi-step sync, refresh, import, reconciliation, repair, batch update, background job, external-provider fanout, or workflow operation where one sub-operation can fail independently from another, the plan must include a Multi-Step Failure-Mode Matrix before the task list.

The matrix must state:

- each sub-operation, its input source, output, side effects, and whether it gates any other sub-operation
- throttle, rate-limit, cache, lock, quota, retry, timeout, and circuit-breaker scope for each sub-operation
- behavior when each sub-operation succeeds, is skipped, is throttled, returns stale data, partially fails, fully fails, or times out
- whether independent sub-operations should continue after a local failure, and what evidence proves they did
- response, status, event, telemetry, persisted state, or user-visible output for partial success, degraded success, total failure, no-op, and skipped work
- retry, resume, compensation, cleanup, and dead-letter behavior for recoverable and terminal failures
- dead, unreachable, impossible, or redundant branches and result fields the implementation must remove or justify
- executable tests or validation proving partial success, total failure, throttled work, independent continuation, degraded responses, and absence of dead or unreachable branches

If independence boundaries, throttle scope, or degraded-success response semantics cannot be determined from work-item and repo context, list the ambiguity as an Open Question or Gap blocker instead of letting execution infer it.

### Runtime Path Matrix

For every generated, copied, uploaded, downloaded, or runtime-materialized file that another process or agent must read, include:

- producer
- write location
- transport or handoff mechanism
- actual process cwd, `--workdir`, run directory, repo directory, or container path
- reader or consumer
- expected read location
- fallback or compatibility path, if any
- test or fixture proving the real runtime path works

If two systems use different directories, such as repo checkout path versus run directory, the plan must explicitly define the copy, symlink, argument, discovery, or fallback behavior that connects them.

### Shared Package And Version Matrix

For every shared type, schema, generated client, package, protocol library, or published dependency crossing repo boundaries, include:

- package or schema owner
- consuming repo or repos
- whether each consumer uses workspace source, generated code, vendored code, or a published package version
- exact package, version, lockfile, generation, or local-extension strategy
- compatibility behavior for older producers and consumers
- validation commands that prove the selected strategy works

Do not leave package or schema handoff as "if needed", "where appropriate", or a future executor decision when repo inspection can determine the answer.

### Consumer Inventory

For every changed contract, inventory all consumers, including:

- code call sites
- tests and fixtures
- route handlers and clients
- scripts and CLIs
- markdown agent prompts
- skill files
- schemas
- docs that act as runtime instructions

Every consumer must either be updated by a plan task or explicitly marked unaffected with repo-grounded evidence.

### Descriptor Or Envelope Taxonomy

For every new or changed structured artifact, request envelope, response envelope, descriptor list, status payload, or validation schema, define:

- exact IDs and names
- required and optional fields
- ordering rules
- collision behavior
- fallback behavior
- naming compatibility with existing reason strings, status codes, telemetry keys, and acceptance criteria
- representative examples for each supported mode

If the schema permits broad strings or loose objects, the plan must still define the concrete taxonomy the implementation will produce and validate.

### Executable Contract Validation

Documentation-only examples are not sufficient for behavior or contract changes. The plan must include executable tests, fixtures, source checks, or validation scripts that would fail if:

- producers write the wrong shape or path
- runtime handoff paths are wrong
- consumers keep reading the legacy source instead of the new contract
- descriptor ordering, IDs, or source-of-truth lists drift
- package versions, generated clients, or lockfiles are inconsistent
- compatibility behavior for older producers or consumers breaks

### No Deferred Architecture Decisions

Conditional language such as "if needed", "where appropriate", "executor should decide", "implementation may choose", or equivalent wording is not allowed for package strategy, runtime paths, schema shape, file ownership, compatibility, validation, or test coverage when repo context can resolve the answer. If repo context cannot resolve it, the uncertainty must be listed as an Open Question or Gap blocker.

## Required Repo Impact Matrix

The plan must include a repo impact matrix in the `Architecture Fit` section:

| Repo | In Scope? | Evidence Inspected | Affected Contracts/Call Sites | Compatibility/Version-Skew Risks | Required Changes Or Reason No Change Is Needed |
|------|-----------|--------------------|--------------------------------|-----------------------------------|------------------------------------------------|
| `<repo name inferred from WORKFLOW_REPO_MAP path>` | TBD | TBD | TBD | TBD | TBD |

## Planner Self-Check (run before returning)

Before the terminal planning status event, run the deterministic planner preflight on your draft and fix any HARD failures it reports, so predictable issues are corrected now instead of costing a post-handoff plan-review/revision round:

`{{WORKFLOW_CLI}} planning preflight --goal-slug <slug> --work-item-id <id> --plan-file <returned draft plan path>`

It checks five things on the actual draft and prints a structured result:

- Required plan sections: every required plan-template section must be present. A missing section is a HARD failure; add it.
- Source Scope Resolution: primary requirements, linked/prerequisite document role classifications, scope decisions, and AC/task traceability must be present. Every AC/task must map to a primary `REQ-*`; `CTX-*` constraints may supplement but not replace primary scope. Missing, placeholder, unclassified, CTX-only, or unmapped source-scope evidence is a HARD failure; fix it before handoff.
- Runtime Investigation: the `## Runtime Investigation` section must declare `Applicability: required` or `Applicability: not_applicable`. Required investigations must fill the labeled evidence fields, and `not_applicable` must include a concrete reason. Runtime-investigation failures are HARD failures; fix them.
- Grounding Manifest: the SAME deterministic `plan-grounding verify` the orchestrator runs after handoff. Any citation/claim failure is a HARD failure; fix the manifest (re-pin origin-fetched base shas, correct cited files/claims) until it verifies. Base-evidence drift is reported but NON-FATAL: it is reconciled post-handoff via `repo_base_refresh`, not by revising the plan.
- Advisory package-version impact: a record-only prediction of which publishable packages your declared `files[]` will touch. It NEVER fails preflight; when it warns, note the likely version bump in the plan so the diff-based guard at finalization is not a surprise.

Preflight exits nonzero while any HARD failure remains. Do not hand off a plan whose preflight still fails its hard checks. Preflight does not replace the orchestrator's post-handoff verification or the diff-based version guard at finalization; it surfaces the same deterministic checks earlier so you self-correct.

## Planning Agent Return

Return to the orchestrator:

- work-item ID/slug
- work-item type
- work-item URL
- draft plan content or local draft path
- intake route: `create_plan`
- canonical source slug
- worktree path or paths
- branch name or names
- implementation repo or repos
- blockers/open questions
- `lane_applicability`: per-specialty-lane review applicability declarations for the planner-declarable lanes `e2e-user-flow`, and `real-boundary-coverage`. Each entry has `lane_id`, `decision` (`applicable` or `not_applicable`), and a repo-grounded `reason`. Declare `not_applicable` only with concrete repo/work-item evidence; the runner may skip a declared lane on the first full plan review only, records the skip as `not_applicable` lane evidence with your reason, and treats a missing declaration as the lane running (fail closed). The `security-abuse` lane is not planner-declarable: it always runs on a first full plan review, only the lane itself may return `not_applicable`, and the planning ingest CLI ignores a `not_applicable` declaration for it with a warning. The `precedent-conformance` lane is likewise not planner-declarable and its `not_applicable` declaration is ignored with the same warning; the lane runs independently because planners are blind to the analogues they missed, and only the lane itself may return `not_applicable` when the manifest declares `precedents: []` with a `precedents_none_reason` it independently confirms. The `database-migration-safety` lane is also not planner-declarable: it always runs on a first full plan review, only the lane itself may return `not_applicable`, and a `not_applicable` declaration for it is ignored with the same warning, because a wrong "no migration needed" skip can hide a data-safety gap until late revisions. Include these declarations in the terminal planning status event using snake_case keys.
- grounding summary: confirmation the plan contains the required `Grounding Manifest` section with origin-fetched base branch/sha pins per repo, plus counts of `files[]` and `claims[]` entries (including `snippet` and `consumer_inventory` claims), the `precedents[]` declarations or the `precedents_none_reason`, and any grounding blockers
- the Grounding Manifest itself, inside the returned draft plan content or local draft path, so the orchestrator can run `plan-grounding verify` against the returned draft before review lanes launch
- PR Size Budget summary and a machine-readable `pr_size_estimate` object with `status`, `threshold_changed_lines`, `estimated_changed_lines` or `line_items`, `max_estimated_pr_changed_lines`, `requires_decomposition`, and `summary`
- if oversized, a decomposition recommendation with child scopes, estimated changed lines, and dependency ordering; do not ask for normal plan approval until the orchestrator records the user's split/execute-as-is decision
- candidate_knowledge_notes with paths and summaries, or `candidate_knowledge_notes: none` with a short reason

The Principal Design Synthesis, cross-repo impact, contract ownership, E2E/user-flow applicability, and real-boundary coverage analyses belong in the plan document sections, where review lanes read them; do not duplicate them as narrative summaries in the return packet.
