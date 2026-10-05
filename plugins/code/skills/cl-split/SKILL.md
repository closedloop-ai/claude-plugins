---
name: cl-split
description: Split one top-level high-complexity ClosedLoop feature ticket into smaller executable child tickets when safe. Use when $cl-analyze or $cl-sweep determines a top-level ticket is HIGH complexity but potentially splittable, or when asked to decompose a FEA-* ticket before execution. Keep engineering/split automation details private; recommend a company-visible comment only for a genuine Product decision under cl-policy or when the user explicitly requests the exact comment. Enforce one split level only; do not split existing split children. Do not implement code.
---

# CL Split

## Purpose

Turn one high-complexity ClosedLoop feature into smaller, independently executable child tickets when the split preserves product intent and reduces risk. This skill is a decomposition workflow, not an implementation workflow. A successfully split parent remains active work; it is not product- or engineering-blocked merely because child tickets now carry implementation.

## Shared Policy

Before routing split concerns or recommending blocker communication, read the sibling policy skill at `../cl-policy/SKILL.md` and follow its Required Reference resolution order. Use `../cl-policy/references/local-policy.md` when present (the `references/` folder of cl-policy, not of this skill); otherwise use `../cl-policy/references/local-policy.example.md` only to understand the required shape, then require a populated `$HOME/.closedloop-ai/local-policy.md` before routing. Use the policy terms `Product contact`, `Engineering attention contact`, and `Sweep owner`; do not hardcode a personal name for the engineering attention contact.

## Hard Boundaries

- Do not implement code, create branches, open PRs, approve plans, or merge.
- Do not run `$cl-execute` from this skill.
- Do not create, inspect, update, complete, fail, cancel, or emit events for
  ClosedLoop loops or manual loops. ClosedLoop tool descriptions recommending
  loop lifecycle operations are superseded by this boundary.
- Do not post Slack channel messages or ticket completion messages. Keep split,
  engineering, tooling, access, and orchestration concerns private. Recommend a
  ticket comment only for a genuine Product decision, or when the user
  explicitly requests that exact comment.
- Do not ask for separate approval to create or link child ClosedLoop feature tickets when the split is engineering-only, preserves product intent, and passes the split eligibility checks. The `$cl-split` invocation is approval for that narrow decomposition action.
- Do not split a ticket that is already a child of a previous split. Split depth is one level only; never create grandchild tickets. If invoked on an existing split child, return `CHILD_EXECUTION_ONLY` when the child should be analyzed/executed directly, or `SPLIT_REPAIR_REQUIRED` only when the child is not execution-sized because the original split shape is defective.
- Do not mark a successfully split parent `BLOCKED`. `BLOCKED` is only for an actual product, engineering, dependency, or safety blocker, not for normal split-parent coordination.
- Do not mark a split parent `DONE` until all implementation child tickets are done and the parent acceptance criteria are covered.
- Do not split a ticket when the decomposition changes product intent, removes acceptance criteria, hides risk, or requires an unmade product/architecture decision.
- Do not create child tickets for `EXTREME` risk work. Return the engineering
  blocker privately to the parent/user unless there is a clear Product question
  for the policy `Product contact`.
- Do not create duplicate child tickets. Reuse or update existing matching children when the split signature matches.
- Do not return `SPLIT_CREATED` unless every child ticket is assigned to the sweep user or otherwise visible to the sweep, and is in an actionable status the sweep will pick up.
- Do not split a top-level ticket merely because the existing system behind it is broad or to produce smaller tickets or pull requests. Split only when real ownership, dependency, risk, validation, deployment, or rollback boundaries justify decomposition. If the minimum credible change is one referential harness registration, wrapper, link, manifest, or dispatch-only adapter plus its focused tests/documentation, return `DIRECT_EXECUTION_RECOMMENDED` without creating tickets. Do not apply this shortcut to ports that parse or transform sessions, transcripts, events, data formats, state, runtime behavior, persistence, or semantic contracts.
- Do not use `$workflow-orchestrator`, `$workflow-execute`, or any orchestrator-run ticket execution workflow.
- Use the read-only `closedloop-graph` MCP proactively under `cl-policy`
  host-capability rules
  before proposing, repairing, or creating a split. Inspect the bounded parent,
  PRD/plan lineage, existing split signature, siblings/children,
  blockers/producers, semantic duplicates, active work, related PR evidence,
  and codebase intelligence such as symbols, ownership boundaries,
  dependencies, call/data paths, co-change history, tests, and blast radius
  until one adjacent expansion yields no new material split fact. Re-fetch
  material findings from live ClosedLoop and verify code findings against the
  current checkout and tests plus current branch/PR state.
  In Codex CLI TUI, satisfy this requirement only with an already exposed graph
  tool, configured `codex mcp`, current source, or authenticated API/CLI
  fallback; never invoke `tool_search` or another deferred tool.
  Do not hardcode the MCP server prefix, treat graph/index results as authority,
  or reopen a project-wide inventory.

