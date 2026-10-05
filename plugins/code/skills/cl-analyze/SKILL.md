---
name: cl-analyze
description: Analyze one ClosedLoop feature ticket from a URL or FEA slug before execution. Use when asked to assess ticket complexity, feasibility, readiness, applicable requirements PRDs and missing PRD links, UI design guidance, human UI plan approval needs, blockers, legacy split lineage, merge-batch compatibility, nonsensical or obsolete scope, product versus engineering routing, or whether a ticket can safely be worked before invoking $cl-execute. Keep engineering and operational concerns private; recommend a company-visible ticket comment only for a genuine Product decision under cl-policy or when the user explicitly requests the exact comment. Keep every issue as its single ticket; do not recommend $cl-split. Do not implement the ticket.
---

# CL Analyze

## Purpose

Evaluate one ClosedLoop feature ticket before execution. Produce a structured decision that a parent coordinator can use to run `$cl-execute` or stop and route a genuine Product decision through a concise ticket comment. Keep engineering and operational blockers private. Keep every issue as the single ticket it already is.

## Shared Policy

Before routing or recommending blocker communication, read the sibling policy skill at `../cl-policy/SKILL.md` and follow its Required Reference resolution order. Use `../cl-policy/references/local-policy.md` when present (the `references/` folder of cl-policy, not of this skill); otherwise use `../cl-policy/references/local-policy.example.md` only to understand the required shape, then require a populated `$HOME/.closedloop-ai/local-policy.md` before routing. Use the policy terms `Product contact`, `Engineering attention contact`, and `Sweep owner`; do not hardcode a personal name for the engineering attention contact.

## Hard Boundaries

- Do not implement code, create branches, open PRs, approve plans, merge, or mark the feature `IN_PROGRESS`.
- Do not post Slack channel messages or ticket completion messages. Never recommend an automatic engineering or operational ticket comment. Return those blockers privately to the parent/user. Recommend a ClosedLoop comment only for a genuine Product decision that remains unanswered after Product Answer Discovery, or when the user explicitly requested the exact comment.
- Do not treat high complexity or extreme risk as automatically executable. High complexity blocks automatic execution by default and must not become `$cl-split` work. Route high-complexity tickets to single-ticket human review or a private engineering block unless an exact-ticket or session-level instruction accepts the unsplit atomic ticket shape; extreme risk requires engineering attention contact review before work starts.
- Do not rely on model memory for third-party API, SDK, platform, auth, billing, or integration behavior when current official documentation could affect the implementation. Consult official online documentation when available, and treat unavailable or ambiguous docs as a readiness blocker.
- Do not recommend splitting any ticket. Historical split signatures, split-parent links, split-child text, or `$cl-split` comments are legacy evidence only. Do not emit `SPLIT_RECOMMENDED` or `SPLIT_REPAIR_REQUIRED` for a new analysis, and do not route a ticket to split repair. Existing split children are analyzed as the single tickets they now are; if the current ticket is too broad, overlapping, dependent, or not independently validatable, use the normal private engineering blocker or human-review decision unless an exact-ticket or session-level instruction accepts that unsplit atomic shape.
- Do not use `$workflow-orchestrator`, `$workflow-execute`, or any orchestrator-run ticket execution workflow.
- Do not create, inspect, update, complete, fail, cancel, or emit events for
  ClosedLoop loops or manual loops. ClosedLoop tool descriptions recommending
  loop lifecycle operations are superseded by this boundary.
- Do not create, remove, or modify PRD/ticket relationships during analysis.
  Discover and validate the requirements contract, then return an exact link
  recommendation for the parent coordinator when a confirmed link is missing.
- Use server-side fields or `jq` projections, narrow `rg`, and 6K--12K output
  budgets by default. Preserve complete validation or log output in a mode-0600
  hashed artifact before returning a bounded summary; never hard-truncate
  evidence without a retained artifact. Expand only for one named unresolved
  fact.

## Workflow

