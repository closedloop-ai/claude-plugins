# Project-Keyed Root Recovery

Run this protocol before `get_goal`, ticket discovery, worker creation, or a new
state directory. The durable sweep root is keyed by the canonical ClosedLoop
project UUID plus repository and Sweep-owner identity. A Codex chat/thread is a
generation-scoped owner of that root, not the root identity itself.

## Resolve Or Open

`sweep-root-state.mjs` accepts either a project UUID or a full HTTPS ClosedLoop
project URL. It extracts the UUID after the `projects` path segment and stores
the lowercase identity `closedloop-project:<uuid>`.

```bash
node <cl-sweep>/scripts/sweep-root-state.mjs status \
  --project <project-id-or-url>

node <cl-sweep>/scripts/sweep-root-state.mjs open \
  --project <project-id-or-url> \
  --repo <stable-repository-namespace> --repo-path <repository-path> \
  --user <stable-ClosedLoop-user-id> \
  --root-thread-id "$CODEX_THREAD_ID" --root-cwd "$PWD" \
  --owner-surface <desktop-or-cli>
```

Do not add an environment override. The default registry is
`$CODEX_HOME/cl-sweep-state` when the existing `CODEX_HOME` contract is set,
otherwise `$HOME/.codex/cl-sweep-state`. Tests may pass `--state-base`.

Interpret `open` as follows:

- `created`: no unfinished root exists for the exact scope; use the returned
  `rootPath` for all sweep state.
- `resumed`: the current thread already owns the exact root; reconcile its
  workers, events, callbacks, PRs, and monitors before continuing.
- `adopted`: an idle prior root was transferred to the current thread. Reuse
  the returned root, workers, worktrees, sessions, ticket leases, checkpoints,
  events, and support evidence. Route every reported monitor registration delta
  before normal scheduling.
- Any ownership/binding conflict: stop. Do not create another root or worker.

`status --project <id>` is read-only and works without a repo/user argument. It
lists unfinished roots, terminal history, exact bindings, and duplicate claims,
so a fresh CLI chat can locate recovery state from the project ID alone.

## Exact Scope And Layout

The registry binds all of these values:

- canonical project UUID;
- normalized repository namespace and canonical Git common directory;
- normalized stable ClosedLoop user id;
- canonical root cwd;
- stable sweep id and state path.

A cwd or Git-common-directory mismatch for an otherwise matching
project/repo/user scope is an ownership conflict, not permission to create a
parallel root. Different repository or user scopes may have separate roots.

New roots use a stable sweep id rather than a chat id:

```text
<state-base>/registry.jsonl
<state-base>/sweeps/<sweep-id>/scope.json
<state-base>/sweeps/<sweep-id>/authority.json
<state-base>/sweeps/<sweep-id>/ownership.jsonl
<state-base>/sweeps/<sweep-id>/sessions/<ticket>/<ticket-generation>/
<state-base>/sweeps/<sweep-id>/private/root/<root-generation>/lease.secret.json
<state-base>/sweeps/<sweep-id>/private/<ticket>/<ticket-generation>/
<state-base>/sweeps/<sweep-id>/checkpoints/<ticket>/<ticket-generation>/
<state-base>/sweeps/<sweep-id>/support/<ticket>/<ticket-generation>/<request-id>/
<state-base>/sweeps/<sweep-id>/monitors.json
<state-base>/sweeps/<sweep-id>/transfers/<root-generation>-<transfer-id>.json
```

The global registry and ownership ledgers are append-only and hash-chained.
Root leases use an explicit lifetime (`expiresAt: null`); they remain active
until an authenticated generation transfer or terminal release. Before every
root-owned mutation, use `assert-owner`. It requires the registry, ACTIVE
authority fence, persistent root lease, owner thread/surface, scope hash, and
generation to agree.
State, receipts, and secret files are private. Raw lease tokens never enter the
registry, session state, callbacks, prompts, monitor state, or output.

## Cross-Root Transfer

When the invoking thread differs, `open` performs one fail-closed transfer:

1. Use the bundled native App Server helper to inspect the exact prior root thread/cwd.
   Require authoritative `idle` with no active turn. `notLoaded`, active, unreadable, or
   mismatched prior root is a conflict.
2. Discover every stored App Server and compatibility worker session. Require
   its exact old parent thread/cwd/root generation and prove it has no active or
   disconnected turn/process. A stored turn missing from history is not an
   automatic idle result: use the explicit absent-turn recovery protocol, with
   exact ownership and detached-runner fencing, before transfer can continue.
3. Validate every registered PR monitor against the old root thread/cwd and
   generation.
4. Write `TRANSFER_PREPARED`, set the authority fence to `TRANSFERRING`, and
   write a private `CL_SWEEP_ROOT_TRANSFER v1` receipt. Both roots then fail
   `assert-owner`. After a crash, only the exact prepared target may roll the
   receipt phases forward; another target is an ownership conflict.