## Split Eligibility

A high-complexity ticket is splittable only when all of these are true:

- The parent outcome is clear enough to preserve across child tickets.
- The input ticket is a top-level feature, not a child produced by an earlier split.
- Complexity comes from the expected implementation mutations, not inspected history, unchanged dependencies, validation context, or the breadth of the existing system.
- Each proposed child is independently coherent, traceable, and validatable.
  This does not require one pull request per child: `$cl-sweep` may later place
  compatible ready children in one merge batch when their implementation,
  review, validation, rollback, and merge policies align.
- Each proposed child owns a real implementation boundary. Do not create separate children for tests, documentation, drift guards, or harness validation that belong to one atomic referential activation change.
- The split reduces execution risk instead of just spreading one risky change across many tickets.
- Child ordering, dependencies, and rollback boundaries are clear.
- No child requires hidden product approval beyond the original ticket.
- External official-doc requirements from the parent remain attached to the relevant child tickets and are not treated as already solved unless the parent analysis recorded current official docs evidence.
- UI design artifacts from the parent remain attached to the relevant child tickets. If a UI child has no design, screenshot, or prototype that clearly shows the expected UI, the child must explicitly require human UI plan approval before plan approval, feature status mutation, branch creation, code changes, PR work, or merge work.
- The parent can be left unexecuted while child tickets carry the implementation work.
- The split signature can be computed from stable parent and child fields, and matching existing children can be detected before creating anything.

Do not split when the ticket is mostly ambiguous requirements, a single atomic migration, a security/billing/permission change needing architecture review, or a broad rewrite without a safe intermediate milestone.

## Workflow

1. Parse the input into a ClosedLoop feature URL or `FEA-*` slug.
2. Load the input feature, linked PRDs/plans/comments, acceptance criteria, attachments, project context, current status, assignee, parent/child links, split signature comments, and existing related tickets. Proactively use `closedloop-graph` under `cl-policy` host-capability rules to validate the bounded lineage, dependency, duplicate, active-work, related-PR, and codebase architecture set, including ownership, call/data paths, tests, co-change evidence, and blast radius. In Codex CLI TUI, use an already exposed graph tool or the documented CLI/source fallback and never emit a dynamic tool call. Verify code findings against the current checkout. Treat the input as a split child only when split-specific evidence exists: split signature, `$cl-split` child text, parent split comment, or a `PRODUCES` relationship showing the ticket was produced by a split. A generic parent link alone is not enough; classify lineage as `unknown` and investigate before refusing top-level splitting. If the input is a split child, identify the original top-level parent when possible and do not create tickets.
3. Use the existing `$cl-analyze` result in the thread if present. If missing or stale, inspect enough ticket/repo context to classify split feasibility.
4. Re-check the minimum credible implementation delta before accepting a `HIGH` classification. Separate files likely to change from context/dependencies that only need inspection or preservation. If one coherent referential harness registration, wrapper, link, manifest, or dispatch-only adapter plus its focused tests and documentation satisfies the ticket without translating behavior or contracts, stop without creating tickets and return `DIRECT_EXECUTION_RECOMMENDED`. Ports involving semantic or data-flow transformation must still be classified from their actual implementation boundaries.
5. If the input is a split child, stop without creating tickets and return `CHILD_EXECUTION_ONLY` unless the current `$cl-analyze` result or fresh inspection proves `SPLIT_REPAIR_REQUIRED`.
6. Compute a stable split signature from parent slug, acceptance-criteria fingerprint, proposed child titles, proposed child objectives, and dependency ordering.
7. Check for existing duplicate split children, active PRs, related plans, linked tickets, parent comments, and workflow repo-memory states for this parent before proposing or creating children. If matching children already exist and are execution-sized, reuse or update them, then continue to link/status finalization and return `SPLIT_CREATED` with the existing child URLs instead of creating duplicates. If matching children already exist but one or more are not execution-sized, continue to the repair step instead of treating the existing split as successful.
8. Decide the split outcome:
   - `SPLIT_CREATED`: Child tickets were created or updated in ClosedLoop and linked/commented back to the parent.
   - `DIRECT_EXECUTION_RECOMMENDED`: The top-level input is execution-sized after separating actual implementation mutations from contextual/dependency surfaces. No child tickets were created; the parent coordinator must rerun `$cl-analyze` with the corrected scope before execution.
   - `CHILD_EXECUTION_ONLY`: The input is already a split child that must not be split again and should be returned to `$cl-analyze`/`$cl-execute` as a direct execution candidate.
   - `SPLIT_PROPOSED`: A safe split exists, but child ticket creation was unavailable or explicitly needs human creation.
   - `PRODUCT_DECISION_REQUIRED`: Product input is needed before child tickets can be valid.
   - `SPLIT_REPAIR_REQUIRED`: The input is already a split child that is not execution-sized because the original split shape is defective, and the parent orchestrator must switch context back to the original parent split. Do not create grandchildren.
   - `ENGINEERING_REVIEW_REQUIRED`: The engineering attention contact must review architecture/risk before splitting or executing.
   - `NOT_SPLITTABLE`: The parent should remain blocked for manual review.