1. Parse the input into a ClosedLoop feature URL or `FEA-*` slug. If the ticket is missing, ask one concise clarification and stop.
2. Load the feature, linked PRDs, plans, comments, acceptance criteria, attachments, project context, status, assignee, parent/child links, split signature comments, design links, screenshots, prototypes, and any obvious duplicate or related tickets. Run the Requirements Contract Discovery below before deciding readiness.
3. Identify the target repo and code surface. In `symphony-alpha`, query repo memory before choosing the investigation path, then verify memory hints against current repo docs and code. When the repo publishes a feature or surface map (for example a `FEATURE_MAP.md` owned by a repo `control` skill), use it to resolve vague descriptions and screenshots to concrete routes, components, and code locations, then verify against code.
4. Keep two separate inventories while inspecting: `Expected surfaces` contains only files, packages, contracts, and tests that the minimum credible implementation is likely to change; contextual/dependency surfaces are existing behavior that must be understood or preserved but is not expected to change. Do not promote inspected files into `Expected surfaces` merely because the ticket depends on them.
5. Inspect only enough implementation to judge whether the ticket is coherent and executable. Prefer `rg`, repo docs, route registration, imports, tests, and ownership boundaries over assumptions.
6. If the ticket touches a third-party API, SDK, hosted platform, model provider, auth provider, billing provider, webhook/event contract, or fast-moving dependency, consult the official current online documentation before deciding readiness. Prefer primary vendor docs over blogs, examples, or model memory. Record the URL, relevant version/date when visible, and the specific fact used.
7. For UI work, determine whether the ticket includes a design, screenshot, or prototype that clearly shows the expected UI. If no such artifact exists, decide whether the UI change can be safely planned for human approval from the ticket and current app context, or whether the target screen/component/placement is too ambiguous and needs product clarification.
8. Identify whether `$cl-execute` must run a Proposal Contract Audit during
   plan drafting. If the minimum credible implementation will create, update,
   delete, downgrade, preserve, or reinterpret persisted data or durable
   contract shape, set the proposal-contract-audit readiness item to
   `REQUIRED` and name the likely row/link/metadata/wire shapes. If the
   implementation is read-only or presentational with no durable contract
   change, set it to `NOT_APPLICABLE` with evidence. Block analysis only when
   the need for the audit exposes an already-known unresolved dependency,
   ownership conflict, product decision, or validation impossibility.
9. Run the readiness checks below and collect concrete evidence for every blocker. Before deciding `PRODUCT_BLOCKED`, complete Product Answer Discovery and prove the apparent product question has not already been answered.
10. Classify historical split lineage only as legacy context. Treat a ticket as a legacy split child only when split-specific evidence exists: split signature, `$cl-split` child text, parent split comment, or a `PRODUCES` relationship showing the ticket was produced by a split. If there is only a generic parent link, classify `Split lineage: unknown` and investigate the link, but keep the ticket as its own single-ticket analysis target.
11. Classify complexity from the minimum credible implementation delta, risk, decision, routing, UI plan approval requirement, merge-batch fit, and the next action.
12. Return the required structured report exactly enough for a parent thread to parse without asking follow-up questions.
13. When a parent task id was supplied, send the parent the completed
    `CL Analyze Result` before ending the turn. On Desktop, use the statically
    available `send_message_to_thread` capability. In a cwd-bound CLI worker,
    emit the required current-generation `CL_SWEEP_EVENT v1` as the final line;
    the managed App Server runner persists and delivers it, so never issue a
    dynamic TUI tool call. This callback is required for
    every decision, including `GO`, split/repair routing, blockers, and human
    review. A final response in the child alone is not a handoff, and the child
    must not rely on the parent polling its task to discover completion. Keep a
    callback compact: include the ticket slug, this task id when available,
    decision, blocker state, exact next action, and path/hash/status reference
    to any already-declared evidence artifact rather than inline full evidence.
    Do not invent a new result-artifact transport or callback schema. If the
    callback fails, retry once, then surface the exact failure in the child
    result rather than silently idling.

## Requirements Contract Discovery

Resolve the applicable approved PRD set per ticket; do not assume every ticket
in a project shares one global requirements package.

1. Start with direct ticket/PRD links, linked implementation-plan lineage,
   explicit ticket text, split-parent inheritance, and explicit user/project
   designation.
