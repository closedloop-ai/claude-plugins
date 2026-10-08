---
name: cl-work-report
description: Produce a private, read-only HTML report of all ClosedLoop work assigned to the authenticated user in one project, grouped into evidence-backed page or capability feature units with verified dependencies and minimal reassignment recommendations. Use for project work inventories, feature-unit reports, blocker ownership, or reassignment advice; do not use it to execute, reassign, or update tickets.
---

# ClosedLoop Work Report

## Purpose

Build a current, complete inventory of the requesting user's assigned work in one ClosedLoop project. Group it into concrete page or capability features with bounded user journeys and acceptance outcomes, using PRDs and plans as supporting evidence rather than grouping boundaries. Trace upstream dependencies and recommend ownership changes only when live evidence shows transfer is better than coordination.

The report is private. Create a local HTML report by default and return its link with a concise response summary. Use Markdown only when the user explicitly requests plain text or HTML rendering is unavailable; disclose that limitation and never claim a diagram rendered when it did not.

## Boundaries

- This skill is read-only. Never reassign tickets, update statuses or relationships, post comments, send messages, create loops or goals, acquire leases, launch workers, implement work, or change PRs.
- Read `../cl-policy/SKILL.md` for ClosedLoop access and fallback rules. A private report does not require configured Product or engineering contact names and must not stop merely because communication policy is unavailable.
- Load `closedloop-intel` by name (`$closedloop-intel` in Codex or `/closedloop-core:closedloop-intel` in Claude Code). Discover the read-only `closedloop-graph` server by capability, call its `get_routing_protocol` first, and follow the live route and evidence rules it returns. Never hardcode an MCP server prefix.
- Graph results are discovery evidence. Live ClosedLoop is authoritative for the current user, project, assignment, status, and relationship direction.
- A document whose type is `FEATURE` may be an ordinary ticket. Do not assume its type makes it a product-feature parent or execution-unit boundary.
- Keep the complete product-feature or PRD universe separate from the user's selected delivery units. A selected delivery unit is the narrowest evidence-backed, independently functional outcome containing one or more of the user's assigned tickets. Its required shipping changes land in one PR. Shared prerequisites may remain externally owned and land first; design evidence need not enter the PR. Explicitly post-rollout cleanup remains mandatory follow-up work and must not be forced into a pre-rollout PR. Do not turn every sibling under a broad feature or PRD into the user's execution scope.

## Establish scope

