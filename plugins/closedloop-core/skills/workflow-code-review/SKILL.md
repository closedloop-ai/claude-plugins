---
name: workflow-code-review
description: "Run a worker-backed code review using the workflow prompt pack's strongest review lenses: approach correctness, architecture ownership, correctness, guardrails, validation, compatibility, and security. Use when asked to review a PR, branch, diff, or uncommitted changes with workflow-level rigor."
---

# Workflow Code Review

Use this skill when the user wants a rigorous code review that borrows the best review fundamentals from the workflow prompt pack without running the goal workflow itself.

This skill reviews code, not plans. It must not create implementation plans, approval gates, manual loops, worktrees, PR lifecycle polling, commits, pushes, PR comments, or merges unless the user separately asks for that work.

## Harness notes

- Codex: invoke as `$workflow-code-review`. Launch each reviewer worker by
  spawning a subagent whose instructions are that lane's section below plus the
  target, requirement, and graph packets.
- Claude Code: invoke as `/closedloop-core:workflow-code-review`. Launch each reviewer
  worker with the Agent (Task) tool, using a general-purpose subagent briefed
  the same way.
- Paths like `references/...` are relative to this skill's folder, not the
  repository under review. The bundled prompt pack resolves from this skill's
  folder in both harnesses; it never depends on `CODEX_HOME`, `~/.codex`, or
  `~/.claude`.
- MCP tool names can differ by harness (for example `get_document` or
  `get-document`). Use whichever name the session exposes for the tool this
  skill names.

## Role Boundary

The coordinating agent is an orchestrator only. It must stay lean:

- gather the target PR, branch, diff, plan URL, decision table, and repo guardrails needed to brief reviewers
- launch independent reviewer workers
- collect and deduplicate findings
- present the consolidated review

The orchestrator must not perform the substantive review itself. If worker/subagent delegation is unavailable or not permitted in the current environment, stop and say that this skill requires worker-backed review instead of silently doing an inline review.

## Prompt Pack Discovery

Before reading references or launching workers, read `WORKFLOW_PROMPT_PACK_ROOT` from the environment. If it is set, verify the path contains `orchestrator.md` and use it as the prompt pack root. If it is unset, or set to a path without `orchestrator.md`, use the prompt pack bundled with this skill: `references/prompt-pack/`, resolved from this skill's installed location. Verify the bundled root contains a `sections/` directory; it carries only the lens files the lens map names, so it has no `orchestrator.md`. When an invalid `WORKFLOW_PROMPT_PACK_ROOT` was ignored, note that in the review coverage output. If neither path is available, continue without prompt pack lenses and note the gap in the review coverage output.

When the prompt pack root is available, section references in [review-lens-map.md](./references/review-lens-map.md) such as `sections/planning-quality-gate.md` resolve relative to that root.

## SOUL Voice Profile

After resolving the prompt pack root, check for `SOUL.md` at `<prompt-pack-root>/SOUL.md`. If it exists, read it before launching workers.

Pass the full `SOUL.md` content verbatim only to workers or steps that may draft, post, or send user-visible text, including PR comments, review summaries, Slack replies, or other outbound messages. Do not pass it to pure analysis workers that are not responsible for mimicking the user's voice. Do not summarize, rewrite, trim, or reinterpret it into a separate voice packet.

`SOUL.md` is assumed to be written correctly as a voice, stance, and style file. It controls wording for user-visible text only. Keep AGENTS, repo guardrails, fetched requirements, review lenses, severity evidence, and this skill's findings-first output contract authoritative. If `SOUL.md` conflicts with concrete code evidence or this skill, this skill and the code evidence win.

If `SOUL.md` is missing, continue normally and record `SOUL.md: not found` in Review Coverage. If present, record `SOUL.md: <path>` in Review Coverage. Do not mention `SOUL.md` in PR comments unless the user explicitly asks for provenance.

## Required References

Before launching workers, read [review-lens-map.md](./references/review-lens-map.md).

If the workflow prompt pack is available, use the referenced workflow files as review lenses only. Do not execute their planning, approval, upload, loop, notification, PR lifecycle, or finalization instructions.

## Inputs

Accept any of:

- PR URL or number
- branch name or local diff
- uncommitted changes
- explicit file list
- optional work item, plan URL, decision-table path, or acceptance criteria

When an approved plan or decision table is provided, review the code against it. When neither is provided, infer the intended behavior from the PR description, commits, tests, issue/work item text, and changed code.

## Requirement Grounding

For PR reviews and branch reviews, inspect only the PR title, PR body, and branch name for ClosedLoop slugs or URLs, including:

- `FEA-*`
- `PRD-*`
- `PLN-*`
- ClosedLoop document URLs
- ClosedLoop implementation-plan URLs

Do not scan commit messages, linked issues, unrelated project documents, or broad repository history for requirements unless the user explicitly asks.

Classify ClosedLoop references before fetching:

- Primary requirement references are `FEA-*`, `ISS-*`, `PRD-*`, `PLN-*`, ClosedLoop document URLs, and implementation-plan URLs from the PR title, branch name, or explicit body phrases such as "fixes", "closes", "implements", "requires", "depends on", "acceptance", or "plan".
- If no title or branch reference exists, treat the first body slug or URL as primary.
- Other body mentions are supporting references.

If a slug or URL is found, fetch primary requirement references through ClosedLoop MCP before launching reviewer workers. For the standard ClosedLoop MCP `get_document` tool, pass the slug or UUID as `documentId` exactly, for example `get_document({ "documentId": "ISS-8254", "includeContent": true })`; do not use an `identifier` argument. Fetch supporting references when available, but if a supporting reference fails and at least one primary requirement reference fetched successfully, record the failed supporting reference in `open_questions_or_blockers` and continue the review. If a fetched feature or PRD has an obvious linked implementation plan available through ClosedLoop metadata or artifact links, fetch that linked plan too. Do not create, update, or upload any ClosedLoop documents.

If a primary requirement reference fetch fails, every requirement reference fetch fails, or artifact fetching fails before any primary grounding succeeds, report the blocker. Continue only when the user asked for a diff-only review, explicitly approves continuing without requirement grounding, or only supporting references failed after primary grounding succeeded.

Pass a requirement packet to every worker:

```text
requirement_sources:
  - slug_or_url: <FEA/PRD/PLN/url>
    title: <title or unknown>
    type: <feature|prd|plan|unknown>
    fetched: <yes|no>
    summary: <short requirements or plan summary>
    acceptance_criteria: <criteria summary or none found>
linked_plan:
  slug_or_url: <plan slug/url or none>
  fetched: <yes|no|not_applicable>
out_of_scope: <explicit exclusions from requirement artifacts or none found>
open_questions_or_blockers: <requirement blockers or fetch blocker>
```