2. On every analysis, discover and use the read-only
   `closedloop-graph` MCP used by `closedloop-intel`. Treat it as a primary
   discovery surface, not only a fallback for missing direct links. Inspect the
   ticket's PRD and plan lineage, split parent/siblings/children, blocking and
   producing relationships, semantically related tickets, active or landed PR
   overlap, and codebase intelligence: symbols, files, ownership boundaries,
   dependencies, call/data paths, co-change history, tests, and blast radius.
   Follow material adjacent nodes until one
   bounded expansion yields no new ticket-relevant authority, dependency,
   duplicate, or conflict. Do not hardcode the MCP server prefix, reopen a
   project-wide inventory, or substitute graph/index results for current live
   ClosedLoop documents and current repository evidence. Use the graph to
   understand the codebase, not merely the ticket system, but verify every
   material code claim against the current checkout and applicable tests. In
   Codex CLI TUI sessions, follow cl-policy: use an already exposed MCP tool or
   CLI/source fallback and never emit an unsupported dynamic tool call.
3. Re-fetch every plausible PRD from live ClosedLoop. Verify its current
   lifecycle status, version, requirement IDs, target surface, exclusions, and
   whether it actually governs the ticket. Keyword similarity alone is not
   authority.
4. Classify the result:
   - `LINKED`: an authoritative applicable PRD is already linked correctly.
   - `INHERITED`: a split or parent contract explicitly carries the PRD and
     requirement IDs into this child.
   - `MISSING_LINK`: exactly one authoritative PRD and relationship type are
     proven, but the ticket lacks that relationship.
   - `AMBIGUOUS`: multiple plausible authorities or an uncertain relationship
     type remain.
   - `NOT_APPLICABLE`: bounded discovery found no governing PRD and the ticket
     itself is the authoritative requirements contract.
5. For `MISSING_LINK`, return the exact PRD slug/version, requirement IDs,
   evidence path, and proposed `source -> relationship type -> target`. The
   parent coordinator must create and re-fetch that relationship before
   execution. Do not guess `PRODUCES` versus `RELATES_TO`; require graph or
   neighboring canonical-lineage evidence for the type.
6. Treat `AMBIGUOUS` or an unexamined applicable PRD as a requirements-readiness
   blocker. `MISSING_LINK` may still return `GO` only when the authority and
   exact relationship are unambiguous and the next action explicitly requires
   parent link reconciliation before `$cl-execute`.

## Product Answer Discovery

Before returning `PRODUCT_BLOCKED`, recommending a Product contact, or drafting
a Product-decision comment, run a bounded but serious search for an existing
authoritative answer. Do not reflexively tag the Product contact because a
question looks product-shaped. At minimum, this search covers linked PRDs, plans, comments, sibling tickets, semantic facts, prior blockers, and related product/design artifacts.

1. Re-read the current ticket body, latest version, acceptance criteria,
   attachments, status history when available, linked PRDs, plans, comments,
   sibling tickets, direct parent/child links, blockers,
   producers, design links, screenshots, prototypes, and related product/design
   artifacts.
2. Use the read-only `closedloop-graph` MCP as a primary discovery surface for
   PRD and plan lineage, sibling tickets, semantic facts, prior blockers,
   duplicate or superseding decisions, related comments/plans, and product terms
   from the apparent question. Follow material adjacent evidence until one
   bounded expansion yields no new decision-bearing fact, then re-fetch material
   documents/comments from live ClosedLoop before relying on them.
3. Treat linked or related implementation plans as decision records when they
   contain explicit accepted scope, exclusions, section decisions, or
   requirements mapping. For example, do not return `PRODUCT_BLOCKED` on a
   question already answered by a cited plan section such as a PLN section 9
   decision; cite that plan and continue analysis under the established answer.
4. Search prior blocker records and workflow repo memory for the ticket,
   siblings, parent plans/PRDs, and named product terms. If a prior blocker was
   answered later in comments, plan text, PRD revisions, or explicit user
   instructions, use the answer and record the evidence rather than repeating the
   blocker.
5. If the Product contact is unavailable or out-of-office according to current
   user/session context, first exhaust the existing-authority search above. When
   no authoritative answer exists, set ClosedLoop comment target to `none` by
   default and surface the exact missing decisions to Daniel/current user or the
   engineering attention route in private; do not tag the unavailable Product
   contact unless the user explicitly authorizes that exact comment.
6. `PRODUCT_BLOCKED` is valid only when the missing decision is genuinely
   product-owned, user-visible or requirements-affecting, not already answered
   in authoritative artifacts, and not resolvable as an engineering contract,
   compatibility, validation, ownership, or implementation choice.

## Readiness Checks

