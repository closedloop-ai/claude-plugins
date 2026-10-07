---
name: cl-find-related-tickets
description: Inspect the relevant code first to map the implementation blast area, then find ClosedLoop issue tickets related to a product area, behavior, requirement, incident, ticket, or pull request and give a brief evidence-based reason for each match. Use when auditing scope, finding potentially conflicting or missing work across projects and assignees, checking whether a freeze covers every relevant ticket, comparing discoveries with an approved ticket set, or looking for direct changes, dependencies, shared contracts, tests, and open-PR collisions. This is a read-only discovery skill and does not update tickets, comments, statuses, loops, code, or pull requests.
---

# Find Related ClosedLoop Tickets

Understand the code blast area before searching ClosedLoop. Then find relevant work without treating project, assignee, title, or age as a reliable scope boundary. Search broadly, verify narrowly, and return a concise report.

## Inputs

Extract these from the request when present:

- Area of concern: required. Accept product behavior, page, route, component, service, schema, API, workflow, ticket, PR, or incident.
- Repository or local checkout: optional input, but required to claim a code-grounded exhaustive result for an implementation concern. Resolve it from anchor metadata when omitted.
- Anchor artifacts: optional ticket, PRD, plan, PR, branch, file, or route.
- Known ticket set: optional. When supplied, report only newly discovered tickets unless the user requests the full inventory.
- Cutoff: optional. Use it to distinguish tickets that existed before and after a freeze or decision.
- Assignee or project filters: optional. Treat them as requested restrictions only; otherwise search all assignees and projects.
- Terminal-status inclusion: optional. Exclude completed and canceled issues by default.

Ask one concise clarification when the implementation repository or area cannot be resolved from the request, anchor metadata, or available checkouts. Do not replace the required code pass with guessed search terms.

## Safety

Remain read-only.

- Do not create or update documents, comments, relationships, statuses, goals, loops, branches, code, or PRs.
- Do not invoke execution, split, or blocker-routing workflows.
- Do not write workflow repo memory unless the user separately requests persistence.
- Never hardcode a ClosedLoop MCP tool prefix. The prefix depends on the user's local MCP connection name.
- Follow `cl-policy` host-capability rules when discovering ClosedLoop tools.
  Use `tool_search` only when the current host explicitly supports dynamic
  calls. In Codex CLI TUI, use already exposed MCP tools or the documented
  `codex mcp`, CLI/source, or authenticated API fallback. The TUI must not call
  `tool_search` merely to satisfy the graph requirement.
- Discover and use the read-only `closedloop-graph` MCP as the
  primary indexed discovery surface for ticket/PRD/plan lineage, dependencies,
  semantic matches, duplicates, PR overlap, and codebase intelligence including
  symbols, files, ownership boundaries, dependencies, call/data paths,
  co-change history, tests, and blast radius. Treat graph
  results as candidates only; re-fetch every reported ticket and material
  relationship from live ClosedLoop and verify code/PR claims against current
  repository and GitHub state. Use graph code intelligence to establish the
  implementation blast area, not only to search the ticket corpus. Never emit
  a dynamic graph tool call from Codex CLI TUI.
- If the available connection cannot support an organization-wide search, state the uncovered boundary and do not call the result exhaustive.

## Search Workflow

### 1. Resolve the implementation context

Before searching for related tickets:

1. Read anchor ticket or PR metadata only far enough to establish the intended behavior, repository, branch, and likely entry point.
2. Locate the current repository checkout. Read applicable `AGENTS.md` files and current repository documentation for the surface.
3. If the repository cannot be accessed, ask for its identity or path. If the user wants a partial search anyway, label it `not code-grounded` and do not call it exhaustive.
4. If the concern genuinely has no implementation surface, record `Code blast-area pass: not applicable` with the reason.

### 2. Inspect code and map the blast area

Complete this read-only code pass before running ClosedLoop candidate searches:

1. Find entry points with `rg --files` and `rg`: routes, page registrations, exported symbols, UI labels, handlers, jobs, events, schemas, and API names.
2. Read the implementation, not just filenames. Trace imports, callers, consumers, adapters, persistence, serialization, and transport boundaries in both directions.
3. Inspect tests, fixtures, migrations, feature flags, and guardrails that encode the current behavior.
4. Use targeted Git history and active PR metadata when they reveal renamed surfaces, recent ownership changes, or concurrent implementation.
5. Separate the result into:
   - Direct mutation surfaces likely to change.
   - Upstream and downstream dependency surfaces that could enable, block, or break the change.
   - Tests and guardrails that could preserve conflicting behavior.
   - Legacy names and product vocabulary useful for ticket search.
6. Record concrete path, symbol, route, contract, and behavior evidence. Do not infer a blast area from directory proximity or shared vocabulary alone.

Continue until the relevant control and data flow is understood well enough to explain why a change in each included surface can affect the concern.

### 3. Build the concern map

Derive a compact query set from the verified code blast area, the request, and anchor artifacts:

1. Literal product names, labels, slugs, and quoted phrases.
2. Verified routes, symbols, components, packages, files, services, tables, schemas, events, and API names.
3. Synonyms, former names, abbreviations, and neighboring product terminology.
4. Verified upstream inputs and downstream consumers.
5. Behavioral contracts, tests, guardrails, migrations, and feature flags identified during the code pass.

Do not rely on an anchor title or product vocabulary alone. Every technical query group should trace back to code evidence.

