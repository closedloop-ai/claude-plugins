# Execution Surfaces

Select exactly one surface before ticket discovery and re-probe after
compaction or capability change. Determine the current host without invoking
deferred tools. Codex CLI TUI must use initially exposed tools plus the
documented local/App Server probes; only hosts that explicitly support dynamic
discovery may inspect deferred operation schemas. Never infer capability from a
remembered name or version.

In CLI TUI, probe through the installed `sweep-root-state.mjs`,
`app-server-worker-session.mjs`, the bundled native App Server helper, and monitor
setup/status commands. Do not call `tool_search` while choosing the surface.

After selecting the surface but before creating state, a goal, or a worker,
apply [Project-Keyed Root Recovery](project-root-recovery.md). Surface selection
does not authorize a new chat-keyed root when an unfinished project-scoped root
already exists.

## Desktop

Select `desktop` only when all of these are callable:

- list Codex projects/tasks
- create a task in an explicit project worktree
- read, message/resume, archive/unarchive, and list tasks
- start and inspect the existing detached PR monitor
- read the exact nonempty `CODEX_THREAD_ID`

When complete, preserve Desktop Child Thread Flow unchanged. Do not create
manual CLI worktrees or CLI ticket sessions.

## CLI

Select `cli` only when Desktop is incomplete and all of these are proven:

- start and resume a root-owned mutating worker session bound to an explicit
  ticket-worktree cwd
- capture an exact session id and final callback for every bounded turn
- execute local `git`, `node`, `gh`, `workflow-memory`, and the existing monitor
- read the exact nonempty `CODEX_THREAD_ID`
- access a collision-safe worktree and external state root

The Desktop task connector may be absent from a CLI tool surface even when the
same tasks are reachable through the managed App Server. Probe the exact CLI
root after loading `gh-monitor-pr` by name (`$gh-monitor-pr` in Codex or
`/closedloop-core:gh-monitor-pr` in Claude Code). Run
`scripts/setup-app-server.mjs probe --surface cli` from that loaded skill's own folder and
use the verified portable proxy for legacy-task read/pause fencing. Connector
absence alone is not proof that a Desktop task is stopped or unreachable.

If the CLI App Server probe fails because
`app-server-control/app-server-control.sock` is missing, first try the documented
`codex app-server daemon restart`. When both `restart` and `stop` time out
waiting for a pid-managed app server, verify the recorded pid is a defunct
child of `codex app-server daemon pid-update-loop` and that no control socket
exists. Only with explicit user authorization, terminate that managed daemon
wrapper, run `codex app-server daemon start`, then re-run the monitor and worker
probes before opening or resuming sweep work. Do not touch ticket roots,
workers, monitors, or ChatGPT-owned app-server processes during this repair.

If the probe succeeds but reports the current parent thread as `notLoaded`,
do not restart the daemon. `notLoaded` means the thread is readable but the
active writer is outside this managed App Server, so `gh-monitor-pr` cannot
register a durable wake target. Continue only bounded passive reads in the
current root, or have a fresh managed root adopt the sweep through
`project-root-recovery.md` after the old root and workers are proven idle; then
start/register the monitor from that App-Server-active generation. Do not ask
the user to exit as the fix, and do not start a duplicate monitor against the
old generation.

Use managed App Server `thread/start`, `thread/resume`, `turn/start`, and
`turn/steer` when the installed generated schema proves their required thread,
turn, `cwd`, and model-binding fields. Codex CLI 0.148.0 provides this complete
native surface with `model` on `thread/start`, `thread/resume`, and
`turn/start`, plus `effort` on `turn/start`; `turn/steer` has no model override.
Use `scripts/app-server-worker-session.mjs` to create, run, steer, inspect, and
reconcile cwd-bound ticket threads through the managed daemon. Validate the
returned/read thread id and canonical cwd on every lifecycle transition.
Every new `run`/`launch` turn requires `--activity-phase planning|coding|reviewing`.
`reviewing` additionally requires `--review-kind plan|code`. The session runtime
records this after turn acceptance and returns it as `currentActivity` from
`status`; an active turn with missing or unrecorded activity is not reconciled.
Every new native ticket session persists and revalidates
`requestedModel: gpt-6-sol` and its protocol schema hash proof before
start/resume/turn-start. A pre-existing session bound to `gpt-5.5` or
`gpt-5.6-*` may recover an already-active turn under its exact persisted model.
Never rewrite its model binding or interrupt that turn. At the next
authoritatively verified idle/no-active-turn boundary, replace its owner/session
under the CLI lease replacement protocol before another turn. New legacy-model
sessions and implicit fallback/model-family reroutes are forbidden.

