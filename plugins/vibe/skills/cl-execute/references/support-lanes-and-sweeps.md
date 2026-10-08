# Support Lanes And Sweeps

Use this reference for `$cl-sweep` execution context, App Server worker goal
continuity, cost-bounded support lanes, CLI callback/result transport, and the
macOS user-bootstrap fallback.

## Sweep Execution Context

When invoked by `$cl-sweep`, require the parent packet to identify
`execution_surface: desktop|cli` and the exact parent `CODEX_THREAD_ID`.

For `cli`, read:

- `../../cl-sweep/references/execution-surfaces.md`
- `../../cl-sweep/references/cli-worker-protocol.md`

Require current owner and session ids, generation, lease id/hash, ownership
ledger, worktree, and last accepted event. Never request or receive the raw
token or private secret path. Verify session cwd, worktree, and lease generation
before every mutation phase. Emit only current-generation `CL_SWEEP_EVENT v1`
callbacks.

For `desktop`, preserve the existing task callback and worker behavior.

A missing, mixed, or unverifiable sweep context is `BLOCKED_BEFORE_START`.

For local CLI sessions, publish substantive structured evidence through the
preferred `CL_SWEEP_RESULT v1` transport documented by `cl-sweep`; keep only
compact routing facts inline. Use the legacy full inline payload only for small
routing-only events or when verified local artifact transport is unavailable.

## Ticket Worker Goal Continuity

Any App Server ticket worker spawned to run or continue `$cl-execute` must have
an active Codex goal for that exact ticket or approved batch. The spawning or
initial prompt must instruct the ticket worker to create or resume that goal
before ticket work. The worker keeps the goal active until merged/done, blocked,
or explicitly paused.

Support lanes are bounded artifacts and must not receive open-ended execution
goals.

## Support Lane Boundaries

On a CLI sweep, the ticket worker directly launches and manages bounded
read-only planning review, code-review lenses/local synthesis, Web/Desktop VQA,
logical QA, audit, deterministic search/inventory, validation-artifact
inspection, and status/check lanes.

- Use at most two concurrent lanes per ticket and gate for ordinary support
  work. This cap explicitly excludes a coordinated `$workflow-code-review`
  generation: launch its full default seven-lane cohort concurrently in one
  fan-out, including lanes that may return `NOT_APPLICABLE`, plus the one
  cross-family lane. Do not serialize, batch, or throttle review lanes to two
  when concurrency slots are available.
- Never duplicate a lens. The cross-family lane is not a duplicate lens: it
  adds a second model family, not a second copy of one lens.
- The cross-family lane is the one review lane that runs as an other-family
  CLI process instead of `spawn_agent`. It follows the same no-delegation,
  no-secrets, no-mutation, artifact, and hashing rules below, and its fresh CLI
  session stands in for `fork_turns: "none"`. Commands and fallback live in
  [cross-family-review.md](cross-family-review.md).
- Resume only from validated `SUPPORT_RESULT` evidence with matching request id,
  generation, artifact hash, and requirements contract.
- Multiple internal code-review lenses within a pass remain one coordinated
  review generation. The required sequence has exactly two immutable
  generations, `review_generation_1` before the first remediation round and
  `review_generation_2` after those fixes. Never launch a third generation or
  trigger external review.
- Only the ticket worker edits code or branch state and owns support-result
  consolidation. Consolidation is verification, not relay: before a lane's
  claim changes the plan, source, a blocker, or a result field, re-check that
  load-bearing claim against the current checkout, a live artifact, or a
  command you run (for a claim that something is unused or has no callers, the
  [Discovery Routes](../SKILL.md#discovery-routes) plus `rg`). Write plan, PR,
  and result text in your own words from what you verified; never paste lane
  prose as evidence.
- A `SUPPORT_REQUEST` fallback to root is allowed only when this worker lacks
  subagent capability; record the limitation and keep the root response compact.
- Support agents never delegate.

Every support prompt must transmit task-relevant mandatory `cl-analyze` and
`cl-execute` worker authority and repo rules, including applicable `AGENTS.md`
and repo-doc constraints discovered by the worker. Do not rely on conversation
inheritance because `fork_turns: "none"` supplies none.

Every support `spawn_agent` packet must set a role-bounded model and
`reasoning_effort`. Use `model: "gpt-6-sol"` with `high` or `xhigh` for
planning review, correctness-sensitive review/QA, synthesis, bounded
exploratory code/evidence analysis, and other high-judgment work where
mistakes matter. Only when the ticket owner actually decomposes a separate
bounded, deterministic lower-risk support role may it use
`model: "gpt-6-luna"` with `low` for deterministic inventory, artifact
parsing, hashing, or status mechanics. Luna returns evidence only; it never
owns orchestration, ticket work, coding/planning, final judgment, or mutation.
These are explicit role/model choices, not fallback models.
Model or effort selection alone is not a token-savings claim.

## Cost-Bounded Evidence

For every path-addressed read-only planning, code-review lens/synthesis,
logical-QA, visual-QA, audit, search, or status support spawn, use
`fork_turns: "none"` plus the role-appropriate `gpt-6-sol` or `gpt-6-luna`
selection above and its matching `reasoning_effort`. If the work has not been
decomposed into a genuinely bounded deterministic lower-risk support role, use
`gpt-6-sol`.

The self-contained prompt must state the exact absolute input artifact path and
SHA-256, cwd, requirements reference, expected absolute result path, and bounded
question. It must require no delegation, no secrets, and no mutation of code,
worktrees, tickets, plans, PRs, CI, review, or communication.

Each lane keeps complete evidence in its declared mode-0600 immutable result
artifact and responds with only compact status, result path, SHA-256, byte
count, and routing summary through existing support/callback fields. Keep full
validation and log output in mode-0600 hashed artifacts before reporting
bounded summaries.

Use server-side or `jq` projections, narrow `rg`, and 6K-12K output budgets by
default. Expand only for one named unresolved fact and never hard-truncate
without a retained artifact.

Full-history support forks are forbidden unless the user explicitly asks for a
conversational-history review and no immutable artifact can represent it.

## Visual QA Preflight

A `visual_qa_web` or `visual_qa_desktop` request must carry a verified
`repo_memory_preflight` packet with:

- `memory_root_command` and result;
- `memory_action_query`;
- `memory_hits` with relevant titles/ids or explicit `no-hit`;
- `repo_docs_verification`;
- `runtime_launch_command`, the exact supported runtime/capture command chosen
  by the ticket worker.

Missing or unverified fields fail closed. Apply repository headless/displayless
rules and never fall back to visible execution.

## macOS GitHub Transport Fallback

When a managed exec/App Server shell has a direct GitHub DNS failure or cannot
resolve the SSH uid, but the macOS interactive user context is known to work,
the ticket worker may use
the native managed App Server setup documented by the sibling
`gh-monitor-pr` skill.

First record the direct DNS/UID transport failure and run its read-only `id -u`
probe in the exact ticket worktree. Do not use the helper unless that probe
succeeds. Keep worker owner, lease/generation, branch/worktree, and cwd binding.

Pass the operation as argv/path arguments only, for example `git push` or
`gh pr create --body-file PATH`. Never interpolate shell text, accept token
arguments, add environment overrides, or print child output containing secrets.

This fallback does not authorize CI/review triggers, new review generations,
credential changes, or any operation beyond the already authorized GitHub
action. Continue the normal per-branch push gate and PR/merge policy after it
returns.