Workers must use the requirement packet to check explicit acceptance criteria, not substitute their preferred product behavior for the requested change. Treat an apparent requirement mismatch as a finding only when a cited criterion and a reachable code path demonstrate the contradiction.

## Target Resolution

Review exactly the target the user requested. Do not silently broaden from a PR to local changes, from a branch diff to unrelated uncommitted work, or from a file list to the whole repository.

Common target shapes:

- "Review all uncommitted changes": review staged changes, unstaged tracked changes, and untracked non-ignored files. Do not include already committed branch-only changes unless the user asks.
- "Review this pull request `<pr_url>`": review the PR head against its base, PR description, changed files, commits, checks, and review comments when available. Do not include unrelated local worktree changes.
- "Review this branch against `main`": review the branch diff from the merge base with the named base branch. Include local uncommitted changes only if the user asks.
- "Review these files": review those files and directly necessary surrounding call sites. Findings should still be anchored to the requested files or behavior changed by them.

If the requested target is ambiguous, ask one concise clarifying question before launching workers.

Before launching workers, create a target packet and pass it to every worker:

```text
target_kind: <uncommitted|pull_request|branch_diff|file_list>
base_ref: <base branch/sha if any>
base_sha: <resolved base sha if any>
head_ref: <head branch/sha if any>
head_sha: <resolved head sha if any>
diff_source: <command/API/source used>
included_files: <files in scope>
excluded_scope: <known out-of-scope changes, if any>
snapshot_time: <ISO timestamp when target was resolved>
snapshot_artifacts: <paths/checksums for frozen diffs, file contents, archives, or none>
validation_evidence_snapshot: <checks/artifacts/logs/screenshots/reports available at snapshot_time, or none>
plan_or_decision_table: <path/url or none>
requirement_packet: <requirement packet or none>
closedloop_graph_packet: <ClosedLoop graph intelligence packet or unavailable/not_applicable>
closedloop_graph_packet_path: <absolute path to full packet artifact, or none>
graph_review_focus: <orchestrator-derived graph focus packet, or pending until built>
guardrails: <AGENTS.md and local rules inspected>
```

When a worker or synthesis step may produce user-visible wording, append:

```text
soul_md: <SOUL.md path and full content, or not found>
```

## ClosedLoop Graph Intelligence

Gather ClosedLoop graph intelligence with this deterministic sequence after the target is pinned and before launching reviewers:

1. Discover the read-only `closedloop-graph` MCP by capability, not by a hardcoded server prefix. If the `closedloop-intel` skill is available and selected for this review, read it completely first; it is an instruction source for the same graph-backed routes, not a substitute for building the packet below.
2. If `get_routing_protocol` is unavailable, set `closedloop_graph_packet.routing_protocol` to `unavailable`, set every route section below to `skipped: graph_unavailable`, and continue without graph intelligence unless the user explicitly required graph-backed review.
3. Call `get_routing_protocol` once and record its section, sha/date, and any unavailable-tool caveats in `routing_protocol`. Use the returned protocol as the route authority for the remaining calls.
4. Never use local closedloop-intel checkouts, local ledger files, direct database access, or handwritten graph queries when a routed graph tool exists.
5. Build deterministic seeds only from the pinned target packet:
   - `documentSeeds`: ClosedLoop slugs or URLs already found during Requirement Grounding.
   - `fileSeeds`: every path in `included_files`.
   - `symbolSeeds`: changed exported functions, classes, types, commands, route handlers, schema objects, or configuration keys visible in the pinned diff or directly necessary surrounding context. If changed symbols are ambiguous, leave `symbolSeeds` empty instead of searching broadly.
6. Requirement context: for each `documentSeeds` item, call `ticket_detail` if the live protocol and tool list expose it. If the live protocol names a replacement exact ticket-detail route, call that replacement route and record the route name. If no exact ticket-detail route is exposed, record `requirement_context: skipped: route_unavailable`. Do not fetch unrelated requirements discovered from graph results.
7. Scope overlap: if `documentSeeds` is empty, record `scope_overlap: skipped: no_document_seeds`. Otherwise, call `query_collisions` only when the live tool schema supports a document-seeded argument such as `slug_or_uuid`, `slug`, `document_slug`, or `query`; pass only the exact document seed and a small `limit`. If `query_collisions` is unavailable or exposes only an unseeded global query shape, record `query_collisions: skipped: route_unscoped_for_target` and call `search_nodes` with only the exact slug and fetched title when that fallback is exposed. Call `search_memory_facts` only when a relationship needs a quotable fact. If none of those routes is exposed, record `scope_overlap: skipped: route_unavailable`.
8. Repo graph status: call `code_projects` once for the reviewed repository if the live protocol and tool list expose it. Record the graph branch, head SHA, freshness/status, and whether the graph is default-branch/main indexed. If `code_projects` is unavailable or the repo is missing from the graph, record `repo_graph: unavailable` and skip steps 9-11.
9. Blast radius: for each `fileSeeds` path and each `symbolSeeds` item, call `code_symbols` first if the live protocol and tool list expose it. If `code_symbols` is unavailable, use exact `fileSeeds` paths only and record `blast_radius.symbol_resolution: skipped: route_unavailable`. Use resolved symbol/path identities as inputs to `code_callers` when that route is exposed. Call `code_snippet` only for the small source excerpts needed to disambiguate ownership or caller behavior. Call `blast_radius_tickets` for changed file paths only when that route is exposed. Record a `skipped: route_unavailable` entry for every unavailable blast-radius route. Do not add callers or related files to `included_files`.
10. Test impact: for each `fileSeeds` path, call `code_tests_for` if the live protocol and tool list expose it. If it is unavailable, record `test_impact: skipped: route_unavailable`. Record returned tests as candidate existing coverage to inspect in the pinned source snapshot or validation evidence. Do not run tests from this skill.
11. Architecture context: call `code_architecture` once for the reviewed repository or changed top-level package/module if the live protocol and tool list expose it. If it is unavailable, record `architecture_context: skipped: route_unavailable`. Use returned architecture facts only to identify candidate ownership boundaries, entrypoints, and source-of-truth locations for the worker lanes.

Graph intelligence is advisory review context. It must not broaden the pinned review target, replace source inspection of the frozen PR diff, or create findings by itself. Code graph evidence is usually indexed from the default branch or main mirror, not the PR head, so every material graph hint must be verified against the pinned target packet, local source, frozen diff, or fetched requirement packet before it can become a finding.