### 4. Collect candidates broadly

Default to organization-wide, all-project, all-assignee issue discovery.

Begin with `closedloop-graph` searches and bounded expansions from anchors and
verified code identifiers. Continue until one expansion over material
candidate nodes yields no new relevant ticket, dependency, duplicate, or PR
collision, then use live ClosedLoop inventory/search to verify coverage and
current state. When a caller supplies a locked manifest or explicit bounded
scope, honor that boundary instead of reopening organization-wide inventory.

1. Paginate the issue inventory when list tooling permits. Keep `TRIAGE`, `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, and `BLOCKED`; exclude `DONE` and `CANCELED`.
2. Run multiple full-text searches over the concern map. Search documents and, when useful, comments and pull requests.
3. Search exact identifiers and quoted phrases separately from broader conceptual terms.
4. Expand from anchor artifacts through `PRODUCES`, `BLOCKS`, and `RELATES_TO` relationships in both directions.
5. Search old and current projects. A weekly project boundary or a different assignee is not evidence of irrelevance.
6. Deduplicate candidates by issue slug.

Use PRDs and plans as evidence sources and expansion nodes. Report them as results only when the user explicitly asks for non-ticket artifacts.

### 5. Verify each plausible candidate

Fetch full details only for plausible candidates. Inspect:

- Current title, body, acceptance criteria, status, assignee, project, repository snapshot, and update time.
- Comments that add, narrow, supersede, or unblock scope.
- Parent, child, blocking, and related artifact links.
- Linked or mentioned PR state and implementation surface when available.
- The previously mapped code blast area, plus targeted Git history or GitHub evidence when the ticket language is insufficient to prove a collision.

Resolve each result's project to its user-facing `PRO-*` slug. When ticket metadata supplies only a project UUID, use the project read capability to obtain the slug. Never substitute a project UUID or project name for the slug.

Resolve and report each ticket's current assignee display name. When no assignee exists, use `Unassigned`. Never display an internal user UUID in place of the assignee's name.

Classify a ticket with one primary relation:

- `DIRECT_SURFACE`: changes the area itself.
- `SHARED_CONTRACT`: changes data, schema, API, or behavior consumed by the area.
- `DEPENDENCY`: explicitly or functionally blocks, enables, or sequences the area.
- `TEST_GUARDRAIL`: tests or guardrails preserve behavior that the concern would change.
- `OPEN_PR_COLLISION`: active implementation overlaps the same code or product surface.
- `DUPLICATE_OR_SUPERSEDED`: describes substantially the same outcome or obsolete competing scope.

A title keyword is not evidence. For an indirect match, identify the concrete causal path. Reject generic vocabulary matches, unrelated repositories, contextual mentions without implementation impact, and stale historical work unless terminal tickets were requested.

If evidence is suggestive but incomplete, place the ticket under `Needs verification`; do not present it as confirmed.

### 6. Check coverage

Before reporting:

1. Confirm the code pass covered direct mutation, upstream/downstream dependency, and test/guardrail surfaces.
2. Confirm pagination or continuation cursors were exhausted for every inventory/search path used.
3. Confirm all concern-map query groups were searched.
4. Confirm direct links from every anchor and confirmed candidate were inspected when link tooling is available.
5. Compare against the known ticket set exactly. Do not repeat known tickets in a new-findings report.
6. Confirm every reported ticket is grouped under a resolved `PRO-*` project slug.
7. Confirm every reported ticket includes its current assignee display name or `Unassigned`.
8. Note any inaccessible code, comments, documents, repositories, or PR data that limit confidence.

## Output

Keep explanations brief and self-contained. Use returned `webUrl` values; never construct ClosedLoop URLs.

```markdown
**Coverage**
Searched <scope>; statuses <statuses>; repository <repo or all>; cutoff <date or none>. <Any limitation.>

**Code blast area**
Direct: <concise paths/symbols/behaviors>. Dependencies: <concise upstream/downstream surfaces>. Guardrails: <concise tests/flags/contracts>.

**New related tickets**

### PRO-123
| Ticket | Status | Assignee | Relation | Why it is related |
|---|---|---|---|---|
| [FEA-123](webUrl) | TODO | Name | DIRECT_SURFACE | Changes the branch-detail comments rail whose state-preservation behavior is in scope. |

Needs verification:

| Ticket | Status | Assignee | Why uncertain |
|---|---|---|---|
| [FEA-456](webUrl) | TRIAGE | Name | Mentions the same API, but the ticket does not identify which consumer is changing. |

### PRO-456
| Ticket | Status | Assignee | Relation | Why it is related |
|---|---|---|---|---|
| [FEA-789](webUrl) | BLOCKED | Name | DEPENDENCY | Owns the shared branch-event contract consumed by the affected page. |
```

Group both confirmed and uncertain tickets beneath their respective project slug. Include the current assignee for every ticket, including uncertain matches; use `Unassigned` when applicable. Omit empty project subsections and empty report sections. If a known set was supplied and no additional matches are verified, say `No new related tickets found.` Do not include the previously approved list merely for completeness.

## Invocation Examples

```text
$cl-find-related-tickets Branches list and branch details work in symphony-alpha. Known set: FEA-100, FEA-101. Report only newly found nonterminal tickets.
```

```text
$cl-find-related-tickets Find all active tickets related to unanchored comments created through MCP or API, across every project and assignee.
```