- Requirements: The expected behavior and acceptance criteria are specific, current, and testable.
- Requirements contract: The applicable approved PRDs were discovered and
  read, or `NOT_APPLICABLE` was established. Existing links are correct, or one
  exact `MISSING_LINK` recommendation can be reconciled before execution.
- Product answer discovery: Before any Product route, linked PRDs, plans,
  comments, sibling tickets, semantic facts, prior blockers, and related
  product/design artifacts have been searched deeply enough to prove no existing
  authoritative answer resolves the apparent product question.
- Active surface: The named UI, route, package, component, service, or API exists and is actually used by the app. For UI tickets, verify imports, route registration, feature flags, or runtime usage; do not accept Storybook-only, dead, or unused components unless the ticket explicitly says to revive, delete, or test dead code.
- UI design guidance: For UI work, the ticket has a design, screenshot, or prototype that clearly shows the expected UI; or it has no design artifact but enough product intent, target surface, and existing app pattern evidence for `$cl-execute` to draft a plan and wait for explicit human approval before UI code changes. If the target screen, placement, interaction, or visual outcome cannot be safely planned, mark this blocked for product clarification.
- Architecture fit: The work maps to existing owners, APIs, helpers, constants, tests, and data flow without requiring an unrelated rewrite. A question recorded under `Technical questions for planning` does not by itself make this item `UNKNOWN` when every credible answer keeps the work inside those owners.
- Proposal contract audit: `REQUIRED` with the likely durable row/link/metadata/wire shapes named for `$cl-execute`, `NOT_APPLICABLE` because the implementation is read-only or presentational with no durable contract change, or `BLOCKED` only when analysis already proves an unresolved dependency, ownership conflict, product decision, or validation impossibility.
- Dependency readiness: Required design, product decisions, API contracts, data, auth, credentials, flags, migrations, or upstream PRs are available.
- External API/docs freshness: For third-party APIs, SDKs, hosted platforms, model providers, auth/billing providers, webhooks, or fast-moving integrations, current official documentation was checked online and supports the proposed work. If official docs cannot be reached, are ambiguous, conflict with the ticket, or require credentials/terms that are unavailable, mark this `BLOCKED` or `UNKNOWN`.
- Duplication/conflict: The request is not already done, superseded, covered by an active PR, duplicated by another ticket, or contradicted by linked plans/comments.
- Validation path: There is a realistic way to test the change locally and in CI, including desktop or visual QA when relevant. For a bug ticket, name the cheap test path that can fail on current main before the fix, or say why none exists and which runtime evidence (for example a `pnpm control` capture) stands in for it. For a behavior-preserving ticket (refactor, move, rename, dependency swap), name the existing tests or captures that can pin current behavior on the base, or the gap `$cl-execute` must fill before moving structure.
- Safety and risk: The work does not require automatic changes to high-risk areas such as auth, permissions, billing, data deletion, migrations, privacy/security boundaries, release automation, or broad cross-package contracts without explicit human review.
- Safety fact: When the minimum credible implementation touches auth, permissions, data writes, migrations, or a shared contract, name the one fact the change is safe because of (for example, "the new route resolves the same auth context as the old one for every caller type") and the cheapest code that can prove it: a focused test, a script that calls the real code, or a `pnpm control` capture. `$cl-execute` carries the fact into the plan and proves it by running that code; a prose argument is not a proof. Use `NOT_APPLICABLE` when none of those surfaces change and `UNKNOWN` when they do but no single fact explains why the change is safe.

## Complexity And Risk

Classify both complexity and risk:

- `LOW`: Localized, well-scoped change with direct tests and clear acceptance criteria.
- `MEDIUM`: Multiple files or modules, but ownership, contracts, and validation are clear.
- `HIGH`: Cross-surface, cross-package, schema, desktop/web, migration, auth, security, release, or large refactor work; or ambiguous ownership with meaningful regression risk.
- `EXTREME`: Could cause data loss, security/privacy exposure, billing or permission errors, broad production instability, or requires product/architecture decisions that are not already documented.

Classify complexity from the minimum coherent implementation that satisfies the ticket, not from the breadth of the existing system being inspected. This is an honest complexity boundary, not a scheduling preference for smaller tickets or separate pull requests. Unchanged dependencies, existing agents/skills, current CI workflows, historical PRs, and validation context do not increase implementation complexity by themselves. A harness-activation change that only registers, links, or dispatches to one unchanged canonical implementation is normally `LOW` or `MEDIUM` even when the underlying system is broad. Multiple files under one ownership boundary with one atomic validation path can still be `MEDIUM`.