`codex exec -C <worktree>` is only a compatibility fallback when the installed
App Server schema or daemon probe genuinely lacks the complete native surface.
Connector absence, an untested schema, or an available daemon used only for
callbacks is not a valid fallback reason. Use `scripts/cli-worker-session.mjs`
only for that proven fallback. Its probe must prove `-m/--model` on both launch
and resume; new fallback sessions persist `gpt-6-sol` and pass it explicitly on
each invocation. A legacy fallback process already running may finish; a
persisted old model or missing model binding requires replacement after process
exit and exact idle proof before another invocation.

Inspect one CLI ticket worker without polling its model turn:

```bash
node <cl-sweep>/scripts/app-server-worker-session.mjs status \
  --socket "$HOME/.codex/app-server-control/app-server-control.sock" \
  --session-file <external-state>/sessions/<ticket>/<generation>/session.json
```

The result includes ticket/generation, durable state, exact worktree/branch,
binding validity, App Server thread/turn identity and runtime status, last
accepted callback, the latest interrupted/failed condition, and any rejected
completed callback. `modelReplacement.idleCandidate` is only a routing hint;
prove exact thread/cwd idle and no active turn under the replacement protocol
before rotating ownership. Use `steer` to deliver a parent correction to an active
turn. Use `reconcile` after a client or daemon interruption before starting
another turn. When strict parsing rejects a malformed final event from a
completed turn, reconciliation clears its stale `activeTurnId` and preserves
the thread, session, worktree, lease, and generation. For `gpt-6-sol`, use `run`
with a correction prompt to create exactly one recovery turn on that same
thread. For a legacy model, replace after idle proof and issue the correction
from the new session.

If `reconcile` instead reports that the stored turn is absent from history,
compare `status` with generic `verify-absent-turn`. Only when the exact thread
and cwd are idle with no active turn may the root run the documented
`recover-absent-turn` command. That explicit command validates the current
ownership ledger and exact expected bindings, fences any detached waiter,
records the stale turn in session audit history, and clears it. Never edit the
session JSON manually. The command starts no model turn; a later `launch` reuses
the same thread and worktree only for a `gpt-6-sol` binding. A legacy binding
instead follows the idle-boundary replacement protocol.

Direct `spawn_agent` has no cwd in this CLI version. It is never a mutating
ticket-worker surface. Direct multi-agent workers are allowed only as bounded
read-only support lanes using absolute artifact/worktree paths. The current
ticket owner starts and manages those lanes under the support-lane contract
below; the root may start one only as a recorded fallback when the worker's
actual tool surface lacks subagent capability. A support lane never receives a
ticket lease, worktree mutation authority, or callback ownership.

Fail closed before selection or mutation if neither surface is complete. A
partial Desktop set plus a complete CLI set selects CLI; never mix their
ownership primitives. Missing cwd-bound start/resume, explicit session identity,
callback capture, `CODEX_THREAD_ID`, GitHub authentication, or monitor support
is not a reduced-function mode.

## Invariants

- Run one root coordinator; it never implements ticket code.
- Use three mutating feature-owner sessions by default and at most ten when
  explicitly authorized. One feature consumes one slot regardless of member
  count; support lanes are bounded but do not consume slots.