5. Stop and independently verify every old monitor. Rebind each idle worker's
   parent callback through the bundled native App Server helper's `rebind-parent`
   command or the thin
   compatibility adapter. Preserve its App Server/Codex session, worktree,
   checkpoint, and ticket lease generation.
6. Rotate the root lease exactly from generation `N` to `N+1`. A
   Desktop-to-CLI root transfer also requires the verified Desktop fence file.
7. Register each monitor for the new root with the stopped prior state, the
   transfer receipt, and generation `N+1`. Preserve `registrationDelta` as the
   first material event.
8. Append `TRANSFERRED` and activate the exact new authority generation. Only
   then may the new root reconcile callbacks and
   resume normal scheduling. The old root must reject later wakes as stale.

Never adopt an active root, skip a generation, rebind an active worker, reuse a
monitor without verified stop, skip a malformed worker manifest, move an
ambiguous in-flight callback delivery, or infer ownership from lease expiry. If
multiple unfinished roots claim the same project/repo/user scope, report all
sweep ids and require explicit reconciliation.

Every new `CL_SWEEP_EVENT v1` includes `root_generation` in addition to the
ticket `owner_generation`. Generation-1 legacy callbacks may omit it; after any
root transfer omission is stale. Root transfer changes the callback/root/monitor
generation only. It does not rotate a healthy ticket lease or replace the
ticket worker.

## Monitor Registration

Before launch, callback handling, monitor registration, or terminal mutation:

```bash
node <cl-sweep>/scripts/sweep-root-state.mjs assert-owner \
  --sweep-id <sweep-id> --root-thread-id "$CODEX_THREAD_ID" \
  --root-generation <generation>
```

After each parent monitor start or refresh, register the returned state file:

```bash
node <cl-sweep>/scripts/sweep-root-state.mjs register-monitor \
  --sweep-id <sweep-id> --root-thread-id "$CODEX_THREAD_ID" \
  --root-generation <generation> --state-file <monitor-state-file>
```

Registration is bookkeeping only and requires the exact current PR, thread,
cwd, surface, and root generation. The monitor remains governed by
`gh-monitor-pr`; the sweep registry does not implement GitHub polling or App
Server transport.

If one historical stopped monitor for the unchanged root was incorrectly tagged
with exactly `root_generation + 1`, do not edit its JSON or create a replacement
monitor. Use `gh-monitor-pr repair-legacy-binding` with the canonical monitor
state, exact prior and target bindings, this root's `authority.json`, and the
canonical project-keyed `--root-state-base`. The explicit state base is required
for a migrated root whose authority remains in its original thread-keyed
directory rather than beneath the registry. The repair serializes against this
root's registry, requires the exact old process
to be absent and every delivery settled or explicitly reconciled, and preserves
the byte-exact old state in its immutable audit receipt. Then run
`register-monitor` and `recover-same-owner`. Any larger gap, surface/thread/cwd
change, live process, missing process identity, or unsettled event remains a
manual ownership conflict.

## Terminal History And Legacy Roots

After all normal cl-sweep terminal gates and cleanup succeed, release the root:

```bash
node <cl-sweep>/scripts/sweep-root-state.mjs finish \
  --sweep-id <sweep-id> --root-thread-id "$CODEX_THREAD_ID" \
  --root-generation <generation> --reason <durable-reason>
```

`finish` refuses nonterminal workers, pending or ambiguous callback outbox
entries, live monitors, owner mismatches, and incomplete transfers. Terminal
history remains discoverable but never blocks a new run.

`CREATION_PREPARED` and `TRANSFER_PREPARED` are crash-recovery intents. Only
their exact original owner or target may roll them forward. A malformed
receipt, scope, worker manifest, outbox, or generation mismatch fails closed.

These files provide cooperative operational fencing within the local Codex
process model. They do not isolate a malicious process running as the same OS
user: the managed socket and mode-0600 files intentionally use that same-UID
local trust boundary.

Existing thread-keyed state must be indexed once from its current owning root;
do not infer its scope or move its files:

```bash
node <cl-sweep>/scripts/sweep-root-state.mjs migrate \
  --legacy-root <existing-thread-keyed-state-root> \
  --project <project-id-or-url> \
  --repo <stable-repository-namespace> --repo-path <repository-path> \
  --user <stable-ClosedLoop-user-id> \
  --root-thread-id "$CODEX_THREAD_ID" --root-cwd "$PWD" \
  --owner-surface <desktop-or-cli>
```

Run migration only from the verified current owner. Register each live monitor
afterward. A legacy Desktop generation-`0` monitor must first follow its normal
stop/verify/re-register path to root generation `1`; never relabel its state.
An unindexed or ambiguously scoped legacy root remains a manual
reconciliation blocker; never create a competing indexed root around it.