Review workers use `closedloop-graph` because a diff-only review is naturally
local: it shows what changed, but it does not reliably reveal every production
caller, owner boundary, existing test, prior related ticket, stale requirement,
or trust boundary affected by the change. The graph gives each lane a cheap
indexed way to challenge its first impression before it settles:

- approach reviewers use it to find the source-of-truth module, nearby
  architecture boundary, or related ticket that may reveal a concrete
  production failure in the chosen surface.
- correctness and contract reviewers use it to find callers, consumers,
  exported symbols, and source snippets outside the diff that may still rely on
  the old behavior.
- guardrail and E2E reviewers use it to find existing tests and user-flow specs
  that should already cover, or should be updated for, the changed path.
- database reviewers use it to find persisted consumers, migrations, backfills,
  and downstream jobs that a schema or model change can silently break.
- security reviewers use it to find entrypoints, trust boundaries, command/file
  access paths, and prior related tickets that make an apparently local change
  reachable from untrusted users or other tenants.

Record graph gaps instead of blocking when graph tooling, a protocol-recommended route, or an indexed repo/file/symbol is unavailable, stale, truncated, or not relevant to the target. A graph gap is only a blocker when the user explicitly requested graph-backed review and no acceptable fallback exists.

Pass a ClosedLoop graph intelligence packet to every worker:

```text
closedloop_graph_packet:
  routing_protocol: <sha/date/section or unavailable>
  repo_graph: <repo/project/head_sha/index status if known, or unavailable>
  requirement_context: <ticket/detail/lineage facts used, or none>
  scope_overlap: <related slugs/facts considered, or none>
  blast_radius: <changed files/symbols, callers, snippets, related tickets, or none>
  test_impact: <candidate existing tests from graph, or none>
  gaps_and_caveats: <unavailable/stale/truncated/default-branch-only/not_applicable>
```

When the caller provides `closedloop_graph_packet_path`, read that full artifact
before creating `graph_review_focus` or launching workers. The inline prompt
summary is only a locator/summary and is not a substitute for the artifact.

## Review Orchestrator Graph Use

The review orchestrator must actively use graph intelligence before worker
launch. Do not treat `closedloop_graph_packet` as passive context that is merely
forwarded.

Before launching workers, build and pass this `graph_review_focus` packet:

```text
graph_review_focus:
  packet_source: <artifact path | inline prompt | unavailable | not_applicable>
  route_status_counts: <route:status counts from the packet>
  reusable_evidence: <non-empty packet sections that should guide source inspection>
  lane_focus:
    approach: <owner/source-of-truth/architecture/related-ticket hints to verify>
    correctness: <callers, consumers, state/retry/recovery hints to verify>
    guardrail: <candidate tests and guardrail-sensitive files to inspect>
    contract: <exported symbols, callers, schemas, clients, package/runtime boundaries to verify>
    database: <schema, migration, persisted consumer, downstream ticket/test hints to verify>
    security: <entrypoints, trust boundaries, auth/logging/tenant-isolation hints to verify>
    e2e: <existing user-flow/integration tests and route/flow hints to inspect>
  supplemental_graph_plan:
    <lane>: <review question; exact pinned seed; route call likely to answer it, or none with reason>
  caveats: <stale/default-branch-only/truncated/unavailable/no-material-evidence>
```

Use the packet to decide which optional lanes are applicable. For example, a
database/migration packet hit on schema, migration, persisted model, SQL, seed,
or downstream persisted consumers is enough to launch the database lane; a
`code_tests_for` hit for existing E2E/user-flow tests is enough to launch the
E2E lane. Do not add graph-discovered files to `included_files`; use them only
as caller, consumer, ownership, requirement, or test context to inspect against
the pinned target.

For each lane, make `supplemental_graph_plan` concrete enough that the worker
knows what to challenge with the graph. Prefer a narrow question such as
`which production callers still consume createDesktopApi?` or `which existing
flow tests import this provider?` over a broad instruction such as `check graph`.
Do not assign a route that can only return generic inventory unless that generic
inventory is itself the review question.

If all graph routes are unavailable, skipped, or empty for a lane, record that
explicitly in `graph_review_focus` and tell the lane not to invent graph-backed
concerns.

## Supplemental Lane Graph Calls

The precomputed packet is the shared baseline, not a ceiling. Every reviewer
worker must perform a bounded live graph check before finalizing its lane when
the `closedloop-graph` server is available and the target packet contains at
least one lane-relevant pinned seed. A worker must not treat the packet as
sufficient merely because it exists; it should use the graph to challenge its
source-only read for off-diff callers, consumers, tests, ownership boundaries,
requirements, related tickets, or trust boundaries.

The live graph check requires:

1. one `get_routing_protocol` call per worker session before any other graph
   route, unless that same worker session already made the call; and
2. at least one lane-owned route call from the pinned seeds or
   `graph_review_focus.supplemental_graph_plan` when a route is available and
   can answer a concrete review question for that lane.

`get_routing_protocol`, `code_projects`, and other metadata/protocol calls do
not count as the lane-owned route call. A lane-owned call is material only when
it returns at least one exact file, symbol, caller, callee, test, route,
architecture boundary, ticket, source excerpt, or absence/truncation caveat that
changes what the lane inspects or how confident it can be. Generic repository
overview counts, tool descriptions, route lists, or broad search results do not
satisfy the live-check requirement by themselves.

If the graph server is unavailable, all lane-relevant routes are unavailable,
the target packet has no seed relevant to that lane, or the available route
returns no material evidence, the worker may finish without further graph calls
only after recording the exact reason in `supplemental_graph_calls`. Acceptable
reasons are `graph_unavailable`, `route_unavailable`, `no_lane_seed`, or
`no_material_graph_evidence`; do not use a vague reason such as "not needed".

Supplemental calls must follow these rules:

- Start with the `closedloop-intel` skill when it is available: read it, call the
  `closedloop-graph` server's `get_routing_protocol` tool, and route by the live
  protocol. If the skill is unavailable, still call `get_routing_protocol` and
  follow the returned protocol directly.
- Start from pinned target seeds: `documentSeeds`, `fileSeeds`, `symbolSeeds`,
  route strings, exported names, schema/model names, test names, or changed
  configuration keys from the pinned target packet and frozen diff.
- A lane may follow material graph leads for one adjacent pass when the lead is
  an exact path, qualified symbol, test file, model/table name, route string,
  or ticket slug returned by the packet, returned by a supplemental graph call,
  or verified in the pinned source snapshot. This is allowed for blast-radius
  work such as a database reviewer checking callers of code that consumes a changed persisted model.
  Stop when the adjacent pass yields no new material fact for the lane.
