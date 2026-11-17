# Desktop To CLI Cutover

Use only when a Desktop sweep loses its complete task capability set. Do not
cut over for convenience or automatically cut back during the same generation.
Project-root adoption is a separate outer gate: apply
[Project-Keyed Root Recovery](project-root-recovery.md) first. A new CLI chat
must adopt the existing sweep root before any Desktop child can be considered
for ticket-owner cutover.

## Mandatory Desktop Fence

Before transfer, require positive live evidence for the exact Desktop child:

- it is explicitly paused/stopped or idle
- it has no active turn, tool call, implementation worker, or pending mutation
- its latest task state and worktree status were observed after the pause/idle
  acknowledgement

Lease expiry, missing callbacks, elapsed time, inability to inspect the task, or
loss of Desktop tools can never fence a legacy Desktop child. If pause/idle and
no-active-turn cannot be verified, leave the ticket on Desktop ownership and
record a cutover blocker. Never start a competing CLI owner.

When `list_threads`, `read_thread`, or `send_message_to_thread` is unavailable
on the CLI surface, do not treat the connector failure as a task failure. Use
the bundled native App Server helper for managed daemon discovery, exact thread/cwd
inspection, send/steer, and reconciliation. A legacy notification executable
may remain only as its compatibility shim; do not add another WebSocket or App
Server transport. Re-read the exact thread through the generic client and
require an idle status plus the completed `PAUSED_FOR_CLI_CUTOVER` callback. An
accepted `turn/start` or `turn/steer` receipt is not itself a fence.

## Checkpoint

After the fence, record task/ticket/branch/PR/head/review/plan/monitor state and
create a checkpoint outside every worktree:

```bash
node <cl-sweep>/scripts/checkpoint-worktree.mjs create \
  --worktree <desktop-worktree> \
  --output <external-state>/checkpoints/<ticket>/<generation> \
  --owner-surface desktop --generation <generation>
node <cl-sweep>/scripts/checkpoint-worktree.mjs verify \
  --checkpoint <checkpoint>
```

Persist manifest hash, owner/generation, exact HEAD, PR generation, last event,
and the Desktop fence evidence. Verification failure blocks transfer.

## Rehydrate And Transfer

Create a fresh CLI worktree at the checkpoint HEAD. Rehydrate dirty state only
with `checkpoint-worktree.mjs rehydrate`; require same repository, exact HEAD,
clean target, verified payloads, no path collision, and matching status hash.

Verify the fresh worktree against the cutover checkpoint before initializing
the native App Server worker with `app-server-worker-session.mjs init`. The
helper and root must reject the legacy source worktree and any fresh worktree
whose complete staged, unstaged, or untracked state differs from that
checkpoint. Persist the checkpoint manifest hash in the native session receipt.
Do not launch a cutover worker from a receipt that lacks this binding. The old
`cli-worker-session.mjs` path is compatibility-only after an explicit native
App Server probe failure.

Probe the cwd-bound CLI transport and validate the fresh worktree, but do not
create a session manifest or run a mutating turn yet. Rotate ownership using
root-private secret files:

```bash
node <cl-sweep>/scripts/ownership-lease.mjs transfer \
  --ledger <ownership.jsonl> --ticket <slug> \
  --secret-file <desktop-private-secret> \
  --secret-output <new-cli-private-secret> \
  --desktop-fence-file <verified-desktop-fence.json> \
  --owner-surface cli --owner-role ticket_worker --owner-id <session-owner-id> \
  --reason desktop_cli_cutover
```

Persist only the returned lease id/hash and generation. Initialize the session
manifest from those returned values, then start the cwd-bound session. Never
send the raw token or secret path to the worker. Re-fetch live ticket/PR state
and reconcile the checkpoint before mutation. Do not repeat completed
support/review/communication.

If session preparation fails before transfer, retain Desktop ownership. If
launch/callback fails after transfer, retain the rehydrated worktree and use CLI
replacement. Never edit prior ledger records or transfer back implicitly.

## Desktop Cleanup

Keep the Desktop worktree and verified checkpoint until the CLI session accepts
the new generation and returns its first valid callback. When Desktop tools
return, close/archive the already fenced child. Remove its worktree only when it
is not an active PR checkout and normal cleanup gates pass. Record late Desktop
callbacks as rejected stale-generation events.
