# CLI Worker Protocol

Use only after `execution-surfaces.md` selects CLI.

## Ownership

The root owns discovery, scheduling, worktrees, cwd-bound worker sessions,
leases, callbacks, monitor lifecycle, replacement, communication, and cleanup.
One managed App Server thread or root-owned `codex exec` session owns each
approved feature unit through terminal reconciliation. It runs `$cl-analyze`
separately for each nonterminal shipping member and,
only after validated readiness and approval gates, `$cl-execute` serially in its
verified worktree. It must not run `$cl-split`.

The ticket session remains the sole lease holder, source/worktree mutator,
external-state mutator, finding synthesizer, and final decision owner. It may
directly invoke bounded read-only support subagents for planning review, code
review (as `$cl-execute`'s review rules direct), Web/Desktop VQA, logical QA,
audit, deterministic search/inventory, validation-artifact inspection, and
status/check aggregation. Support agents use absolute artifact/worktree paths, never own
mutation cwd, and never delegate further. Only the ticket session changes code.
If the worker's actual tool surface lacks subagent capability, it may emit a
fallback `SUPPORT_REQUEST`; the root may launch that one support lane only after
recording the limitation in the worker event/result. Root fallback does not
transfer synthesis or ordinary support ownership to the root.

For open-PR events, root ownership stops at compact event routing and the
generation-fenced conflict probe. The root never downloads CI job logs, reads
test output, inspects ticket source/diffs, performs Graph/code attribution, or
reproduces a failure on the ticket's behalf. The exact ticket session owns CI/
review/conflict diagnosis, predecessor attribution, repair selection, and
validation. Root-owned support scheduling is orchestration, not permission to
perform the support or ticket analysis in the root context.

For a multi-member feature, choose the deterministic canonical callback ticket
from the approved manifest and acquire a distinct current lease for every
executable member under the same owner/session/worktree. Create a private
mode-0600 manifest owned by the current uid with this exact shape; sort members
by ticket and include at least two:

```json
{
  "schema": "CL_SWEEP_FEATURE_OWNERSHIP v1",
  "feature_id": "<stable feature/batch id>",
  "anchor_ticket": "ISS-1",
  "owner_id": "<session owner id>",
  "owner_surface": "cli",
  "worktree": "/absolute/canonical/worktree",
  "members": [
    {
      "ticket": "ISS-1",
      "generation": 1,
      "lease_id": "<opaque id>",
      "lease_token_hash": "<sha256>"
    }
  ]
}
```

Initialize either session adapter with the canonical ticket and its ordinary
lease arguments plus `--feature-manifest <absolute-json>` and
`--ownership-ledger <absolute-jsonl>`. The runtime validates canonical paths,
file ownership/mode, SHA-256, owner/worktree/anchor binding, sorted unique
members, and current ledger leases, then persists `featureOwnership`. A
singleton uses the existing init contract and omits both feature arguments.

## Session Launch And Resume

Every command that starts a new App Server turn must carry the actual activity
classification: `--activity-phase planning|coding|reviewing`. A reviewing turn
must also pass `--review-kind plan|code`; other phases must not pass a review
kind. The adapter records the phase only after the exact `turn/start` is
accepted and persists the result in `currentActivity`. Before a scheduling or
status pass is complete, `status` must show `currentActivity.recorded: true` for
every active turn. This is a launch invariant, not optional follow-up telemetry.
For a pre-existing active turn created before this invariant, or a verified
journal delivery failure, use `report-activity` with the exact session and live
phase; it refuses idle or mismatched turns and persists the repair.

Before resolving any ticket session, apply
[Project-Keyed Root Recovery](project-root-recovery.md). Use the returned stable
`rootPath`; never derive a second state root from the current chat id. A root
transfer rebinds idle session callbacks in place through
the bundled native App Server helper and preserves the exact worker thread/session,
worktree, checkpoint, event log, and ticket lease generation.

Use App Server when current `thread/start`, `thread/resume`, `turn/start`, and
`turn/steer` schemas expose the required thread, turn, `cwd`, and model-binding
fields. Current App Server schema uses `model` on `thread/start`,
`thread/resume`, and `turn/start`; `turn/steer` has no model field because it
targets the already-active turn. Preserve `requestedModel`,
`requestedReasoningEffort`, the generated protocol schema SHA-256 proof, and the
field-level binding in a pre-existing legacy session. New ticket-owner sessions
persist `requestedModel: gpt-6-sol`. Pass the exact real worktree and the
session's exact persisted model to start/resume during recovery; pass ticket-owner
`effort: xhigh` on turn start unless a later deterministic narrow continuation
is explicitly classified for medium. Verify returned and read thread id/cwd
before mutation. Keep the App Server thread id and active turn id in the private
session manifest. Stream notifications until the bounded turn completes, fail
on any reroute away from that persisted model, validate its callback, append the
event, and use the same daemon to steer or start the parent root turn with that
event. Never create a new `gpt-5.5` or `gpt-5.6-*` session. An already-active
legacy turn is recoverable under its exact stored binding. Once it reaches an
authoritatively verified idle/no-active-turn boundary, replace its owner/session
before another turn; never rewrite its model field in place. No implicit
fallback or model-family reroute is allowed.

Accepted callbacks enter the bundled native helper's durable outbox before
journal or parent delivery work continues. The shared primitive persists a
`delivering` attempt before parent App Server input. Unknown acceptance remains
ambiguous, blocks root adoption/finish, and cannot be replayed by
`notify-parent`.
When the parent is known `notLoaded` because another writer owns it, do not
create that ambiguous fence; persist the accepted callback as `pending_retry`
with the exact parent-writer reason so project-root adoption can rebind and
retry it safely. For legacy state already marked `delivering` with that exact
pre-input failure, run `app-server-worker-session.mjs
repair-parent-writer-delivery` before root adoption or finish; it must not
repair any other ambiguous delivery.

Parent-to-worker input uses `turn/steer` with `expectedTurnId` while a worker is
active and `turn/start` when idle. A daemon/client disconnect never authorizes a
new turn. Reconnect, resume the exact stored thread/cwd, inspect the stored
active turn, and recover its callback or interrupted/failed status first.

Thread creation and every turn start use a durable pre-dispatch operation
record. A newly returned thread remains `AWAITING_FIRST_TURN` with
`threadMaterialized: false`; do not call `thread/resume` until a first user turn
materializes its rollout. If the client exits after remote acceptance, retry
with the identical prompt: exact thread/turn history must yield exactly one new
result, otherwise fail closed. Never persist an unmaterialized thread as a
healthy idle binding.

If the stored turn is absent from full history while authoritative exact-bound
thread state is idle with no active turn, do not replace the worker. Use the
explicit `recover-absent-turn` command. It verifies the active ownership ledger
record and every supplied ticket/thread/turn/cwd/branch/owner/lease/parent/root
generation guard, proves absence and idle state twice through
the bundled native App Server helper, fences any exact detached waiter from its runner
receipt, and appends a durable recovery audit before clearing `activeTurnId`.
It fails without mutation if the thread is active, another live turn exists,
history contains the stored turn, any identity differs, or the waiter cannot be
fenced. After success, `launch` selects `run` and the next prompt starts a new
turn on the same App Server thread and worktree.

```bash
node <cl-sweep>/scripts/app-server-worker-session.mjs recover-absent-turn \
  --session-file <session.json> --ownership-ledger <ownership.jsonl> \
  --expected-ticket <ticket> --expected-thread-id <thread-id> \
  --expected-turn-id <stale-turn-id> --expected-worktree <worktree> \
  --expected-branch <branch> --expected-owner-id <owner-id> \
  --expected-generation <ticket-generation> --expected-lease-id <lease-id> \
  --expected-parent-thread-id <root-thread-id> \
  --expected-root-generation <root-generation> --expected-state <state> \
  --runner-file <runner.json>
```

Omit `--runner-file` only when no exact detached `run`/`supervise` waiter is
alive. Recovery does not itself start a turn.

Only when the complete native App Server schema or daemon probe fails:

1. Run `cli-worker-session.mjs probe` against the installed `codex` and require
   model-bound `-m/--model` support for launch and resume.
2. Initialize a mode-0600 session manifest with worktree identity, logical owner
   id, generation, lease id/hash, exact parent `CODEX_THREAD_ID`, and canonical
   parent cwd. New compatibility sessions without `parentCwd` are invalid for
   cross-root adoption.
3. Launch through `codex exec -C <real-worktree> -m gpt-6-sol` and capture the
   explicit session id plus final callback.
4. Resume only that id through `codex exec resume -m <persisted-model>`, with
   process cwd set to the same real worktree. Older fallback receipts without
   a proven model binding may finish an already-running process; after exact
   process-exit/idle proof replace their owner/session before another run.
   Validate repository common-dir, branch, callback
   worktree, owner, and generation every turn.

Fail closed if any cwd/session/thread/turn check is absent or mismatched. Never
use an untracked background subprocess or a direct mutating subagent.

## Event Envelope

Every bounded turn ends with one compact line:

```text
CL_SWEEP_EVENT v1 {"event_id":"<uuid>","parent_thread_id":"<CODEX_THREAD_ID>","root_generation":3,"ticket":"FEA-123","worker_id":"<session-owner-id>","owner_surface":"cli","owner_generation":2,"lease_id":"<uuid>","lease_token_hash":"<sha256>","kind":"SUPPORT_REQUEST","phase":"planning","status":"WAITING_SUPPORT","parent_action":"launch planning_review","worktree":"/absolute/path","payload":{}}
```

For local App Server sessions, substantive result evidence must use the
preferred `CL_SWEEP_RESULT v1` transport in [Worker Result Artifacts](result-artifacts.md).
Keep only the required summary/routing facts inline. A small routing-only event
or a worker that cannot prove local artifact accessibility may use the legacy
inline payload. Never emit a dangling artifact reference or require the parent
to load the full artifact merely to choose the next route.

For a feature-scoped session, the callback includes
`payload.feature_ownership: {manifest_sha256, feature_id, members}` and a result
artifact includes the identical object at `result.feature_ownership`. Members
are sorted ticket slugs. The top-level event/artifact `ticket` remains the
canonical callback ticket. The runtime rejects a missing or mismatched summary
and verifies all member leases at every scoped lifecycle boundary.

Every bounded App Server turn automatically appends the current session
binding, callback size limits, and an exact deterministic preflight. The worker
must write the callback JSON object to a private candidate file and run:

```bash
node <cl-sweep>/scripts/app-server-worker-session.mjs validate-callback \
  --session-file <session.json> --callback-file <candidate.json>
```

Only after that command succeeds may the worker emit the object on the single
final `CL_SWEEP_EVENT v1` line. Delete the candidate file afterward. `jq` or
`JSON.parse` alone proves only JSON syntax; it does not prove the current
parent/ticket generations, lease/worktree binding, allowed kind/word fields,
the 512-character `parent_action` limit, or the 64-KiB payload limit. Nothing
may follow the validated callback. The root parser remains strict and reports
the exact rejected field without printing expected lease values.

Require every shown field. `root_generation` identifies the callback/parent
binding; `owner_generation` identifies the ticket lease. Root adoption advances
only the former. Generation-1 legacy callbacks may omit `root_generation`, but
omission after a transfer is stale. Allowed kinds are:

- `ANALYSIS_COMPLETE`, `SPLIT_COMPLETE`, `EXECUTION_CHECKPOINT`
- `SUPPORT_REQUEST`, `SUPPORT_RESULT`
- `PR_MONITORING_HANDOFF`, `MATERIAL_EVENT_HANDLED`
- `WAITING_HUMAN`, `BLOCKED`, `CHECKPOINT_READY`, `TERMINAL`

Use existing `WAITING_HUMAN` with `summary.wait_kind: manual_qa` and
`routing.recheck_when` for durable `WAITING_MANUAL_QA`; do not add an event
kind. The same feature owner resumes when human evidence arrives.

Capture the line from the exact managed response or root-owned output file.
Reject duplicate ids, raw-token fields, wrong transport/session, parent, ticket,
owner, surface, generation, lease id/hash, worktree, kind, or state transition.
Append accepted events before acting. If a completed App Server turn has a
malformed final event, reconcile that exact thread and cwd. The session records
the rejected turn and message hash, clears only the stale completed
`activeTurnId`, remains `INTERRUPTED`, and durably emits a runtime-generated
`CHECKPOINT_READY` / `CALLBACK_CORRECTION_REQUIRED` event. On a `gpt-6-sol`
binding, the root starts one correction turn on the same thread/session and
worktree; the compatibility fallback likewise resumes its exact stored Codex
session id. On a legacy model, first replace at the verified idle boundary and
issue the correction from the new session. Exactly one correction turn is
allowed. If that turn also fails callback validation, the runtime atomically
records `FAILED` plus `replacementRequired`, appends a runtime-generated
`CHECKPOINT_READY` / `REPLACEMENT_REQUIRED` event to the normal durable
callback outbox, and immediately attempts parent delivery. The root must
consume that event and run the ordinary exact-worker replacement protocol; it
must not wait for a status request or discover the failure by polling. If
delivery is interrupted, the outbox remains retryable through normal delivery
reconciliation. Never treat correction exhaustion as an unattended terminal
ticket state.

The `codex exec` compatibility fallback uses the same field validator,
preflight, statuses, and runtime-event payloads. Because it has no App Server
parent outbox, it appends each runtime event to the root-owned events ledger and
returns that event as the successful command result. The invoking root must
consume it exactly like the native event: run the one correction for
`CALLBACK_CORRECTION_REQUIRED`, or replace for `REPLACEMENT_REQUIRED`.

## Support Lanes

`SUPPORT_REQUEST.payload` contains:

```json
{
  "support_kind": "planning_review|code_review|visual_qa_web|visual_qa_desktop|logical_qa|audit|deterministic_search|validation_artifact|status",
  "request_id": "uuid",
  "artifact_path": "/absolute/path",
  "artifact_sha256": "sha256",
  "requirements_contract": "exact requirements or not_applicable",
  "read_only": true
}
```

The ticket worker launches and manages direct read-only support agents with
`fork_turns: "none"`, an explicit role-bounded model, and an explicit reasoning
effort. Use `model: "gpt-6-sol"` with `reasoning_effort: "high"` or `"xhigh"`
for planning review, correctness-sensitive code review or QA, synthesis, and
high-judgment architecture, security/privacy, database/migration, or ambiguous
correctness work, as well as exploratory code/evidence analysis. Only when work
is actually decomposed into a separate bounded deterministic lower-risk support
role may it use `model: "gpt-6-luna"` with `reasoning_effort: "low"` for
search/inventory, status, hashing, or artifact parsing. Support lanes provide
evidence only; they never own final judgment, ticket work, coding/planning, or
mutation. These are explicit role/model choices, not fallback models. Each
prompt names the exact
absolute input artifact and SHA-256, cwd, requirements reference, expected
absolute mode-0600 result path, bounded question, no secrets, no mutation, and
no delegation. At most two lanes may run concurrently per ticket and gate;
duplicate lenses never overlap.
Planning review checks the required template and requirements. Code-review
lanes follow `$cl-execute`'s review rules, which own the review-generation count
and lane fan-out and override the lane cap above; never trigger external review
or CI. Visual-QA prompts include the verified `repo_memory_preflight` packet;
browser E2E remains headless and Electron E2E uses the repository displayless
harness; interactive QA never counts as automated E2E.

Each support agent writes complete evidence to its declared immutable hashed
artifact and returns only compact status, result path, SHA-256, byte count, and
routing summary. The ticket worker consolidates and deduplicates those results
locally, then resumes through the existing callback/result fields. Support
agents never message ClosedLoop/GitHub, mutate code, commit, push, approve,
merge, change status, or delegate. The root may launch a lane only under the
documented missing-capability fallback and must preserve that limitation in the
compact routing evidence.

The parent receives only the compact `CL_SWEEP_EVENT v1` or
`CL_SWEEP_RESULT v1` routing summary; it does not receive or synthesize ordinary
support evidence when the ticket worker can access subagents.

## Lease And Replacement

`ownership-lease.mjs` writes each new secret with `--secret-output` and
authenticates renew/transfer/replace/release with `--secret-file`. Shared records
contain only lease id/hash. The root never gives workers the raw token or secret
path. Renew only after a valid callback or verified bounded liveness.

Replace only after proving the tracked CLI turn exited or session is inactive.
For persisted `gpt-5.5` and `gpt-5.6-*` owners, recover any already-active turn
under its exact stored binding, then prove the exact thread/cwd is idle with no
active turn. Preserve the old session receipt and checkpoint; never rewrite its
model binding or start another turn on it. Rotate the lease and create a new
`gpt-6-sol` session at the next generation.
Validate and checkpoint dirty work, rotate the private secret, increment the
generation once, and create a new cwd-bound session manifest. Reconcile ticket,
events, requirements, checkpoint, PR/head, review generations, validation, and
communications before mutation. Never repeat completed analysis/support/review
or trigger CI/review. Late prior-generation callbacks are stale.

## Cleanup

After live terminal verification and durable memory reconciliation:

1. Close the ticket session and support agents.
2. Stop/remove the terminal PR monitor.
3. Append `RELEASE`; the helper removes the current private secret.
4. Preserve shared ledgers, session receipts, support results, and checkpoint.
5. Remove the worktree. This is mandatory for a terminal ticket whose worktree
   is clean; do not leave clean terminal worktrees parked in the sweep root.
   If the worktree is dirty or the helper refuses removal, preserve it, record
   the exact cleanup blocker in durable state, and recheck that blocker before
   the next status report, machine-transfer copy, or root-finish attempt.
   Forced removal/deletion requires the checkpoint, cleanup reason, and cleanup
   ledger.
6. Append and query-verify cleanup-complete workflow memory.

Never clean waiting, open-PR, pending-event/support, or manual-intervention work.

Before every root `finish` and every status report, run the read-only
`node scripts/worktree-audit.mjs --repo <repo>` (add `--no-gh` only when GitHub
is unreachable, and say so). It joins every `git worktree list` entry with
sweep ownership and lease state, PR state, tracked versus untracked dirt, the
newest Codex rollout for the path, and a path class, and suggests a
disposition. Report every `terminal-uncleaned`, `owner-check`,
`hold-tracked-dirt`, `orphan-review`, and `orphan-temp` row with its reason.
Remove only sweep-owned terminal worktrees, through the steps above and their
checkpoint gates. Every other row is surfaced to the user and never removed
automatically; the audit itself never removes anything.