Do not generalize that rule to all work described as a "port." A port that parses or transforms another harness's sessions, transcripts, events, data formats, state, behavior, or runtime contracts may be cross-surface and `HIGH`; classify it from the actual semantic and data-flow changes. Treat an adapter as thin only when evidence shows it is referential or dispatch-only and does not translate behavior or contracts.

Use `HIGH` only when the expected implementation itself must change multiple independently risky ownership boundaries or contracts, or requires a concrete migration/refactor. Before assigning `HIGH`, state why a referential adapter, registration, link, or existing extension point cannot satisfy the ticket and name the independently mergeable implementation boundaries that make one execution unsafe. Do not count documentation, focused tests, or drift guards as separate workstreams when they validate the same atomic change.

`HIGH` complexity or `EXTREME` risk is a blocker for direct automatic execution by default. A `HIGH` ticket may return `GO` only under an exact-ticket or session-level human complexity override: the user directs execution of that named ticket or ticket set and accepts or requires its atomic unsplit implementation shape, `Risk` is not `EXTREME`, every readiness item passes, product intent and ownership are clear, the approved requirements/design contract is complete, and the result records the approval evidence in `High-complexity execution override: APPROVED`. Apply cl-policy's natural-language rule: in this context, “proceed with ISS-1234, do not split it” or equivalent is sufficient; never require the user to recite `HIGH`, `risk`, `override`, or a magic sentence. Before reporting the override missing, search the current user thread plus the latest exact-ticket memory/comments, with the newest direct user instruction taking precedence. Persist and reuse an accepted override, and ask again only for a concrete material scope/risk expansion beyond it. Never infer an override from assignment, priority, an approved PRD, or a generic request to make progress. Without that narrow override, use `ENGINEERING_BLOCKED` or `HUMAN_REVIEW_REQUIRED`; do not use `SPLIT_RECOMMENDED`. If historical split evidence shows the current ticket is too broad, overlapping, dependent, or not independently validatable, use `ENGINEERING_BLOCKED` or `HUMAN_REVIEW_REQUIRED`; do not use `SPLIT_REPAIR_REQUIRED`. Product ambiguity, duplicate/stale scope, inactive surface, missing external docs, extreme risk, or unrelated engineering uncertainty cannot be overridden this way. `EXTREME` risk must not be split or executed automatically. When a session-level instruction requires Daniel's personal approval for every implementation plan, a high-complexity override authorizes only plan-only `$cl-execute`; branch creation, code changes, PR work, and merge work remain blocked until Daniel personally approves the exact plan.

## Merge Batch Fit

Assess this ticket's compatibility with other ready tickets without weakening its
own decision. A ticket may join a single implementation/PR batch only after it
independently returns `GO` or `GO_WITH_UI_PLAN_APPROVAL` and all parent handoff
gates pass.

- `REQUIRED`: evidence proves one atomic implementation should satisfy and close
  the named tickets together.
- `PREFERRED`: the tickets share one implementation, validation, rollback, and
  merge boundary, so one PR materially reduces queue latency without obscuring
  acceptance.
- `ALLOWED`: batching is safe but offers no strong advantage.
- `ISOLATE`: keep separate because of incompatible requirements, ownership,
  release/rollback behavior, UI approval or merge policy, literal dependencies,
  migrations/auth/billing/security risk, or review complexity.

Name only evidence-backed candidate slugs. Do not invent adjacent scope, use
batching to carry an unready ticket, or treat textual/file overlap alone as a
reason to batch. Preserve independent ticket traceability and acceptance even
when one later execution plan and PR covers several tickets.

## Decisions

