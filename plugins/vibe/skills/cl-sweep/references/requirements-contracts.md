# Requirements Contracts

Use this reference whenever `$cl-sweep` selects, analyzes, executes, retries,
batches, or reconciles a ticket whose requirements contract can affect
PRODUCT_BLOCKED/HUMAN_REVIEW_REQUIRED routing, implementation safety, or
feature-unit compatibility. Read [Feature Unit Execution](feature-units.md) for
the one-PR boundary.

## Graph Intelligence

Discover and use `closedloop-graph` proactively, following cl-policy's
host-capability rules, for ticket selection, analysis, retry, and
direct-dependency reconciliation. Use it to traverse ticket-bounded PRD, plan,
legacy split lineage, blockers, producers, semantic matches, duplicate or overlap
candidates, related PR evidence, and codebase intelligence such as symbols,
files, ownership boundaries, dependencies, call/data paths, co-change history,
tests, and blast radius until one bounded adjacent expansion produces no new
material fact.

Treat graph results as discovery evidence. Re-fetch material facts from live
ClosedLoop and verify code findings against the current checkout, tests, and
current GitHub state. Do not hardcode the MCP server prefix. Do not reopen a
global inventory when a locked manifest remains valid. In Codex CLI TUI
sessions, never emit a dynamic tool call; use an already exposed graph MCP tool
or the documented CLI/source fallback.

## Contract Discovery

Resolve the applicable approved requirements PRD set per ticket. Do not assume
that one project-wide PRD package applies to every future sweep. Evidence can
come from direct ticket/PRD links, explicit inherited split-parent requirements,
explicit user/project designation, ticket text, a plan, a PR comment, a Slack
message, a prototype, or another exact requirement source.

A program may legitimately share common PRDs across all its tickets; otherwise
pass only each ticket's own applicable PRDs. `$cl-analyze` owns bounded read-only
discovery and validation of that contract, including proactive graph discovery
even when direct links exist. The parent may supply known candidates but must not
pre-decide that no PRD applies. Record `not_applicable` only when analysis
supports it with evidence.

Resolve and record this contract independently for every proposed feature
member before implementation dispatch. The combined feature manifest maps each
member's requirements and acceptance criteria to the shared functional outcome;
it never replaces or broadens them. A requirements conflict between members is
a feature-boundary blocker, not permission to omit a member or create separate
surface PRs.

A verified dependency between members may be marked `scheduled_in_unit` only
when one owner, branch, shared interface, implementation order, and integrated
acceptance proof show the dependency will be satisfied in the same PR. This
does not turn `BLOCKED` or `UNKNOWN` readiness into `PASS`. An external,
other-owner, out-of-scope, or unverified dependency remains blocking until live
evidence resolves it or the exact ownership/scope transfer is authorized.

When branch list, branch detail, branch metrics, selected-PR, Branch evidence,
date-window, denominator, partial/unavailable, zero/unavailable, or web/Desktop
Branch contracts are touched, require the worker to check the change against the
applicable PRD-600, PRD-601, and PRD-602 versions and exact requirement IDs. Do
not accept review feedback or implementation shortcuts that create drift from
those established requirements.

## Link Reconciliation

Do not execute while the requirements-contract result is ambiguous.
For `LINKED`, `INHERITED`, or evidenced `NOT_APPLICABLE`, record the validated
contract and continue.

For `MISSING_LINK`, require one exact `source -> relationship type -> target`
recommendation backed by current ClosedLoop evidence. Re-fetch the source,
target, and their direct relationships. If the exact relationship already
exists, record it and continue. Otherwise `$cl-sweep` creates it exactly once
using ClosedLoop relationship tooling, then re-fetches and verifies the exact
relationship id, direction, and type.

Write and query-verify a superseding workflow-memory record with the PRD
slug/version, requirement IDs, source evidence, relationship id, direction, and
type before continuing. If the recommendation is ambiguous, omits the
relationship type, conflicts with live state, or cannot be created and verified,
do not execute; route it as a requirements or Product blocker under
the current communication policy. Never guess `PRODUCES`, `RELATES_TO`, or
another relationship type, and never let an execution worker create the link.

## Drift Routing

When analysis or execution rejects, punts, or escalates a bug because fixing it
would violate established requirements, the routed explanation must identify
exactly where the requirement is stated and which requirement would be violated.
The cited authority might be a PRD requirement, prototype location, PR comment,
Slack message, plan, ticket text, or another exact source the ticket author can
review.

## Product Answer Discovery

Before `$cl-analyze`, `$cl-sweep`, or `$cl-execute` returns `PRODUCT_BLOCKED`,
suggests a Product contact, or drafts a Product-decision comment, prove the
apparent Product question has not already been answered.

Use a bounded but serious search:

- Re-read the current ticket body/version, acceptance criteria, attachments,
  linked PRDs, plans, comments, sibling tickets, direct parent/child links,
  blockers, producers, design links, screenshots, prototypes, and
  related product/design artifacts.
- Use closedloop-graph as a primary discovery surface for PRD and plan lineage,
  sibling tickets, semantic facts, prior blockers, duplicates, superseding
  decisions, related comments/plans, and product terms from the apparent
  question. Follow material adjacent evidence until one bounded expansion yields
  no new decision-bearing fact, then verify material facts against live
  ClosedLoop artifacts.
- Treat linked or related implementation plans as authoritative decision
  records when they contain explicit accepted scope, exclusions, section
  decisions, or requirements mapping. A plan section that already answers the
  question must be cited and applied, not routed back to Product.
- Search workflow repo memory for the ticket, siblings, parent PRDs/plans, and
  named product terms. Do not repeat a prior Product blocker that was later
  answered in comments, plan text, PRD revisions, or explicit user/session
  instructions.

If current user/session context says the Product contact is unavailable or
out-of-office, do not reflexively tag that contact. First use existing
authoritative answers. If none exists, set ClosedLoop comment target to `none`
by default and surface the exact missing decisions privately to Daniel/current
user or the engineering attention route unless the user explicitly authorizes
that exact Product comment.

`PRODUCT_BLOCKED` is valid only when this discovery has been recorded and the
missing decision is genuinely product-owned, user-visible or
requirements-affecting, not already answered, and not resolvable as an
engineering contract, compatibility, validation, ownership, or implementation
choice.