- Keep the budget small: one `get_routing_protocol` call per agent session and
  normally at most three supplemental route calls per lane. A lane may exceed
  three only to finish a material one-hop lead it can name up front; it must
  report why the extra call was needed. Exhaustive graph-backed review requires
  an explicit user request.
- If the first lane-owned call returns only generic inventory, an empty result,
  or an obviously truncated result that does not answer the lane's review
  question, do one narrower follow-up when a pinned seed or returned exact lead
  makes that possible within the budget. If no narrower follow-up exists, record
  `no_material_graph_evidence` and continue with source inspection.
- Prefer these routes by lane, but treat the live routing protocol and the concrete review question as authoritative when another read-only route is the narrower fit:
  - approach: `code_architecture`, `code_symbols`, `search_memory_facts`
  - correctness: `code_symbols`, `code_callers`, `code_snippet`
  - guardrail: `code_tests_for`, `code_symbols`
  - contract: `code_symbols`, `code_callers`, `code_snippet`, `blast_radius_tickets`
  - database: `code_symbols`, `code_callers`, `blast_radius_tickets`, `code_tests_for`
  - security: `code_architecture`, `code_symbols`, `code_callers`, `code_grep`
  - e2e: `code_tests_for`, `code_symbols`, `code_grep`
- Never run direct database access, local closedloop-intel checkout commands,
  graph writes, repo indexing, broad unscoped graph search, or exploratory loops.
- Every supplemental graph result is advisory until verified against the pinned
  PR snapshot, frozen diff, local source, validation evidence, or fetched
  requirement packet.

Every worker return must include:

```text
Graph Evidence Used
- packet_routes_used: <routes/sections inspected, or none with reason>
- supplemental_graph_calls: <question -> route(args) -> material evidence summary, or none with exact reason>
- verified_source_paths: <pinned source paths inspected because graph evidence pointed there>
- graph_only_residual_risks: <unverified graph concerns, or none>
```

## Target Snapshot Boundary

Resolve the review target exactly once before launching workers. The resolved target packet is the review boundary for the entire run.