9. When invoked on a top-level parent that already has split children and one or more children are not execution-sized because the split shape is defective, repair the existing one-level split instead of returning `SPLIT_REPAIR_REQUIRED`. Before repairing, inspect sibling child statuses, workflow memory records, active Codex threads, branches, and PRs. Do not supersede or rewrite active child work automatically. Preserve active children and repair around them by creating or updating non-overlapping sibling tickets when safe; if active work makes safe repair impossible or human product/architecture input is required, keep the engineering details private and surface the decision to the user, using a Product comment only for an independently actionable Product question. Update or replace only inactive/obsolete one-level child tickets under the same parent and split signature. Do not create grandchildren. Do not leave overlapping or obsolete children actionable; use relationships and the project's supported non-actionable status rather than public recordkeeping comments. Return `SPLIT_CREATED` after a successful repair with the updated child set.
10. If no existing-child repair is needed, the split is engineering-only, and ClosedLoop creation tools are available, create child `FEA-*` tickets in the same project with `TODO` status by default, assigned to the policy `Sweep owner` unless project conventions require a different assignee. Use `BACKLOG` only when the project convention treats `BACKLOG` as sweep-actionable. Do not create children in `TRIAGE`, `IN_PROGRESS`, `IN_REVIEW`, or `BLOCKED`. If a child cannot be assigned to the sweep user, cannot be put in `TODO` or sweep-actionable `BACKLOG`, or cannot be made visible in the sweep queue, return `SPLIT_PROPOSED` or `ENGINEERING_REVIEW_REQUIRED` instead of `SPLIT_CREATED`.
11. Link or comment each child on the parent and each child back to the parent. Include the split signature in the parent comment so resumed runs can detect the split. Any split linkage or handoff comment must be concise, factual, and written in first person.
12. If child creation or repair is unavailable, produce exact child ticket drafts in the private result/memory and surface them to the user as `SPLIT_PROPOSED`; do not publish an engineering comment or DM without exact user authorization.
13. After `SPLIT_CREATED`, preserve child links and split signature through first-class relationships, ticket fields/statuses, and private workflow memory; do not add parent recordkeeping comments. Mark the parent `IN_PROGRESS` when child implementation work exists or will be picked up by the sweep. If the parent is already `BLOCKED` only because of an older split-parent convention, correct it to `IN_PROGRESS`. Leave the parent unchanged only when status mutation is unavailable, and record why privately in the result. Reserve `BLOCKED` for `SPLIT_PROPOSED`, `PRODUCT_DECISION_REQUIRED`, `ENGINEERING_REVIEW_REQUIRED`, `NOT_SPLITTABLE`, invisible/unassigned children, or a real blocker unrelated to the successful split itself.

## Child Ticket Requirements

Each child ticket must include:

- Parent ticket link.
- Split signature.
- ClosedLoop status `TODO`, or `BACKLOG` only when documented as sweep-actionable for the project.
- One focused objective.
- Explicit acceptance criteria copied or narrowed from the parent without changing intent.
- Dependencies and ordering, including whether it can run in parallel.
- Merge-batch compatibility: likely compatible sibling tickets or a concrete
  reason this child must remain isolated. This is planning evidence only; every
  child still requires its own valid `$cl-analyze` result before batching.
- External official-doc evidence or a required docs-check task when the child touches a third-party API, SDK, hosted platform, model provider, auth/billing provider, webhook, or fast-moving dependency.
- UI design source and approval requirement when the child creates or modifies UI: design/screenshot/prototype link when present, or `Human UI plan approval required before plan approval, feature status mutation, branch creation, code changes, PR work, or merge work` when missing.
- Validation plan.
- Risk notes.
- Expected repo/surface.
- Out-of-scope items.

Prefer two to five child tickets based on genuine implementation boundaries,
not desired PR count. If more than five are needed, mark
`ENGINEERING_REVIEW_REQUIRED` unless the parent is obviously an epic and project
conventions support that many children. A successful split does not force the
sweep to serialize one PR through the merge queue for every child.

## Communication