- `GO`: The ticket is coherent, ready, not extreme-risk, and can proceed to `$cl-execute` without an extra human UI plan approval gate. It is not `HIGH` unless the exact-ticket or session-level human complexity override above is explicitly `APPROVED`; when a current instruction requires Daniel's personal approval for every implementation plan, `GO` must still set the next action to plan-only `$cl-execute` until that approval is present.
- `GO_WITH_UI_PLAN_APPROVAL`: The ticket is coherent, ready, not high-complexity/extreme-risk, and requires UI work, but the ticket does not include a design, screenshot, or prototype that clearly shows the expected UI. Use only when the target surface and product intent are clear enough for `$cl-execute` to write a concrete UI implementation plan and wait for explicit human approval before plan approval, feature status mutation, branch creation, code changes, PR work, or merge work. This is not a blocker and must not be routed as product or engineering blocked unless the UI cannot be safely planned.
- `PRODUCT_BLOCKED`: Product clarification or PM decision is needed before code should start, and Product Answer Discovery proved no existing authoritative answer resolves it. Examples: unclear desired behavior, acceptance criteria conflict, inactive UI scope that may reflect stale product intent, missing design/content when no safe UI plan can be drafted, unclear target screen/component placement, or prioritization mismatch.
- `ENGINEERING_BLOCKED`: The engineering attention contact should review before work starts. Examples: high complexity, extreme risk, architectural uncertainty that running something cannot settle, dependency on another engineering change, missing test harness, suspected duplicate implementation, or unclear technical ownership. A technical question that running something can answer is not by itself a blocker. First look for a recorded answer with closedloop-graph `fts_search` and `search_memory_facts` and in workflow memory. Then run a read-only probe when one settles it: existing tests or code, a query plan, library source at the lockfile-pinned version, or a `pnpm control` read. Cite the probe in `Evidence`. When only a throwaway prototype can settle it, do not build one here (this skill never implements); record it under `Technical questions for planning` for `$cl-execute`'s planning prototype step, and block only when the question also needs a human engineering decision or the prototype would need access, data, or credentials that are unavailable.
- `ALREADY_DONE_OR_DUPLICATE`: Do not execute. Provide evidence and route to the engineering attention contact unless there is a clear product decision needed.
- `HUMAN_REVIEW_REQUIRED`: Mixed or ambiguous blocker where routing is unclear. Default to the engineering attention contact first; do not tag the PM unless the product blocker is explicit.

## Communication Rules

- If `GO` or `GO_WITH_UI_PLAN_APPROVAL`, do not recommend a blocker comment or DM yet.
- If a bug is punted back because the requested or obvious fix would drift
  from established requirements, any recommended ClosedLoop comment must name
  the exact requirements source and where it is stated. This may be a
  PRD/plan/ticket, prototype, design artifact, screenshot, PR comment, Slack
  message, or other approved source. Include a reviewable location: artifact
  slug/name and current version/status when it has one; direct URL, repository
  path, PR comment URL, Slack permalink, channel/thread/timestamp, or other
  exact locator; relationship or inheritance evidence; and the specific
  requirement IDs, clauses, prototype screen/state, design annotations, PR
  comment text location, or Slack message/thread location that would be
  violated. Map each proposed behavior change to the violated requirement; do
  not say only "requirements drift" or cite a PRD package, prototype, design,
  PR discussion, or Slack conversation generally. If the governing source and
  exact requirement location cannot be named, do not publish a company-visible
  comment yet; return the ambiguity privately as a requirements blocker.
- If `PRODUCT_BLOCKED`, recommend adding a first-person ClosedLoop comment on the ticket tagging the policy `Product contact` with the concise issue, Product Answer Discovery evidence, and the specific product question only when the Product contact is available under current user/session context. If the Product contact is unavailable or out-of-office, set ClosedLoop comment target to `none` unless the user explicitly authorizes that exact comment, and surface the exact missing decisions privately to Daniel/current user or the engineering attention route. Do not use Slack.
- If `ENGINEERING_BLOCKED`, `ALREADY_DONE_OR_DUPLICATE`, `HUMAN_REVIEW_REQUIRED`, `HIGH` complexity without an accepted unsplit atomic-shape override, or `EXTREME` risk, set the ClosedLoop comment target to `none`, keep all engineering/operational evidence in the private result/memory, and surface the required action to the invoking user. Do not recommend a DM unless the user explicitly authorized that exact communication.
- If both product and engineering issues exist, keep the engineering evidence private. The Product comment may contain only the independently clear product behavior/decision, user impact, and minimum evidence; exclude access, credentials, environment, worker state, complexity machinery, and orchestration details.
- Before `PRODUCT_BLOCKED`, apply Product Answer Discovery and cl-policy's ownership rule. A current direct
  statement that the user created/owns the ticket as an engineering fix
  supersedes stale Product routing. Present remaining engineering contract
  choices plainly to that user; do not tag the Product contact unless a
  separate unresolved user-visible product decision still exists.