- For PR and branch reviews, fetch only as needed during initial target resolution, then pin the exact base and head SHAs in the target packet.
- For uncommitted-change reviews, capture a frozen snapshot before workers start: staged diff, unstaged diff, and untracked non-ignored file contents, or an archive/patch path plus checksums. Record the snapshot artifacts and source commands in the target packet.
- For file-list reviews against local files, capture the requested file contents and directly necessary surrounding context before workers start. Record those snapshot artifacts in the target packet.
- After the target packet is created, do not fetch, pull, poll, compare remote refs, rerun target resolution, or check whether new commits or branch changes landed during the review, except for the narrow pre-publication PR-head identity guard in PR Comment Mode.
- If ClosedLoop graph intelligence was gathered, the shared packet is frozen into the target packet too. After the target packet is created, do not rebuild or refresh that shared packet, add files from graph results to the target, update requirements from graph results, or broaden review scope from graph results. Bounded supplemental lane graph calls are allowed only under [Supplemental Lane Graph Calls](#supplemental-lane-graph-calls).
- Workers must review only the pinned snapshot and must not re-read mutable worktree contents after target resolution. If the PR, branch, file list, or local worktree changes while review is running, ignore those later changes and report that Review Coverage is limited to the pinned snapshot. The user can request a separate follow-up review for newer changes.

## Target Inspection Safety

Do not mutate the user's existing checkout just to inspect a PR or branch. Do not run `git checkout`, `git switch`, `git reset`, rebase, merge, stash, or clean in the user's current worktree for review setup.

Inspection rules:

- For "Review all uncommitted changes", use the current worktree only to create the initial frozen snapshot because the uncommitted state is the review target.
- For PR reviews, fetch the PR head once during initial target resolution and create a separate review worktree at the resolved head SHA by default. Inspect that pinned head there and compare against the pinned PR base.
- For branch-vs-base reviews, fetch the base and head refs once during initial target resolution and create a separate review worktree at the resolved head SHA by default. Compare from the pinned merge base.
- For file-list reviews, use the current worktree only to create the initial frozen snapshot when the user pointed at local files. If the files belong to a PR or branch target, inspect the pinned snapshot in the review worktree.

Use a collision-safe path outside the user's existing checkout and outside normal implementation worktrees.

Review worktree root selection:

1. If `WORKFLOW_REVIEW_WORKTREE_ROOT` is set, use it.
2. Otherwise use `/tmp/workflow-review-worktrees`.

Worktree path shape:

```text
<review-root>/<repo-name>-review-<target-slug>-<short-sha-or-timestamp>
```

Never create review worktrees inside the source repo checkout or normal implementation worktree root unless the user explicitly asks.

Use a read-only posture in that worktree: inspect files, diffs, test files, already-produced validation artifacts, and metadata only. Do not commit, push, force-push, rebase, merge, or apply fixes.

## No Review-Time Validation Execution

This skill must not run tests, linters, typechecks, builds, E2E/browser checks, visual QA, migration apply/deploy, ORM drift checks, or other validation commands as part of code review.

Reviewers may inspect validation evidence that already existed at `snapshot_time` in PR checks, CI results, user-provided artifacts, workflow handoffs, logs, screenshots, reports, or local files. Do not refresh, poll, wait for, or incorporate newer validation results during the review. Missing, stale, or insufficient validation is normally a validation gap; make it a finding only when a repo-required gate was violated or a concrete changed behavior has no real-boundary coverage and a specific failure can escape. A failed check is evidence to investigate, not permission for the reviewer to execute validation.

If a review worktree cannot be created, stop and report the blocker unless the user explicitly approves a read-only API/diff-only fallback. Do not silently review a remote PR by switching the user's current checkout.

Record the absolute path of every review worktree this skill creates. It must be removed once the review is over so the run does not leave orphaned worktrees behind. See [Review Worktree Cleanup](#review-worktree-cleanup). Never treat the user's current checkout as a review worktree to remove.

## PR Comment Mode

If the user asks for findings to be left as PR comments, make comments useful in GitHub without leaking local execution details.

PR comments must:

- reference files by repo-relative path and PR diff line when possible
- avoid absolute local paths, review worktree paths, `/tmp/workflow-review-worktrees`, `${WORKFLOW_REVIEW_WORKTREE_ROOT}`, or any machine-specific checkout path
- avoid mentioning that the code was inspected from a temporary worktree unless it is directly relevant to a blocker
- describe the issue, failure mode, and required correction in terms of repository code and PR behavior
- when `SOUL.md` is available, use its voice guidance without parody, slang overuse, or provenance leakage

Before posting, rewrite any worker finding that contains a local review path into a repo-relative reference. If a finding cannot be mapped to a PR file/line, post it only as a general PR review comment with repo-relative context, or ask the user before posting.

### Pre-Publication Inline Duplicate Gate

Immediately before posting each proposed new actionable finding, fetch the pull request's current diff-anchored inline review comments and compare the proposed finding against them semantically, regardless of author.

- Record the pinned PR head SHA during target resolution. Immediately before each finding write, fetch only the current PR head SHA and compare it with the pinned SHA. This is an identity guard, not a target refresh.
- If the current head differs from the pinned head, fail closed without posting that or any remaining findings. Report both SHAs; the newer head requires a fresh review.
- Use only inline pull request review comments with a diff anchor for this duplicate check.
- Exclude top-level pull request conversation comments and review summary bodies.
- If an existing inline review comment materially covers the same issue, do not post the duplicate finding; do count it in `<total_findings>` and do not count it in `<commented_findings>`.
- Classify the final result into exactly one mutually exclusive outcome based on findings before and after duplicate suppression: `findings` when at least one unique actionable finding remains; `duplicate_comment` when actionable findings existed but every one was suppressed by existing inline comments; `approval` only when no actionable finding existed before duplicate suppression; or `blocked` when review/publication cannot complete.
- For `duplicate_comment`, do not approve. Leave exactly one concise general PR comment stating that the review is complete and approval was withheld because existing inline comments already cover the actionable concerns. Do not restate, summarize, or duplicate those findings.
- When using GitHub CLI for this fetch, use the compatible form `gh api --paginate "repos/OWNER/REPO/pulls/NUMBER/comments?per_page=100" --jq '.[] | select(.path != null and ((.line // .original_line // .position) != null)) | {id, path, line, original_line, position, side, body, user: .user.login, html_url}'`. The `--jq` expression is applied to each page; never combine `--slurp` with `--jq` or `--template`.
- If the latest inline-review-comment fetch fails, fail closed: do not post that or any remaining proposed findings, and report the exact failed call or error.
- If GitHub rejects an inline finding specifically because its diff line could not be resolved, re-check the PR head first. When the head changed, fail closed as required above. When the head is unchanged, verify the finding still applies to the pinned diff, retry once on another valid changed line that supports the same issue, or defer it into the single allowed general PR comment when no valid inline anchor exists. Continue only after that recovery succeeds; any other write failure fails closed.

### General Comment Publication

When posting any required general PR comment, construct the comment body in the same shell command that posts it. Prefer a quoted heredoc into a temporary body file, verify the file is non-empty, and pass it with `gh pr comment --body-file`.

```sh
BODY_FILE="$(mktemp)"
cat >"$BODY_FILE" <<'REVIEW_COMMENT'
Write the exact PR comment body here.
REVIEW_COMMENT
test -s "$BODY_FILE"
gh pr comment NUMBER --repo OWNER/REPO --body-file "$BODY_FILE"
```

Do not run `gh pr comment ... --body "$COMMENT_BODY"` or `gh api ... body="$COMMENT_BODY"` unless `COMMENT_BODY` is assigned a non-empty value in that same shell command immediately before the GitHub call.

### Inline Finding Publication

When posting an inline finding through `gh api`, target the pinned diff with GitHub's diff `position` field. Do not improvise a top-level `line` request body for `repos/OWNER/REPO/pulls/NUMBER/comments`: direct endpoint calls can reject `line` and `subject_type` even when the rendered file line exists.

Fetch the pinned PR file list before posting with `gh api --paginate "repos/OWNER/REPO/pulls/NUMBER/files?per_page=100"`. Compute `POSITION` only from the exact matching `filename` object's `patch` in that GitHub PR file-list response. Do not compute publishable inline-comment positions from `git diff`, `gh pr diff`, PR `baseRefOid`, or any local worktree diff: those can include base-branch changes outside GitHub's PR file list, and GitHub will reject those paths or positions even when the rendered file line exists.

Verify the path exists in the GitHub PR file list before posting. If the path is absent, or its `patch` is absent or truncated, there is no valid inline anchor for that finding; use the single allowed general PR comment or fail closed per the publication policy. In that file's diff, the first line below the first `@@` hunk header is position 1, and each later `@@` hunk header also consumes one position before the lines below it are counted. Use the `+` side of an added or context line and the `-` side of a deleted line to choose the anchor; do not pass the source file line number as `position`.

Use this compatible command shape for each surviving inline finding. Run the publication shell under `set -euo pipefail`. Write the review-comment body to a temporary file with a quoted heredoc, verify that file is non-empty, verify that `POSITION` is a non-empty decimal integer, then build the API request payload from the file. Use a checked Node/JavaScript parser or an equivalently explicit parser for `POSITION`; do not use inline `awk`/`sed` one-liners whose quoting failures can leave `POSITION` empty. Avoid shell-interpolated `--raw-field body=...` values because review bodies often contain backticks, quotes, or newlines that can be stripped or executed by the shell before `gh` receives them.

```sh
set -euo pipefail
BODY_FILE="$(mktemp)"
PAYLOAD_FILE="$(mktemp)"
cat >"$BODY_FILE" <<'REVIEW_COMMENT'
P1: Write the exact review comment body here.
REVIEW_COMMENT
test -s "$BODY_FILE"
case "$POSITION" in
  ""|*[!0-9]*) echo "invalid POSITION: $POSITION" >&2; exit 1 ;;
esac
jq -e -n \
  --rawfile body "$BODY_FILE" \
  --arg commit_id "$PINNED_HEAD_SHA" \
  --arg path "$REPO_RELATIVE_PATH" \
  --argjson position "$POSITION" \
  '{body: $body, commit_id: $commit_id, path: $path, position: $position}' >"$PAYLOAD_FILE"
test -s "$PAYLOAD_FILE"
gh api --method POST "repos/OWNER/REPO/pulls/NUMBER/comments" --input "$PAYLOAD_FILE" --jq '{id, html_url}'
```

Never continue to `gh api` after any anchor, body, payload, or integer validation command fails.

Do not add shell cleanup traps or `rm -f` cleanup to publication commands. Leaving temporary files behind in the review run environment is acceptable when cleanup would require another shell mutation.

`POSITION` must be an integer in the JSON payload, not a quoted string. Do not add `line` or `subject_type` fields to this direct comment call unless a deterministic helper has already verified that the current GitHub API accepts that shape.

The PR file-list patch fetch, inline-comment refresh, and current-head identity check are the only permitted post-snapshot fetches. They exist solely to compute valid GitHub inline anchors and prevent duplicate or stale publication: the pinned base SHA, head SHA, requirements, review scope, and validation evidence remain unchanged. Do not use these responses to refresh or broaden the code target.

### No-Findings Approval

When PR Comment Mode is active and no actionable finding existed before duplicate suppression, select the `approval` outcome:

- submit an approving PR review
- for non-trivial changes, leave exactly one concise general PR comment with specific positive feedback about what changed and why it looks sound
- for very small changes, such as a couple changed lines or a tiny metadata, copy, or version tweak, approve without the positive comment
- keep `<total_findings>0</total_findings>` when the caller requested machine-readable findings output

This clean branch is mutually exclusive with `duplicate_comment`. Only use positive feedback in this approval case. If any actionable finding exists before duplicate suppression, do not add praise, summaries, encouragement, or approval-oriented comments.

After the beginning-review comment, every completed review must have a visible terminal GitHub action: one or more unique finding comments, an approval for a genuinely clean review, or the required duplicate-only completion comment. Never finish with only the beginning-review comment.

At the end of PR Comment Mode, emit one machine-readable line exactly as `<review_completion_action>ACTION</review_completion_action>`, where `ACTION` is `findings`, `approval`, `duplicate_comment`, or `blocked` and matches the mutually exclusive outcome above.

At the end of PR Comment Mode, emit one machine-readable line exactly as `<review_publication_status>STATUS</review_publication_status>`. Use `complete` only when every required GitHub review action succeeded, including every surviving unique finding post, the required zero-findings approval, or the required duplicate-only completion comment. Use `blocked` when any required fetch, duplicate gate, comment post, or approval fails or the publication phase stops early, even if the agent process itself exits normally. Continue to emit `<total_findings>N</total_findings>` as the count of actionable findings found before duplicate suppression, and `<commented_findings>N</commented_findings>` as the count actually posted after duplicate suppression.

## Review Mode

Default mode runs the full worker lane set below.

Fast mode is allowed when the user asks for `fast`, `quick`, `lightweight`, or `--fast` review. Fast mode reduces breadth and output detail; it does not change the requested target, mutate safety rules, or turn the orchestrator into the reviewer.

Fast mode must still perform:

- exact target resolution
- read-only review worktree setup for PR and branch targets
- repo guardrail discovery, including `AGENTS.md` for changed paths
- changed-file to guardrail-rule matrix
- correctness/regression review
- approach/architecture sanity review
- findings-first synthesis

Fast mode may combine lanes into fewer workers:

- Worker 1: approach/architecture plus correctness/regression
- Worker 2: guardrail/validation, including the changed-file to guardrail-rule matrix

In fast mode, launch separate contract/compatibility, database/migration, security/abuse, or E2E/user-flow workers only when changed files, PR metadata, plan/decision-table context, or reviewer comments indicate those surfaces are touched. If a combined worker discovers meaningful contract, database/migration, security, E2E, or architecture risk that it cannot review confidently in fast mode, it must say so and recommend escalating that lane to the full review. Do not let fast mode hide high-risk surfaces.

Fast mode is not appropriate when the user asks for exhaustive review, the PR is large or cross-repo, the diff changes auth/security/data boundaries, public API/wire/MCP/shared types, ORM schema, migrations, raw SQL, generated database clients/types, persistence, command execution, installer/update behavior, or when human/code-owner comments already challenge the approach. In those cases, use default mode even if the user also asks for speed, and explain the reason briefly.

## Actionable Finding Standard

Spend review attention first on production-reachable defects: boundary and off-by-one errors, division by zero or invalid arithmetic, null/empty states, cache keys and invalidation, concurrency and retries, unbounded work or memory/API cost, failed persistence or migrations, and security or compatibility failures. These are investigation prompts, not a quota of findings.

Every lane must apply this gate before returning an actionable finding:

1. Cite the changed code and the current caller, contract, requirement, or data shape that makes the scenario reachable in production.
2. State the specific input or state, the execution path, and the observable incorrect result, crash, data loss, or security effect. Distinguish a demonstrated failure from an inference and name any assumption the inference needs.
3. Give a correction that addresses that failure, not a preferred product direction or a larger redesign.

Do not turn an architectural preference, a different product choice, a theoretical future integration, or a test that would merely be nice to have into a PR finding. A sentence such as "this will break migrations" needs a named migration or schema change, a reachable existing-data or ORM condition, and the failing apply or upgrade path. A claim that Desktop and web "will drift" needs a named shared contract, both production consumers, and incompatible observable behavior; different implementations or possible future divergence are insufficient. When the production path is unverified, return an open question or residual risk instead of an inline comment. Severity follows the demonstrated impact, not the strength of the reviewer's opinion.

## Worker Lanes

Launch reviewer workers in parallel where possible. Each worker must be read-only and must return findings ordered by severity with file/line references where possible.

If `SOUL.md` is available, pass the full file content to every worker that may produce user-visible wording. Workers should use it to phrase findings and uncertainty naturally, but they must still return evidence-grounded findings in the required review format.

If `closedloop_graph_packet` is present, pass it to every worker as read-only context. Each worker must inspect the packet sections relevant to its lane, use non-empty graph results only to choose ownership boundaries, callers, consumers, prior tickets, and tests for focused source inspection, and verify every finding against the pinned target snapshot before returning it. A graph-only concern that cannot be verified against the pinned target snapshot must be returned as residual risk, not as a finding.

In default mode, always launch:

1. Correctness / regression reviewer
2. Approach / architecture reviewer
3. Guardrail / validation reviewer

Launch when applicable, and if applicability is unclear prefer launching:

4. Contract / compatibility reviewer
5. Database / migration reviewer
6. Security / abuse reviewer
7. E2E / user-flow test reviewer

## Approach / Architecture Review

This lane is mandatory as a brief sanity check. It must answer:

> Does the chosen approach create a concrete failure against existing behavior or explicit requirements?

Review:

- what problem the PR is actually solving
- whether a failure remains reachable because the PR fixes only a symptom
- where the current source of truth and ownership boundary live
- whether the PR changes the right module, service, API, data model, component, package, command, or workflow surface
- whether indirection, abstractions, flags, state, compatibility paths, retries, caches, or shared helpers introduce a demonstrable failure mode
- whether a smaller or more local change is necessary to correct that failure, rather than merely preferable
- whether bypassing an existing repo helper, validator, schema, or error contract causes incorrect behavior
- whether coupling creates an observable current contract or state-ownership failure
- whether the PR contradicts an explicit fetched acceptance criterion in a reachable production path
- if `closedloop_graph_packet.requirement_context`, `scope_overlap`, `blast_radius`, or `architecture_context` contains non-empty results, inspect the cited source-of-truth, owner surface, related ticket, or architecture boundary and verify whether the PR accounts for it in the pinned source snapshot
- whether a demonstrated contract or ownership failure requires a different implementation boundary

Do not return high-severity findings for "wrong product change," avoidable over-engineering, or a preferred abstraction by themselves. Return an architecture finding only when the chosen surface or ownership causes a concrete failure that the PR introduces or leaves unresolved; otherwise put the tradeoff in Open Questions or omit it.

## Correctness / Regression Review

Review:

- off-by-one bounds, empty collections, zero denominators, integer/rounding behavior, and overflow
- cache-key completeness, invalidation, stale reads, and concurrent update ordering
- scaling limits: pagination, unbounded loops, memory growth, payload size, rate limits, and algorithmic cost on plausible production volumes
- crashes or lost work on partial failure, retries, cancellation, and recovery
- behavioral bugs, edge cases, race conditions, stale state, retries, recovery, idempotency, and error paths
- changed assumptions at call sites
- missing null/empty/error handling
- tests that pass while the real boundary remains untested
- regressions for existing behavior and backwards compatibility
- mismatches between code, tests, PR description, plan, and decision table
- mismatches between code behavior and the fetched requirement packet
- if `closedloop_graph_packet.blast_radius` contains callers, dependents, prior related tickets, or source snippets, inspect the corresponding pinned source paths and verify whether the PR changes an assumption those consumers still rely on

Run a generic Correctness Escape Pattern Pass. This pass is intentionally codebase-agnostic: use the patterns below as reusable questions against the changed code, requirements, and tests, not as repo-specific rules.

- partial-failure behavior: one sub-operation fails while adjacent work can still continue or record degraded state
- recovery behavior: stale, failed, retried, repaired, or resynced state returns to a valid consumer-visible result
- read/write path consistency: data written through the new path is read by the production path, and legacy/compatibility writes remain visible where promised
- response-envelope compatibility: status codes, error envelopes, success wrappers, reason strings, and typed client expectations do not drift
- stale/null/mixed state behavior: nullable, missing, partially migrated, or conflicting producer/storage/client fields resolve deterministically
- source-of-truth ownership: projections, convenience fields, caches, and derived state do not become accidental owners
- idempotency/retry/replay behavior: duplicate delivery, repeated commands, retries, and partial commits do not corrupt or lose state
- migration/backfill/downstream completeness: pre-existing data, pagination, ambiguous rows, orphaned rows, soft-deleted rows, and downstream route/projection/client consumers are covered

## Guardrail / Validation Review

Review:

- repo `AGENTS.md` and nearby guardrails
- changed-file to rule compliance
- ignored-file and generated-file handling, when local state is part of the review
- already-available validation commands/results and whether they cover the changed surface
- missing or over-mocked tests for a specific reachable failure, logging assertions, enum/string fixture drift, hard-coded local paths, and conventions the repo explicitly bans
- if `closedloop_graph_packet.test_impact` contains `code_tests_for` results, inspect those tests or validation evidence as candidate existing coverage without executing validation

The guardrail reviewer must return a changed-file-to-rule matrix, even when it finds no violations:

```text
Changed File | Applicable Guardrail Source | Relevant Rule | Compliance | Evidence
```

For every valid guardrail, convention, type-safety, generated-file, validation, or static-safety finding, return a Guardrail Automation Gap Assessment:

```text
Finding | Automation status | Existing automation checked | Required durable prevention | Reason
```

Use one automation status per finding:

- `already_automated_but_failed`: existing automation should have caught it; identify why it missed and whether config/test/tooling should change
- `automatable_now`: existing repo lint, typecheck, schema validation, code generation, tests, formatter, or static tooling can prevent recurrence; recommend that automation update
- `docs_only_rule`: automation is not practical, but a narrow reusable guardrail rule would help future reviewers
- `not_automatable`: neither automation nor durable documentation is justified beyond fixing the instance

Do not recommend a broad new toolchain from code review alone. Prefer extending existing repo-supported automation.

This assessment only recommends. Whoever later fixes the finding carries out the prevention with the `prevent-recurrence` skill (`$prevent-recurrence` in Codex, `/closedloop-core:prevent-recurrence` in Claude Code).

## Contract / Compatibility Review

Run this lane for API, MCP, GraphQL, webhook, gateway, wire, shared type, generated client, persisted model, response field, cross-repo, cross-process, runtime-materialized file, package, schema, CLI, plugin, or skill behavior changes.

Before treating version skew as actionable, classify the producer/consumer
deployment topology from repo evidence. Independently deployed services,
packages, clients, external APIs, persisted or replayed payloads, cached
artifacts, and generated files can have old/new skew. Peers that ship atomically
inside one production artifact, such as a packaged app's main/preload/renderer
bundle, do not have old-peer/new-peer production skew unless the PR shows a
production path that can load mismatched artifacts. For atomically bundled peers,
still review tolerant parsing of missing, unknown, persisted, or corrupt data
when that data can cross the boundary, but treat dev-only or partial-install
skew as residual risk rather than a required fix.

Review:

- producer-to-consumer path
- canonical source of truth and exposed surface
- old producer/new consumer and new producer/old consumer behavior only when the boundary can actually deploy, persist, replay, or load those versions independently in production
- if `closedloop_graph_packet.blast_radius` or `scope_overlap` contains callers, consumers, exported symbols, or related prior ticket facts, inspect the corresponding pinned source paths and verify whether they identify compatibility surfaces affected by the PR
- optional/defaulted fields, migration boundaries, version skew, and compatibility shims
- exact reason strings, statuses, telemetry keys, descriptor IDs, ordering, and schema taxonomy
- boundary-level tests that prove the real route/tool/client/shaper/envelope path

Do not call a difference between Desktop and web a drift finding unless both are supposed to implement the same named behavior now and the changed code produces conflicting user-visible results. Do not claim version-skew failure for peers that cannot load different versions in production; record uncertain topology as a question.

## Database / Migration Review

Run this lane for ORM schema, database schema, migrations, raw SQL, generated database clients/types, seed data, backfills, persisted models, indexes, constraints, foreign keys, unique constraints, relation definitions, defaults, enums, triggers, extensions, row-level security, or persisted data consumed downstream. If unclear, run it.

This lane must still run in fast mode when database/migration-sensitive files are touched.

Review:

- every changed schema file, migration file, raw SQL file, generated database client/type file, seed file, backfill, and persisted model
- migration provenance: generated, hand-authored, edited generated SQL, or unknown
- whether hand-authored or post-edited SQL has a repo-grounded reason and documented invariants
- exact tables, columns, indexes, constraints, foreign keys, defaults, enums, triggers, extensions, and generated types affected
- whether constraint, index, foreign-key, relation, and default names match ORM/schema expectations or explicit schema mappings
- whether already-available evidence shows deploy/apply validation and ORM drift validation ran when the repo supports them
- whether Prisma-style repos used a shadow-database drift check or repo-supported equivalent, not only `migrate deploy`
- whether pre-existing-data checks cover duplicates, nulls, orphaned rows, incompatible enum values, and destructive operations
- whether backfills and migrations are idempotent or guarded as required by the repo
- whether rollback, destructive boundaries, and downstream route/projection/client/job validation are covered
- if `closedloop_graph_packet.blast_radius` or `scope_overlap` contains downstream callers, projections, jobs, or related tickets that consume the persisted shape, inspect the corresponding pinned source paths and verify whether migration/database coverage accounts for them

Migration apply/deploy success proves the SQL can run, but not that generated schema metadata or future ORM drift checks match. Investigate those surfaces when the changed migration depends on them; absence of a drift check alone is a validation gap unless a repo rule requires it or a concrete mismatch is shown.

Return findings for a demonstrated constraint-name mismatch, unsafe SQL against a reachable existing-data shape, generated-client/schema incompatibility, non-idempotent backfill, or a concrete downstream failure. Do not say a migration "will break" from naming suspicion, missing evidence, or hypothetical future schema drift alone.

## Security / Abuse Review

Run this lane for auth, permissions, public APIs, MCP/tools, command execution, file/network access, logs, telemetry, persisted data, user/org/project boundaries, secrets, uploads, downloads, retries, or untrusted input. If unclear, run it.

Review:

- who can trigger the changed behavior
- what trust boundary changed
- attacker-controlled inputs and affected assets
- if `closedloop_graph_packet.blast_radius`, `scope_overlap`, or `architecture_context` contains entrypoints, callers, architecture boundaries, or prior tickets, inspect the corresponding pinned source paths and verify whether they expose unexpected trust-boundary or abuse paths
- tenant, org, user, project, and ownership isolation
- data exposure through responses, logs, telemetry, errors, artifacts, PR text, and debug output
- command, argument, file path, archive, URL, redirect, network, tool, and MCP abuse paths
- replay, retry, stale authorization, duplicate delivery, idempotency griefing, denial of service, and data-retention risks
- negative or abuse-case tests for risky paths

## E2E / User-Flow Test Review

Run this lane only when the repository already has E2E, browser, integration-flow, smoke, or user-flow test infrastructure, or when the diff changes a flow already covered by existing E2E-style tests. If no such infrastructure or pattern exists, the worker must return `E2E infrastructure not present; no E2E recommendation` and stop.

This worker must not recommend creating a new E2E framework, standing up browser automation from scratch, adding a new service dependency, or instrumenting the project broadly unless the user explicitly asks for test architecture.

Review:

- whether the changed user flow, route, command, API sequence, onboarding path, checkout path, launch path, upload/download path, or critical integration already has nearby E2E-style coverage
- whether an existing E2E test should be updated because selectors, fixtures, route shapes, assertions, or expected states changed
- if `closedloop_graph_packet.test_impact` contains existing E2E/user-flow tests, inspect them for coverage drift without executing validation
- whether a small new E2E-style test fits an existing test file, fixture pattern, command, and CI path
- whether lower-level tests are sufficient because the change is internal, non-user-visible, or already covered at the real boundary

Recommendations must cite the existing test infrastructure, command, and likely file location. Do not provide a fully fleshed-out E2E implementation plan; keep findings at code-review scope.

## Synthesis

After workers return:

1. Apply the Actionable Finding Standard to every worker candidate. Reject preference-only and speculative migration/cross-surface claims before deduplication; preserve genuine reachable failures even when they involve architecture or product requirements.
2. Deduplicate surviving findings without weakening them.
3. In PR Comment Mode, apply the Pre-Publication Inline Duplicate Gate before publishing each proposed new actionable finding.
4. Do not dismiss a worker's architecture, security, compatibility, or correctness finding without repo evidence.
5. If workers disagree, include the disagreement as an open question or residual risk instead of forcing a false consensus.
6. Reconcile every worker's `Graph Evidence Used` section against `graph_review_focus`. If a lane skipped relevant non-empty packet evidence, skipped an assigned supplemental graph call, or satisfied the live-check requirement with only protocol calls, tool descriptions, generic overview counts, broad inventory, or unexamined truncated output, either ask that lane to re-check before synthesis or record the gap in Residual Risk / Validation Gaps. Do not publish graph-informed findings unless the lane verified them against the pinned source snapshot.
7. Lead with findings. Summaries are secondary.
8. If `SOUL.md` is available, apply it during final wording after deduplication. It may change phrasing and emphasis, but not which findings are valid or their required fixes.

Use this output shape:

```text
Findings
- [P1/P2/P3] <file:line> <issue>
  Lane: <approach|correctness|guardrail|contract|database|security|e2e>
  Why it matters: <concrete failure mode>
  Required fix: <specific correction>

Open Questions
- <question, if any>

Residual Risk / Validation Gaps
- <gap, if any>

Review Coverage
- Mode: <default|fast>
- Workers run: <lanes>
- Inputs reviewed: <PR/diff/requirements/plan/decision table/guardrails>
- ClosedLoop graph: <packet source; packet routes used; supplemental data-bearing lane calls; no-material reasons/caveats | unavailable | not_applicable>
- SOUL.md: <path used | not found>
```

If there are no findings, say so clearly and still report residual validation gaps or review limits.

If PR Comment Mode is active, apply the No-Findings Approval behavior before final output.

## Review Worktree Cleanup

If this skill created one or more separate review worktrees during Target Inspection Safety, remove them once the review is finished. Leaving them behind orphans a worktree on every review run.

Run cleanup as the last step, after synthesis output is produced and after any PR Comment Mode posting is complete. Then, for each review worktree this skill created:

1. Remove it with `git worktree remove <review-worktree-path>`.
2. If that fails because the worktree is dirty, locked, or still considered in use, retry with `git worktree remove --force <review-worktree-path>`.
3. If forced removal still fails, run `git worktree prune` and report the leftover path so the user can remove it manually.

Cleanup rules:

- Only remove worktrees this skill created under the review worktree root (`WORKFLOW_REVIEW_WORKTREE_ROOT` or `/tmp/workflow-review-worktrees`). Use the absolute paths recorded during Target Inspection Safety.
- Never remove the user's current checkout or any normal implementation worktree. When the review target was uncommitted changes reviewed in place, no review worktree was created and there is nothing to clean up.
- Run cleanup whether the review found issues or not, and even when a worker errored or the review ended early, as long as the review is over. Do not skip cleanup on a partial or failed review unless the user explicitly asked to keep the worktree for debugging.
- Remove only the review worktree directory. Do not delete fetched refs, branches, or any other local state.