- Only the root starts mutating ticket sessions. The current ticket owner starts
  direct read-only support agents under the bounded support-lane contract below.
  If and only if the worker cannot access a subagent tool, the root may provide
  that support as a recorded fallback; the worker must record the limitation.
  No support lane may delegate further or start a mutating Codex/worker process.
- Preserve every readiness, legacy split-lineage, requirements, UI approval,
  `$cl-execute` code-review, headless/displayless E2E, communication, coverage,
  monitor, and UI/non-UI merge gate.
- Never create GitHub auto-merge state. Non-UI work uses the protected queue;
  UI work waits for human/manual merge.
- A surface or owner change creates a new generation. Reject stale callbacks.

## Read-Only Support-Lane Contract

This is the ticket worker's standing delegation permission. It applies to
path-addressed planning review, code-review lanes, logical QA, visual QA, audit,
deterministic search/inventory, validation artifact inspection, and
status/check aggregation. Code-review lanes follow `$cl-execute`'s review rules,
which own how many review generations run and how their lanes fan out.
At most two support lanes may be active per ticket and gate for other support
work; never overlap duplicate lenses. Mutating subagents remain forbidden until
sublease, file-ownership, and callback fencing exist.

- Every such `spawn_agent` call uses `fork_turns: "none"` and explicitly sets a
  role-bounded model. Use `model: "gpt-6-sol"` for planning, correctness-
  sensitive review/QA, synthesis, and any high-judgment work where mistakes
  matter. Only when the ticket owner actually decomposes a separate bounded,
  deterministic lower-risk support role may it use `model: "gpt-6-luna"`.
  A full-history
  support fork is forbidden unless the user explicitly requests a
  conversational-history review and no immutable artifact can represent the
  requested evidence.
- The prompt is self-contained and names the exact absolute input artifact
  path and SHA-256, cwd, applicable requirements reference, expected absolute
  result path, bounded question, and every task-relevant mandatory
  `cl-analyze`/`cl-execute` worker/repo rule; do not assume conversation
  inheritance. If any required input is missing or its hash cannot be
  verified, fail closed instead of spawning.
- Every ticket-owned `planning_review`, `code_review`, `visual_qa_web`,
  `visual_qa_desktop`, logical-QA, audit, search, status, or validation-artifact
  request launched with `fork_turns: "none"` must carry those explicit rules in
  its packet. Each visual-QA request additionally requires a verified
  `repo_memory_preflight` packet with: `memory_root_command`/result;
  `memory_action_query`; `memory_hits` (relevant titles/ids or explicit
  `no-hit`); `repo_docs_verification`; and `runtime_launch_command` (the exact
  supported runtime/capture launch command chosen by the ticket worker). The
  support prompt must repeat the packet and execute/verify the launch command
  before the lane reports runtime, port, or browser unavailability.
- A visual-QA lane may report a runtime blocker only after that transmitted
  launch attempt fails, or current repo docs prove the path unsupported, and it
  must give the exact command and error. A dead port before launch is not a
  blocker.
- The prompt says: no delegation; no secrets; no-mutation of code, worktrees,
  tickets, plans, PRs, CI, review, or communication. The ticket owner remains the
  sole lease holder, worktree mutator, external-state mutator, finding
  synthesizer, and final decision owner.
- The lane writes its complete result to the declared mode-0600 immutable
  artifact, hashes it, and returns only compact `status`, absolute result path,
  SHA-256, byte count, and a short routing summary. Do not invent a new worker
  result-artifact callback protocol: use the existing support request/result
  fields and callback envelope.
- Pair the model with its bounded role and reasoning effort. Luna roles
  (deterministic search/inventory/status, artifact parsing, hashing, and
  mechanical support tasks) use `model: "gpt-6-luna"` with
  `reasoning_effort: "low"`. Sol roles include bounded code/evidence
  exploration and initial classification, planning review, ordinary or
  high-risk correctness review, visual QA, logical QA, compatibility/test
  diagnosis, cross-boundary architecture, security/privacy,
  database/migration, ambiguous-correctness judgment, and synthesis; use
  `model: "gpt-6-sol"` with `reasoning_effort: "high"` or `"xhigh"` as the
  risk requires. Support lanes return bounded evidence only and never own
  orchestration, ticket work, coding/planning, final judgment, or mutation.
  Bounded inputs and compact artifact handoff are required; a cheaper model or
  effort tier is not itself a token-savings claim.

