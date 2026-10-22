# Worker Result Artifacts

`CL_SWEEP_RESULT v1` is the preferred backward-compatible transport for a full
local App Server ticket-worker result. Use it by default whenever a callback
contains substantive analysis, validation, diagnosis, review, queue, or
terminal evidence. Keep only compact routing facts inline. Existing callbacks
with complete inline payloads remain valid, and a genuinely small routing-only
result may remain inline. Runtime-generated callback-correction and replacement
events remain inline so recovery never depends on a worker-created file.

## Local artifact envelope

The complete JSON file is a plain object with these fields:

```json
{
  "schema": "CL_SWEEP_RESULT v1",
  "event_id": "<callback UUID>",
  "parent_thread_id": "<current root thread>",
  "root_generation": 1,
  "ticket": "ISS-1",
  "worker_id": "<ticket owner id>",
  "owner_surface": "cli",
  "owner_generation": 1,
  "lease_id": "<lease id>",
  "lease_token_hash": "<sha256>",
  "worktree": "/absolute/canonical/worktree",
  "kind": "ANALYSIS_COMPLETE",
  "phase": "analysis",
  "status": "GO",
  "result": {
    "feature_ownership": {
      "manifest_sha256": "<sha256>",
      "feature_id": "<stable id>",
      "members": ["ISS-1", "ISS-2"]
    },
    "full_structured_evidence": "..."
  }
}
```

Every binding, kind, phase, and status field must equal the callback and the
current ticket session. `result` must be a plain JSON object and the complete
envelope must contain no raw credential field or recognizable raw credential
value. The file is limited to 4 MiB; evidence is never silently truncated.
For a feature-scoped session, `result.feature_ownership` is required and must
match the runtime-persisted feature id, manifest SHA-256, and sorted member
ticket list. A legacy single-ticket session omits it.

## Callback reference

Place this object in `event.payload.result`:

```json
{
  "schema": "CL_SWEEP_RESULT v1",
  "transport": "local_artifact",
  "path": "/absolute/session-authorized/results/<event-id>.json",
  "sha256": "<lowercase sha256 of exact file bytes>",
  "bytes": 12345
}
```

`local_artifact` is the only artifact transport accepted in v1. The explicit
transport discriminator leaves room for a later shared transport. A worker
that cannot prove the local path is accessible must use the existing inline
payload instead; it must not emit a dangling reference.

Artifact callbacks also retain nonempty plain-object `payload.summary` and
`payload.routing` values. Required synchronous routing facts are:

| Kind | Required summary fields | Required routing fields |
| --- | --- | --- |
| `ANALYSIS_COMPLETE` | `decision` | any next-route fact |
| `PR_MONITORING_HANDOFF` | `pr_url`, `head_sha`, `ui_work`, `ui_visual_qa` | `merge_disposition` |
| `TERMINAL` | `outcome`, `requirements_contract`, `review_learning_memory` | any reconciliation route |
| `SUPPORT_REQUEST` | `request_id`, `support_type` | any support route |
| `SUPPORT_RESULT` | `request_id`, `outcome` | any worker-resume route |
| `WAITING_HUMAN` | `wait_kind` | `recheck_when` |
| `BLOCKED` | `blocker` | `recheck_when` |
| Other allowed event kinds | any compact status summary | any next-route fact |

For a feature-scoped session, the callback also carries
`payload.feature_ownership` with the same `{manifest_sha256, feature_id,
members}` object as `result.feature_ownership`. The callback's top-level
`ticket` remains the canonical/anchor ticket and never becomes a list.

`WAITING_MANUAL_QA` uses the existing `WAITING_HUMAN` event kind with
`payload.summary.wait_kind: manual_qa`, the normal result artifact reference,
and `payload.routing.recheck_when`. The artifact carries the feature PR
boundary, manual-QA plan comment, author, record, state, and head coverage
defined by the canonical cl-execute result format.

The callback's top-level `parent_action` remains required and bounded. These
facts let the root route the event without loading the full result.

## Worker preflight

1. Choose the callback event id and write the complete envelope to a private
   candidate file.
2. Publish it atomically:

   ```bash
   node app-server-worker-session.mjs write-result-artifact \
     --session-file <absolute-session-file> \
     --artifact-file <absolute-candidate-file>
   ```

3. Copy the returned `result` object into `event.payload.result`, add the
   required summary/routing facts, and run the existing `validate-callback`
   preflight.
4. Emit the validated `CL_SWEEP_EVENT v1` line exactly as before.

Publishing canonicalizes the JSON, writes a mode-0600 temporary file, fsyncs
it, atomically links the canonical `<event-id>.json` path without overwriting
an existing artifact, and fsyncs the result directory. Repeating the command
for the same event and identical evidence returns the same reference. Different
evidence at that event path fails closed.

## Verification and recovery

New sessions bind `resultRoot` at initialization. Its default is the exact
`results` directory beside the session file; callers may instead pass an
explicit `--result-root`. Legacy sessions keep accepting inline callbacks and
derive only that same narrow session-local default when first publishing an
artifact.

Before callback acceptance, durable enqueue, parent delivery or retry,
completed-turn reconciliation, and idle root rebind, the runtime verifies:

- the canonical event-id path is inside the session-authorized result root;
- the root is a real private UID-owned directory;
- the artifact is a UID-owned, mode-0600 regular file and not a symlink;
- the size is bounded and equals `bytes`;
- the exact bytes equal `sha256` and do not change during the read;
- the JSON schema, ownership, lease, generations, worktree, event id, kind,
  phase, and status equal the callback/session; and
- for feature-scoped sessions, `result.feature_ownership` and
  `payload.feature_ownership` equal the runtime-verified manifest binding; and
- the complete artifact contains no raw secrets.

The verified path, digest, byte count, event id, and binding digest are stored
in both the session artifact index and durable outbox entry. A crash after the
generic outbox fence but before adapter metadata persistence is recovered by
re-verifying the digest already present in the compact event. An ambiguous
parent-delivery attempt remains fenced exactly as for inline callbacks and is
never replayed automatically.

Rollout remains backward compatible: old inline workers continue unchanged;
current local workers should publish substantive results as artifacts on their
next bounded turn; remote or inaccessible consumers stay inline until a
separately specified shared transport exists.