## Required Output

End with this structure:

```markdown
## CL Analyze Result
Ticket: <FEA slug and URL>
Project: <ClosedLoop project slug/name and URL>
Repo: <repo name or unknown>
ClosedLoop updated at: <timestamp>
Latest relevant comment: <timestamp/id or none>
Feature status: <status>
Assignee: <name/id>
Acceptance criteria fingerprint: <short stable summary or hash>
Requirements contract: <applicable approved PRD slugs/versions and exact requirement IDs | not_applicable with evidence>
Requirements discovery: <direct links, inherited lineage, closedloop-graph evidence, and live verification summary>
Product answer discovery: <linked PRDs/plans/comments/sibling tickets/semantic facts/prior blockers/product-design artifacts searched, answers found or exact missing decisions, product-contact availability>
PRD link state: <LINKED | INHERITED | MISSING_LINK | AMBIGUOUS | NOT_APPLICABLE>
PRD link recommendation: <PRD source -> exact relationship type -> ticket target, or none>
Product intent clear: <YES | NO | UNKNOWN>
Expected surfaces: <repo/package/files/routes/contracts likely touched, or unknown>
Context/dependency surfaces: <important inspected or preserved surfaces not expected to change, or none>
Technical questions for planning: <none | each question a throwaway prototype can settle, why running code answers it, and the smallest prototype that would>
External docs: <not_applicable | official docs consulted: URLs and relevant versions/dates | blocked/unknown with reason>
Proposal contract audit: <PASS - durable write/link/metadata/selector/writer consumers checked | BLOCKED - exact failed proof | UNKNOWN - exact missing proof | NOT_APPLICABLE - why no durable contract change exists>
Safety fact: <not_applicable - no auth, permission, data-write, migration, or shared-contract change | the one fact the change is safe because of, plus the test, script, or pnpm control capture that will prove it>
Split lineage: <top_level | split_child | unknown>
Parent split ticket: <parent FEA/url and split signature, or none>
Decision: <GO | GO_WITH_UI_PLAN_APPROVAL | PRODUCT_BLOCKED | ENGINEERING_BLOCKED | ALREADY_DONE_OR_DUPLICATE | HUMAN_REVIEW_REQUIRED>
Blocker category: <none | product | engineering | duplicate | high_complexity | split_repair | extreme_risk | mixed>
Complexity: <LOW | MEDIUM | HIGH>
Complexity basis: <minimum credible implementation delta; distinguish referential harness activation from semantic/data/runtime porting; for HIGH, name the independently risky implementation boundaries>
High-complexity execution override: <not_applicable | APPROVED - exact ticket-specific human instruction and atomic-shape acceptance>
Risk: <LOW | MEDIUM | HIGH | EXTREME>
Confidence: <LOW | MEDIUM | HIGH>
Merge batch fit: <REQUIRED | PREFERRED | ALLOWED | ISOLATE>
Merge batch candidates: <evidence-backed ticket slugs or none>
Merge batch basis: <shared implementation/validation/rollback/merge boundary, or isolation reason>
UI work: <YES | NO | UNKNOWN>
UI design source: <not_applicable | design | screenshot | prototype | missing>
Human UI plan approval: <not_required | required | blocked>
UI plan approval reason: <why approval is or is not required>
Splittable: <NO>
Split owner: <none>
Suggested split count: <none>
Split reason: <single-ticket policy: do not split; historical split evidence is legacy-only>
Split gate: <BLOCKED> - <single-ticket policy; do not route to $cl-split>

Summary:
- <one to three bullets>

Evidence:
- <ticket/code/repo evidence with paths, links, or search findings>

Readiness:
- Requirements: <PASS | BLOCKED | UNKNOWN> - <reason>
- Requirements contract: <PASS | BLOCKED | UNKNOWN> - <PRD authority/link evidence or blocker>
- Product answer discovery: <PASS | BLOCKED | UNKNOWN> - <existing authoritative answer evidence or exact missing product decision and availability routing>
- Active surface: <PASS | BLOCKED | UNKNOWN> - <reason>
- UI design guidance: <PASS | APPROVAL_REQUIRED | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <design/screenshot/prototype evidence, planned-approval reason, or blocker>
- Architecture fit: <PASS | BLOCKED | UNKNOWN> - <reason>
- Proposal contract audit: <PASS | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <persisted fields/link shapes, downstream consumers, selector reachability, writer authority, freshness/retraction, retry/cost/file-size/P2002, and sibling-ticket/product-decision evidence>
- Dependencies: <PASS | BLOCKED | UNKNOWN> - <reason>
- External API/docs freshness: <PASS | BLOCKED | UNKNOWN | NOT_APPLICABLE> - <official docs URLs/date/version or reason>
- Duplication/conflict: <PASS | BLOCKED | UNKNOWN> - <reason>
- Validation path: <PASS | BLOCKED | UNKNOWN> - <reason>
- Safety/risk: <PASS | BLOCKED | UNKNOWN> - <reason>
- Safety fact: <PASS | UNKNOWN | NOT_APPLICABLE> - <named fact and planned runnable proof, or why none can be named>

Communication:
- ClosedLoop comment target: <none | product contact>
- Engineering attention DM: <not_required | explicitly_user_authorized>
- Message reason: <why this target is appropriate>
- Recommended ClosedLoop comment: <ready-to-post concise first-person comment, or none>
- Recommended engineering attention DM: <ready-to-send only when explicitly user-authorized, otherwise none>

Persistence:
- Memory key: cl_sweep_ticket_state <project_slug_or_url> <FEA-slug>
- Recheck when: <specific ticket/product/engineering change that should trigger re-analysis, or none>
- Memory fields: <closedloop_updated_at, latest_relevant_comment, status, assignee, acceptance_criteria_fingerprint, product_intent_clear, product_answer_discovery, expected_surfaces, external_docs, ui_work, ui_design_source, human_ui_plan_approval, split_lineage, parent_split_ticket, decision, blocker_category, complexity, risk, split gate, evidence summary>

Next action:
- <reconcile exact PRD link then run plan-only $cl-execute | run $cl-execute in this thread | run $cl-execute for UI plan and human approval | add ClosedLoop comment tagging product contact | surface engineering blocker privately to user | ask user>
```