## Bounded Tool Output

Use server-side field projections or `jq` projections, narrow `rg` searches,
and default output budgets of 6K--12K tokens. Preserve a full validation or log
output in a mode-0600 hashed artifact before presenting a bounded summary; never
hard-truncate evidence without that retained artifact. Expand an output only
for one named unresolved fact, then return to bounded projections.

## CLI State

Choose one state directory outside every worktree from the project registry.
It is keyed by a stable sweep id; `CODEX_THREAD_ID` is the generation-scoped
root owner. Do not add an environment variable. Preserve:

```text
<state-root>/ownership.jsonl
<state-root>/events.jsonl
<state-root>/sessions/<ticket>/<generation>/
<state-root>/private/<ticket>/<generation>/lease.secret.json
<state-root>/feature-ownership/<feature-id>.json
<state-root>/checkpoints/<ticket>/<generation>/
<state-root>/support/<ticket>/<generation>/<request-id>/
<state-root>/monitors.json
<state-root>/transfers/<root-generation>-<transfer-id>.json
```

The shared `<state-base>/registry.jsonl` maps the canonical ClosedLoop project
UUID plus repo/user scope to this root. Query it by project id before creating a
root and fail on duplicate unfinished claims. Root adoption advances the root,
callback, and monitor generation exactly once while preserving ticket lease
generations.

Keep shared ledgers append-only. Legacy memory records remain discovery
evidence; append a reconciled owner generation rather than rewriting them.
Add these compatibility fields to new `cl_sweep_ticket_state` records:

```text
sweep_id: <stable project-keyed sweep id>
sweep_root: <absolute stable sweep root path>
root_thread_id: <current parent thread id>
root_generation: <positive callback/root ownership generation>
execution_surface: <desktop | cli>
owner_role: <root | ticket_worker>
owner_id: <Desktop task id | CLI managed thread/session owner id>
owner_generation: <positive integer>
ownership_ledger: <absolute path>
lease_id: <opaque id>
lease_token_hash: <sha256; never raw token>
worker_session_id: <managed/App Server or codex exec session id>
checkpoint: <verified path or none>
last_event_id: <id or none>
worker_replacement: <prior owner/generation and reason | none>
batch_id: <feature id or none>
batch_members: <complete assigned nonterminal member list or none>
batch_anchor_ticket: <canonical callback ticket or none>
batch_manifest: <versioned manifest path and sha256 or none>
```

The raw token exists only in a randomized mode-0600 ticket-private file inside
a mode-0700 directory. Never write or print it in ledgers, memory, callbacks,
prompts, session manifests, or worker output. The root alone reads the secret
file for lease mutations; do not disclose its path to ticket or support workers.

## Worktrees And Cleanup

The root creates and initially validates worktrees:

```bash
node <cl-sweep>/scripts/cli-worktree.mjs create \
  --repo <repo> --path <path> --branch <branch> --base <exact-ref>
node <cl-sweep>/scripts/cli-worktree.mjs validate \
  --repo <repo> --path <path> --branch <branch> --expect-clean
```

Never reuse an existing path/branch or the root checkout. Terminal cleanup
requires live reconciliation and no open PR/pending event. Either `--force` or
`--force-delete-branch` requires a verified current-state checkpoint,
`--cleanup-reason`, and `--cleanup-ledger`; the helper records authorization and
completion. Never erase uncheckpointed work.

Create one worktree and branch per approved feature unit. Multi-member CLI
sessions must use the runtime-verified feature-ownership manifest and distinct
member leases; singletons keep the ordinary single-ticket session. Root finish
must fail while any non-root `ticket_worker` lease remains active, including a
leaked feature member lease.