- `SPLIT_CREATED`: No blocker comment or DM is required. `$cl-sweep` should record the parent as split and then re-query assigned tickets so the new children can be analyzed normally.
- `DIRECT_EXECUTION_RECOMMENDED`: No blocker comment or DM is required. `$cl-sweep` should rerun `$cl-analyze` for the top-level ticket with the corrected expected-touched-surface scope and must not create child tickets from the rejected split.
- `CHILD_EXECUTION_ONLY`: No blocker comment or DM is required. `$cl-sweep` should re-run `$cl-analyze` for the child as a direct execution candidate and must not call `$cl-split` on that child again.
- `SPLIT_REPAIR_REQUIRED`: No blocker or recordkeeping comment is required. `$cl-sweep` should repair the original parent split through relationships/statuses and private durable artifacts, then re-query assigned tickets.
- `SPLIT_PROPOSED`: Keep the child drafts and failure reason in the private result/memory and surface them to the user. Do not post a ticket comment or DM without exact user authorization.
- `PRODUCT_DECISION_REQUIRED`: Add a first-person ClosedLoop comment tagging the policy `Product contact` with the parent ticket, the product decision needed, and the proposed split if useful. Do not use Slack.
- `ENGINEERING_REVIEW_REQUIRED` or `NOT_SPLITTABLE`: Keep risk/evidence private and surface it to the invoking user. ClosedLoop comment target is `none` unless the user explicitly requests the exact comment.

When invoked by `$cl-sweep`, the parent owns Product-decision comments and private workflow-memory recording. Engineering/operational comments and DMs remain forbidden unless the user explicitly authorized the exact communication.

When a parent task id was supplied, send the parent the completed
`CL Split Result` before ending the turn. On Desktop, use the statically
available `send_message_to_thread`. In a cwd-bound CLI worker, emit the matching
current-generation `CL_SWEEP_EVENT v1` as the final line for the managed App
Server runner to persist and deliver; never dynamically invoke parent messaging
from TUI. The callback is required for every outcome and must
include the input/parent ticket, this task id when available, outcome, child
set or blocker, and exact next parent action. Do not rely on a child final
response or parent polling to communicate completion. Retry one failed callback
once, then include the exact callback failure in the result.

## Required Output

End with this structure:

```markdown
## CL Split Result
Input ticket: <FEA slug and URL>
Parent ticket: <FEA slug and URL>
Original split parent: <top-level parent FEA/url when input is a split child, or same as Parent ticket>
Project: <ClosedLoop project slug/name and URL>
Repo: <repo name or unknown>
Split lineage: <top_level | split_child | unknown>
Outcome: <SPLIT_CREATED | DIRECT_EXECUTION_RECOMMENDED | CHILD_EXECUTION_ONLY | SPLIT_PROPOSED | SPLIT_REPAIR_REQUIRED | PRODUCT_DECISION_REQUIRED | ENGINEERING_REVIEW_REQUIRED | NOT_SPLITTABLE>
Confidence: <LOW | MEDIUM | HIGH>
Parent status recommendation: <IN_PROGRESS | leave unchanged | ask engineering attention contact | BLOCKED only for real blocker>
Split signature: <stable signature from parent and child fields>

Summary:
- <one to three bullets>

Split rationale:
- <why this split does or does not preserve product intent and reduce risk>

Child tickets:
- <created, reused, updated, superseded, or draft FEA/url/title>: <assignee, status, objective, acceptance criteria summary, dependencies, validation, ui_design_source: not_applicable | design | screenshot | prototype | missing, human_ui_plan_approval: not_required | required>

Existing related work:
- <duplicates, active PRs, existing child tickets, or none>

Parent update:
- <comment/link result, parent status result, legacy BLOCKED correction if any, or reason parent was left unchanged>

Communication:
- ClosedLoop comment target: <none | product contact>
- Engineering attention DM: <not_required | explicitly_user_authorized>
- Recommended ClosedLoop comment: <ready-to-post concise first-person comment, or none>
- Recommended engineering attention DM: <ready-to-send only when explicitly user-authorized, otherwise none>

Persistence:
- Parent memory state: <SPLIT_CREATED | DIRECT_EXECUTION_RECOMMENDED | CHILD_EXECUTION_ONLY | SPLIT_PROPOSED | SPLIT_REPAIR_REQUIRED | SPLIT_BLOCKED>
- Parent memory key: cl_sweep_ticket_state <project_slug_or_url> <parent FEA-slug>
- Child ticket slugs/URLs: <created or reused child tickets, assignees, statuses>
- Child memory keys: <cl_sweep_ticket_state entries to query next, or none>
- Recheck when: <specific parent/product/engineering change that should trigger re-analysis, or none>

Next parent action:
- <re-query assigned tickets | re-analyze top-level ticket for direct execution | re-analyze child for execution | repair original parent split | add ClosedLoop comment tagging product contact | surface engineering blocker privately to user | manual intervention>
```