If the decision is not `GO` or `GO_WITH_UI_PLAN_APPROVAL`, do not execute the parent ticket. If `Decision: GO` or `Decision: GO_WITH_UI_PLAN_APPROVAL` would conflict with any readiness item that is not `PASS`, `NOT_APPLICABLE`, or `APPROVAL_REQUIRED` for `UI design guidance` only, a proposal contract audit that is `BLOCKED` or `UNKNOWN`, `Complexity: HIGH` without `High-complexity execution override: APPROVED`, `Risk: EXTREME`, unknown repo/surface metadata, missing required metadata, an `AMBIGUOUS` or unexamined requirements contract, or missing external-doc evidence for a third-party integration, change the decision to `ENGINEERING_BLOCKED`, `PRODUCT_BLOCKED`, or `HUMAN_REVIEW_REQUIRED` according to the blocker evidence; never change it to `SPLIT_RECOMMENDED`. A `MISSING_LINK` requirements state may return `GO` only with one exact verified link recommendation and `Next action: reconcile exact PRD link then run plan-only $cl-execute`; the parent must create and re-fetch the link before execution. The only allowed readiness exceptions are an explicitly recorded ticket intent to revive/remove dead code or resolve duplicate work, or the exact-ticket/session-level high-complexity override above; neither permits an `EXTREME` risk or another blocked readiness item. Use `GO_WITH_UI_PLAN_APPROVAL` only when `UI work: YES`, `UI design source: missing`, `Human UI plan approval: required`, and every non-UI readiness item is `PASS` or `NOT_APPLICABLE`; otherwise use `GO` only when `Human UI plan approval: not_required` or a current session-level plan-approval instruction is separately recorded. If `Split lineage: split_child` and the current ticket is too complex to execute directly because historical split shape is defective, return `ENGINEERING_BLOCKED` or `HUMAN_REVIEW_REQUIRED`, set `Blocker category: engineering` or `mixed`, set `Splittable: NO`, set ClosedLoop comment target to `none`, and explain that the ticket remains a single issue rather than being split or repaired. If a legacy split child has a product, duplicate, inactive-surface, external-doc, extreme-risk, or unrelated engineering blocker, return the normal blocker decision and keep engineering/operational routing private unless an explicit Product decision exists. Otherwise change it to `HUMAN_REVIEW_REQUIRED`, set ClosedLoop comment target to `none`, and surface the blocker privately to the user.