1. Resolve the authenticated ClosedLoop user live and record their stable id and display name.
2. Resolve exactly one project live and record its stable id and canonical name. If the request is ambiguous, ask one concise project question and stop.
3. Inspect the current document/work-item, status, and priority schema exposed by the live tools. Enumerate every canonical ticket or work-item type supported for that project; the current listing contract may expose `ISSUE` and `FEATURE` as aliases. When the live schema documents alias equivalence, record it, query the canonical type once, and deduplicate rather than repeating identical pagination. Do not assume only `FEATURE` records exist when the schema does not establish that.
4. Fetch the complete live project ticket universe once for every canonical supported type with the project filter and no assignee or status filter. This live universe is the authoritative metadata snapshot.
5. Partition that snapshot in memory and derive counts and assigned seeds from it. Seed the report from items assigned to the authenticated user whose status is nonterminal; current examples include `TRIAGE`, `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, and `BLOCKED`. Preserve unfamiliar or unclassified statuses as `UNKNOWN_DISPOSITION` instead of dropping them. Tickets tagged for a repo skill (see the repo-skill routing table in `../cl-sweep/references/queue-and-batching.md`, for example `feature-map` for `feature-map-refresh`) are never proposed as feature-unit members; list them under `Handled by a repo skill` with the skill name.
6. Use targeted routed graph lineage and dependency queries, then live links and relevant document content, to understand the concrete page/capability boundaries, prerequisites, blockers, and sibling ownership around those seeds. This context does not automatically become the user's proposed delivery scope. Inspect bodies only for relevant boundaries, ambiguous membership, and material dependencies.
7. Include terminal status counts and enough context to explain dependency disposition. List historical terminal work only when the user asks or when it is necessary to explain an active feature unit or dependency. Do not dump unrelated project feature groups into the report.

If the only available source can enumerate `FEATURE` records, state that the report has FEATURE-only coverage. Never label that result as all project work unless the live schema confirms FEATURE is the project's only ticket/work-item type.

## Complete pagination and reconciliation

- Prefer the live ClosedLoop cursor or `hasMore`/`nextOffset` contract as the authority for completeness. Fully page each canonical supported ticket/work-item type with the project filter and no assignee or status filter until `hasMore` is false, advancing by the returned cursor or `nextOffset`. Do not run duplicate page walks for documented type aliases. Fully page user lookups and every relationship listing used for membership or dependency claims as well.
- When the routed graph query is the available discovery path, use deterministic ordering with a stable unique tie-breaker. Honor every `total_rows`, row-count, and `truncated` signal. Advance by the actual number of rows returned, not the requested limit, and continue until the protocol proves the result complete.
- Deduplicate by stable document id across pages and sources. Treat a duplicate slug with different stable ids as a data issue rather than merging the records.
- Record graph and live query timestamps, source freshness, page/row totals, and any truncation or access failure. Track project-universe completeness separately from the count and coverage of the authenticated user's assignments.
- Reuse the complete live list response as the authoritative item snapshot when it already carries the required current fields. Fetch individual documents only for missing material fields or facts that changed during the report. Live-fetch every material blocker and the relationship or acceptance evidence that establishes its direction; a stale graph record never establishes current assignment, status, or blocking.
- If project-wide pagination, schema discovery, live verification, or relationship verification is incomplete, mark the report `PARTIAL`, describe the missing range or fields, and avoid claims that depend on them. An index-only result is never complete project-universe coverage.

## Retrieval budget

- When the live list schema supports it, set `includeParentArtifact: false` for broad project pages. After scope is known, fetch complete parent, link, and content evidence for every relevant or ambiguous feature boundary. Never omit semantic evidence merely to reduce payload.
- Fetch the full paginated live universe once per report. Derive counts, priorities, and the user's assigned seeds from that snapshot; do not repeat whole-project list walks or duplicate them with broad graph SQL aggregates.
- Keep in-run maps keyed by project plus document id and by exact query/view. Reuse current-run document, user, link, and lineage results instead of rereading them.
- Fetch the graph routing core once, then only the route rows and targeted lineage/dependency facts needed for the seeded page/capability groups. Do not request broad inventory when the live schema and project snapshot already establish it.
- After scope is known, independent document and link reads may run in bounded parallel batches. Keep dependent pagination and cursor advancement sequential; never guess later offsets in parallel.
- Do not persist a report or ticket cache across runs without a current version and invalidation contract. Owner, status, priority, links, and other mutable fields must never be authoritative from an older run.

## Form product-feature execution units

Start with the user's assigned items, then discover enough of the linked feature universe to propose complete product features around that work. Here a **feature** is one concrete user-facing page, entrypoint, capability, or outcome with its own end-to-end user journey and acceptance boundary. It includes the backend, UI, Storybook, validation, and other shipping work required for that page or capability. A PRD is an evidence container, not the feature boundary: thirty PRD tickets may describe several features, such as one eight-ticket page. Show broader siblings later as context without importing them automatically.

Use explicit lineage first. Under the current relationship contract, `PRODUCES` runs from parent to child; a selected `parentArtifact` is only a convenience projection. Fully page the artifact-link listing to verify lineage and to enumerate all sibling tickets. Use direct relationships first and bounded tree traversal only when nested parent lineage must be resolved. Always follow the current live tool schema for endpoint and direction semantics.

Propose delivery units in this evidence order:

1. One or more assigned tickets belong to the same concrete page, entrypoint, capability, user journey, and acceptance boundary. Include every ticket whose change is necessary to make that exact feature functional end to end in one PR.
2. A live lineage through a parent feature, approved PRD, design, implementation plan, or current code path supports that boundary. Shared ancestry alone never defines the unit.
3. A clearly labeled `Inferred` proposal when multiple independent facts establish one bounded functional slice. State the facts and treat it as unresolved for sweep execution until confirmed.
4. A singleton delivery unit when one assigned ticket itself defines an independently functional outcome.
5. `SCOPE_DECISION_REQUIRED` when the assigned work cannot form a functional feature without materially broader ownership, several plausible page/capability boundaries exist, or acceptance evidence cannot distinguish feature-owned work from shared dependencies.

Do not group tickets solely because they share a PRD or feature parent, titles are similar, files overlap, they share a repository, `RELATES_TO` links them, or they happen to be active together. Ground the boundary in approved acceptance evidence and the actual page/capability. When that remains ambiguous, inspect current code read-only through routed code intelligence and the current checkout when available to identify the owning entrypoint, user journey, and consumers. Preserve every proposed member and external dependency's stable id, slug, type, returned `webUrl`, status, live priority, assignee, repository when evidenced, grouping evidence, functional role, and live verification time.

Classify each relevant linked ticket as an `assigned feature member`, `proposed incoming feature member`, `shared external prerequisite`, `design prerequisite`, `rollout-gated cleanup`, or `context only`, using live acceptance, actual usage, and sequencing evidence. Assign ancillary work to the one page/capability that actually consumes it. A multipage foundation ticket remains a shared prerequisite or requires a scope decision; do not duplicate its mutation ownership across feature units. A dependency remains with its current owner by default when its reusable output can land separately and satisfy the selected feature. A legacy batch, wave, or prior execution label does not override the current feature boundary.

Keep one canonical shared-dependency ledger keyed by stable ticket id. Each feature unit references that row and its exact edge; never render the same prerequisite as separate ownership or execution records. The canonical row names every affected unit, current owner, status, inherited downstream urgency as context, the output or event that satisfies the wait, and the deduplicated dependency chain.

For each proposed delivery unit, test whether its selected shipping members can land as one functional PR. If they require different repositories or otherwise make one PR impossible, report a `SINGLE_PR_CONFLICT` with the exact membership and repository evidence. If live requirements place a mandatory member after rollout or otherwise contradict the proposed boundary, report `FEATURE_BOUNDARY_DECISION_REQUIRED` and the exact sequencing evidence. Do not silently split a selected unit, create multiple PRs for it, drop a required member, force later cleanup into the shipping PR, or solve the conflict by adopting the entire parent feature.

When required same-page members retain different owners, identify the proposed single PR owner and how every owner contributes to that branch/PR. If no safe contribution agreement is evidenced, mark the affected unit `SCOPE_DECISION_REQUIRED`, name the exact owner decision, and keep it waiting under the sweep's existing blocker disposition. One PR is not established while its owner and contribution path are unresolved.

When an ambiguous ancillary ticket could be mandatory to more than one candidate feature, mark every possibly affected unit `SCOPE_DECISION_REQUIRED`. Park those units until evidence assigns the ticket to one unit, defines a separate shared capability, or proves it optional/context. Do not duplicate it into multiple units. Unaffected units may proceed only when evidence proves their completeness does not depend on it.

When the report is used by `$cl-sweep`, retain the feature universe, proposed selected-unit membership, external dependencies, and verified snapshot as the initial discovery input. Only a user-selected or unambiguous bounded delivery unit becomes one execution unit and one PR. `SCOPE_DECISION_REQUIRED`, inferred, ambiguous, `SINGLE_PR_CONFLICT`, or `FEATURE_BOUNDARY_DECISION_REQUIRED` units require resolution before execution. Adopting a broader feature and its incoming tickets requires the user's explicit scope choice. The sweep owns eligibility, worker ownership, bounded refreshes, and all mutations.

## Order by priority

Resolve priority meaning from the live schema before sorting. The current domain is `URGENT | HIGH | MEDIUM | LOW | null`; use the report policy `URGENT > HIGH > MEDIUM > LOW > null/UNKNOWN`. Record that this is the report's semantic ordering, not a numeric rank claimed by the API. If the live domain changes, disclose the change and do not guess an order for unfamiliar values.

- Show every ticket's live priority. Keep missing or unrecognized priorities visible as `UNKNOWN` and sort them last; never infer priority from status, age, dependency position, or ticket type.
- Set each selected feature unit's **declared priority** to the highest semantic priority among its assigned and proposed incoming members. External prerequisites and broader context retain their own priorities but do not inflate the selected unit's declared priority. Preserve which member or members supplied each value; do not mutate stored priorities.
- Build a feature-level dependency graph from proven, directed blockers between in-scope units. Propagate urgency upstream: a unit's **effective scheduling priority** is the highest declared priority among itself and every proven in-scope downstream unit it transitively unlocks. Record the inheritance path. An inferred or unknown dependency does not propagate priority and must remain visibly unresolved.
- Order the queue topologically so a proven prerequisite precedes the unit it blocks. Among currently dependency-eligible units, sort by effective scheduling priority descending, then declared priority descending, then stable feature-unit id. Do not use creation time as a tie-breaker. This makes a LOW unit that unlocks a HIGH unit precede an unrelated MEDIUM unit while preserving every ticket's declared priority.
- Detect dependency cycles and report the exact cycle instead of inventing an order. Same-feature internal dependency order stays inside its one execution unit and one PR.
- Keep a blocked high-priority unit visible with its blocker and inherited-priority path. Priority controls report and sweep queue order; it does not bypass readiness, ownership, approval, or safety gates and must not be automatically changed.
- Do not add another owner's or another project's blocker to executable scope. Show the effective downstream urgency as context and require explicit ownership or scope transfer before scheduling it.

## Trace blockers

- Classify an explicit, live-verified `BLOCKS` relationship with proven source-to-target direction as a `Verified blocker`. Under the current artifact-link contract, asking for the other endpoint role `source` on the downstream ticket returns incoming BLOCKS links; inspect the current schema before relying on that parameter.
- A required API, artifact, or behavior may be an `Inferred dependency` when live acceptance evidence or code evidence proves the downstream work cannot function without it. State the evidence and uncertainty. Shared files, repository overlap, status alone, textual similarity, `RELATES_TO`, `PRODUCES`, or shared feature membership never proves a blocker.
- Follow only the upstream transitive chain needed to explain why an assigned item cannot progress. Record the direct edge direction at every hop, stop when the chain is satisfied or no longer proven, and identify cycles explicitly.
- Live-fetch each material blocker's owner, status, project, and dependency evidence before reporting it. Fully page user listing when opaque assignee ids need names. A null owner means unknown or unassigned, not another owner. Unknown or unverifiable state is `UNKNOWN`, never `ready` or `resolved`.
- A canceled or otherwise terminal blocker is not automatically resolved. Verify the required output, replacement ticket, superseding relationship, or downstream acceptance before calling the dependency satisfied.
- Show blockers from another project as context. An evidence-backed cross-project reassignment recommendation must say that explicit scope and ownership transfer is required; never silently add that ticket to the sweep.

## Protected owners

Treat every ticket currently assigned to **Matt Stephens** or **Nenad Antic** as protected from ownership transfer. Fully page the live user lookup, resolve each exact display name to its stable user id, and match assignments by that verified id. Do not use fuzzy, partial, or guessed identity matches. If either identity cannot be resolved unambiguously, disclose the data gap and do not make a recommendation that depends on resolving it.

Never include a protected ticket in an incoming or outgoing reassignment recommendation, transfer suggestion, optional scope-choice transfer, or broader ownership redesign. This prohibition applies even when the ticket looks like engineering work, is a same-PR member, blocks the selected feature, belongs to another project, or a generic scope or transfer approval would otherwise permit consideration. Only a later explicit user revision to this protected-owner policy may change it.

Keep protected tickets visible with their current owner as required feature members, owned dependencies, or context. Label them `Protected owner — no reassignment`, distinct from a discretionary `keep owner; coordinate` recommendation. Coordination and contribution without an assignment change remain permissible. If the feature cannot be completed without a protected owner's contribution and no safe contribution agreement is evidenced, keep the affected unit waiting and report the required coordination or scope decision; do not offer transfer as a resolution.

Tickets owned by everyone else remain eligible for consideration under the evidence, feature-scope, marginal-benefit, and actual-transfer authorization gates below. Eligibility alone is not a recommendation.

## Recommend ownership changes

Recommend an incoming `current owner -> requesting user` transfer as a **candidate reassignment subject to user and current-owner agreement** only when all of these are true:

- the ticket's implementation is necessary to the selected page/capability's own acceptance boundary, rather than a reusable shared prerequisite that can land separately;
- it must be part of the same functional PR, or evidence shows transfer removes a concrete coordination failure that keep-owner/coordinate cannot solve as well;
- the marginal benefit of transfer is stronger than leaving the current owner to deliver the dependency; and
- the transfer does not silently expand the user into a different feature or the whole PRD.

Except for the explicit protected-owner policy above, existing assignment, a person's name, a ticket's role label, or a dated instruction to leave assignments unchanged constrains mutation but does not suppress a private ownership-redesign candidate. State that agreement is required. Do not infer expertise, capacity, or nontransferability from current ownership alone.

Name the ticket, distinguish feature membership from dependency, and state the concrete marginal benefit. A direct `BLOCKS` edge, shared PRD, or same parent does not by itself justify transfer. Prefer `keep owner; coordinate` for reusable upstream outputs that can land separately, and when substantiated by an active owner-held PR or branch, explicit nontransferable approval responsibility, security or infrastructure access boundary, or current instruction forbidding transfer. A design-approval prerequisite may remain with its approver. If transfer and coordination are equally effective, recommend coordination. Zero incoming transfers is a valid result. Never automatically reassign or contact either owner.

For every evaluated incoming candidate, record the same-PR necessity, keep-owner coordination alternative, evidenced handoff failure or cost, current branch/PR state, and why transfer would or would not change the outcome. Do not recommend transfer when this comparison is missing.

List other-owner selected feature members separately from shared external dependencies. Analyze only selected feature members for incoming transfer; keep prerequisites, broader siblings, rollout-gated cleanup, and context tickets with their owners unless a separate explicit scope decision changes that boundary. Do not recommend outgoing transfers by default; an outgoing option may appear only as one practical scope-choice alternative.

Deduplicate recommendations by stable id, and group candidates by current owner when that makes one proposed ownership redesign clearer. If one blocker affects several assigned tickets, list it once with all affected tickets.

## Report shape

Read and follow [Standalone HTML reports](references/html-report.md). Build the executive-first report as Markdown source, render it with the bundled script to a local HTML file, and verify the result through the headless workflow in that reference. When a dependency or ownership diagram materially clarifies the selected units, load `mermaid-visualizer` by name (`$mermaid-visualizer` in Codex or `/closedloop-core:mermaid-visualizer` in Claude Code), read its syntax reference from that skill's own folder, add one small Mermaid diagram, and verify that the HTML contains the rendered SVG. The HTML is a read-only artifact; it must contain no controls that execute assignments, ticket changes, comments, messages, or sweep actions.

Immediately under every proposed feature title, add `**What this delivers:**` followed by 1–3 sentences describing the plain user-facing outcome and concrete scope completed by all included tickets. Ground it in verified acceptance and boundary evidence; do not restate ticket titles or promise the broader PRD. When membership or scope is unresolved, explicitly frame the outcome as proposed or pending the named decision.

Keep the source concise and executive-first. After one compact snapshot line with project, user, timestamp, and completeness, use this order:

1. **Your assigned tickets** — one table with every assigned nonterminal ticket, title, status, priority, owning page/capability, proposed feature unit, and immediate blocker disposition.
2. **Proposed page/capability features** — the concrete user-facing outcome, assigned members, only the additional tickets necessary in the same PR, references to canonical shared prerequisites, acceptance boundary, repository, declared/effective priority, proposed PR owner/contribution agreement, and single-PR disposition. Present units in topological queue order with effective priority as the eligible-unit tie-breaker; use `SCOPE_DECISION_REQUIRED` when owner coordination or membership remains unresolved.
3. **Recommended incoming reassignments** — only minimal evidence-backed candidates, grouped by current owner when helpful, with same-PR necessity, coordination alternative, evidenced handoff cost, branch/PR state, marginal benefit, and agreement caveat. Say `None` plainly when coordination is equally good.
4. **Scope decisions required** — when a complete page/capability would need materially broader ownership, show practical choices: keep prerequisites external and wait/coordinate; explicitly adopt eligible named additional tickets; revise the page/capability boundary; or optionally move non-protected assigned work to another owner. For protected tickets, show coordination without ownership transfer as the only ownership path. Do not choose for the user and do not use an arbitrary ticket-count limit.
5. **Dependencies and broader feature context** — one canonical shared-dependency ledger with affected units and completion events, followed by design prerequisites, rollout-gated cleanup, other PRD features, terminal context, and concise verified dependency chains. Keep this after the actionable ownership view.
6. **Handled by a repo skill** — tickets whose tag routes them to a repo skill the user runs locally (for example `feature-map` to `feature-map-refresh`), with slug, title, and the skill name. Say `None` when there are none.
7. **Coverage and data gaps** — project-universe and assigned-scope pagination totals, sources, unknown statuses, unverified relationships, ambiguous lineage, `SINGLE_PR_CONFLICT`, or `FEATURE_BOUNDARY_DECISION_REQUIRED` units.

Use ticket slugs and returned links for readability while retaining stable ids in the scope snapshot. Distinguish verified facts, inferred dependencies, and ownership gaps. Say that no blockers were found only after document, relationship, and user pagination is complete. Do not describe an item or feature unit as ready for execution merely because no blocker was found.
