---
name: gh-monitor-pr
description: Start a detached GitHub pull-request monitor that wakes the exact launching Codex Desktop or CLI root through the managed Codex App Server when review, CI, conflict, merge-queue, closure, readiness, or merge events need attention. Use when the user asks Codex to watch, monitor, babysit, or wait on a PR or merge queue without keeping the current turn alive.
---

## Live-root validation boundary

Validation against a live root is limited to probe-only, read-only protocol calls. Never pipe synthetic events or user prompts into a live root. Run notification and event-delivery simulations only against an isolated fake server or a disposable, projectless test thread unambiguously owned by the test. Never fabricate text claiming that the user instructed a pause, stop, or mutation, and never stop or steer shared roots, workers, or the daemon. If isolated cleanup is unsupported, fail closed and report the limitation.

# Monitor a GitHub PR

Start the detached monitor, report the handoff, and end the turn. Never poll,
sleep, or use a tool-based wait in the launching Codex turn.

App Server wakeups use the native managed Codex App Server daemon through the
portable `codex app-server proxy --sock` transport. The monitor keeps its own
local delivery receipts: it persists a `delivering` attempt before invoking the
native notifier, and a restart never replays an unknown acceptance result.

## Set up the App Server

Use the managed local App Server daemon. Never spawn a competing App Server and
never set `CODEX_APP_SERVER_WS_URL`.

For every command below, resolve `skill_dir` to the absolute directory
containing this `SKILL.md`; do not assume the skill lives in
`${CODEX_HOME:-$HOME/.codex}/skills`.

Treat Desktop and CLI setup as separate surfaces. If the launching root is a
CLI, use only the explicit `cli` setup below. Never run the no-argument Desktop
setup merely to support a CLI monitor: it changes the GUI `launchctl`
environment and installs a persistent Desktop launcher, neither of which is
needed for CLI monitoring. Do not install a periodic launcher that invokes
`codex app-server daemon start` for a CLI root. Start the managed daemon on
demand during CLI bootstrap instead.

For Codex Desktop, preserve the no-argument setup:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/setup-app-server.mjs"
```

This configures GUI applications to join the managed daemon. When requested,
tell the user to quit ChatGPT completely and reopen it once. End the turn there;
register the monitor after restart.

For CLI roots, first probe the existing daemon without changing setup:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/setup-app-server.mjs" \
  probe --surface cli --thread-id "$CODEX_THREAD_ID"
```

If that returns `threadStatus: active`, skip CLI setup and start the monitor.
Only bootstrap when the probe fails because the daemon, socket, or exact thread
is unavailable. Bootstrap also probes the exact root:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/setup-app-server.mjs" \
  cli --thread-id "$CODEX_THREAD_ID"
```

CLI setup and probe do not modify the Desktop `launchctl` environment. They fail
unless the exact thread is readable through the portable
`codex app-server proxy --sock` transport. Desktop registration also prefers
that transport, but may fall back to a direct native Unix-socket App Server
connection without ChatGPT-specific Node modules.

The managed daemon is shared infrastructure, not part of one monitor's process
tree. A monitor must never stop or restart it. Starting or stopping one monitor
must not interrupt another monitor, an App Server worker, or a wakeup turn.

Every connection negotiates `experimentalApi`, reads the exact thread, and does
not resume it during registration. Notification steers an active turn directly;
only idle or not-loaded threads are resumed before a new turn starts. State races
are re-read and retried.

## Start monitoring

1. Require a full GitHub pull-request URL and authenticated `gh` CLI.
2. Read the exact launching thread from `CODEX_THREAD_ID`. Never guess a recent
   thread. In CLI tool shells, `CODEX_THREAD_ID` may be available for shell
   expansion even when `env` does not print it; verify with
   `printf '%s\n' "$CODEX_THREAD_ID"` if needed.
3. Convert the delay to whole seconds. Default to 60; require at least 10.
4. Select owner metadata:
   - Desktop defaults to `desktop` generation `0`, preserving old invocations.
   - CLI registration must pass `--owner-surface cli` and the current ownership
     lease generation via `--owner-generation`. For an ordinary ad-hoc CLI
     monitor in the launching root, use `--owner-generation 1`; higher
     generations are for transfers, recoveries, and sweep-owned roots.
5. By default, resolve the active login with `gh api user` for the PR host and
   exclude inline comments authored by that exact login from wake events. This
   avoids waking a worker for its own review-thread replies. The monitor still
   records every observed comment id. Add `--include-self-comments` only when
   the user explicitly wants their own inline comments monitored; comments from
   bots and every other login remain material either way.
6. Run one of:

   ```bash
   # Backward-compatible Desktop registration
   skill_dir='<absolute path to this gh-monitor-pr skill directory>'
   node "${skill_dir}/scripts/monitor-pr.mjs" \
     start '<pr-url>' --thread-id "$CODEX_THREAD_ID" --cwd "$PWD" --interval <seconds>

   # CLI-root registration
   node "${skill_dir}/scripts/monitor-pr.mjs" \
     start '<pr-url>' --thread-id "$CODEX_THREAD_ID" --cwd "$PWD" --interval <seconds> \
     --owner-surface cli --owner-generation <generation>
   ```

   Add `--stall-after <seconds>` (at least 60) to wake once when an open,
   unqueued PR makes no observable progress for that long. Add the boolean
   `--include-self-comments` switch to either command for the
   explicit opt-in. Do not pass a value and do not introduce an environment
   variable for this policy.
7. Confirm the returned PR URL, owner surface/generation, comment-monitoring
   policy, transport, interval, PID, state file, and log file.
8. Send a final response immediately. State that the monitor is detached and the
   turn is ending. For a CLI-owned monitor, also state that the shared App Server
   remains running after registration and should be stopped only after the last
   monitor and App Server worker has finished.

Registration verifies that the exact launching thread is active in the selected
managed daemon before taking the inline-comment baseline. A CLI owner fails
closed when the portable proxy cannot be verified; it never silently depends on
Desktop. A live monitor for the same PR/thread but a different owner surface or
generation is an ownership conflict and must not be replaced automatically.

## Transfer a monitor

For a deliberate Desktop/CLI owner cutover:

1. Stop the old monitor and require `verifiedStopped: true` from the result.
2. Independently verify its durable state and exact process identity:

   ```bash
   skill_dir='<absolute path to this gh-monitor-pr skill directory>'
   node "${skill_dir}/scripts/monitor-pr.mjs" \
     verify-stopped --state-file '<old-state-path>'
   ```

3. Register the new owner with exactly the prior generation plus one and the
   stopped state:

   ```bash
   node "${skill_dir}/scripts/monitor-pr.mjs" \
     start '<pr-url>' --thread-id "$CODEX_THREAD_ID" --cwd "$PWD" --interval <seconds> \
     --owner-surface cli --owner-generation <new-generation> \
     --previous-state-file '<old-state-path>'
   ```

`--previous-state-file` requires the captured PID/start-token/command identity
to be absent, durable `stopped` state, the same
canonical PR identity, and the exact same root thread. Its prior owner surface
and generation must be valid. Replacement accepts only the next consecutive
generation (`N+1`); equal, stale, and skipped generations fail before daemon or
GitHub access. Before persisting the replacement baseline, registration compares
live PR state against the old monitor's latest snapshot. Inspect
`registrationDelta`: if `detected` is true, route its changes and new inline
comments to the new owner as the first material event before normal work. This
preserves events that arrived while no monitor owned the transfer window.
The replacement also carries undelivered event envelopes and delivered-event
receipts, and claims the transfer receipt idempotently by prior-state digest.
A different target for the same claim fails closed.
Version-3 states remain readable as Desktop generation `0`; replacement from
legacy state must still match PR/thread and advance to generation `1`.
Version-5 and older monitor states retain their historical include-all comment
behavior while already running. A replacement or same-owner recovery writes a
version-6 state, resolves the current authenticated login, and applies the new
default. An earlier explicit self-comment opt-in is inherited across transfer
and recovery; passing `--include-self-comments` can also opt in during either
registration path.

### Repair one historical same-root generation tag

Do not use normal transfer to correct a stopped monitor that was historically
registered one generation above its unchanged owning sweep root. That case is
not an ownership transfer. Use the dedicated repair only when the monitor and
root have the same exact thread, cwd, and owner surface, the monitor records
generation `N+1`, and the active root authority records generation `N`:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/monitor-pr.mjs" \
  repair-legacy-binding '<pr-url>' \
  --state-file '<canonical-stopped-monitor-state>' \
  --expected-thread-id "$CODEX_THREAD_ID" --expected-cwd "$PWD" \
  --expected-prior-owner-surface cli --expected-prior-owner-generation <N+1> \
  --target-owner-surface cli --target-owner-generation <N> \
  --root-authority-file '<sweep-root>/authority.json' \
  --root-state-base '<canonical-cl-sweep-state-base>'
```

`--root-state-base` is required whenever an indexed migrated root keeps its
authority directory outside the canonical project-keyed state base. It may be
omitted only when exactly one registry is provably present in the normal one-
or two-ancestor layout. Never search broader filesystem locations or infer a
state base from another sweep.

The command takes the canonical cl-sweep registry lock and verifies the current
UID-owned mode-`0700` state base/root, UID-owned mode-`0600` registry and root
receipts, hash-chained current registry record, active root authority,
persistent root lease, canonical monitor path, exact absent process identity,
durable stopped state, and settled delivery history before changing ownership
metadata. It permits only the same-surface
`N+1 -> N` correction. It retains the byte-exact original monitor state in a
mode-`0400` audit file, embeds an idempotent repair receipt, and changes no PR,
thread, cwd, event, snapshot, or delivery receipt. A reconciled ambiguous
delivery retains its receipt and is rebound only to the proven parent generation.

After the repair, register the state with `sweep-root-state.mjs
register-monitor`, then use `recover-same-owner` with the exact current head.
Never run `start`, transfer to another generation, or delete/recreate the state
to bypass a binding mismatch. Any live process, pending/unreconciled event,
authority mismatch, noncanonical path, different surface, or generation gap
fails closed.

The sole exception to the same-root rule is a prepared project-keyed cl-sweep
root adoption. After the old monitor is stopped and independently verified,
pass the private transfer receipt:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/monitor-pr.mjs" \
  start '<pr-url>' --thread-id '<new-root-thread>' --cwd '<exact-root-cwd>' \
  --interval <seconds> --owner-surface <desktop-or-cli> \
  --owner-generation <old-generation-plus-one> \
  --previous-state-file '<old-state-path>' \
  --root-transfer-file '<CL_SWEEP_ROOT_TRANSFER-v1-receipt>'
```

The receipt must be mode `0600` and exactly bind the old/new thread, cwd,
surface, and consecutive generation. This transfers monitor ownership; it does
not permit overlapping monitors or relax the stopped-state, PR identity,
registration-delta, or App Server target verification gates. An incomplete
root transfer remains a cl-sweep ownership conflict.

## Event behavior

- Wake on inline review comments created after the baseline, except comments by
  the authenticated `gh` login under the default policy. Preserve all comment
  ids in baseline and polling state, including ignored self comments.
- Wake on a new review summary body that has no inline comments, from any
  login the comment policy treats as material. Reviews present at registration
  are the baseline; a state written before review tracking adopts the current
  reviews on its first poll instead of waking for history.
- Wake with `changes_requested` when the review decision is
  `CHANGES_REQUESTED`; it settles only when the decision changes.
- Wake on failing check runs or commit statuses. Collapse superseded check runs
  by context and app so the newest replacement is authoritative.
- Wake with `ci_rollup_refused` when GitHub reports an unqueued PR `BLOCKED`
  and the head commit's check rollup is `FAILURE` or `ERROR` while no listed
  check is failing.
- With `--stall-after`, wake once with `stalled` when an open, unqueued PR
  keeps the same head, checks, reviews, comments, and merge state for that
  long. Any change restarts the clock. Same-owner recovery inherits the
  deadline.
- Wake when an unqueued source PR becomes conflicting or dirty.
- Follow a queued PR's synthetic merge-group commit until merge or attention.
- Wake on queue check failure, `UNMERGEABLE`, queue ejection, successful merge,
  unqueued merge readiness, or closure without merge.
- Wake after three consecutive GitHub query failures.
- Retry notification six times, then record `notification_failed` and exit.
- Exit after the App Server accepts the first steer/start notification.

When a parent workflow continues owning the open PR, exit-on-notification is a
delivery boundary, not a monitoring pause. After the parent durably hands the
event to the exact remediation worker, it should immediately run
`recover-same-owner` at the unchanged head so concurrent comments, CI,
conflict, closure, and merge events remain observable while remediation is in
progress. The delivered event is reconciled by same-owner recovery and must not
wake again unchanged. If remediation later changes the head, the worker's
handoff drives monitor recovery/replacement for that new head. Additional PR
comments arriving before the first PR-comment remediation push belong to the
same comment wave; monitor recovery never authorizes another review generation.

State identity includes PR and exact thread id. Different threads can monitor the
same PR independently unless a higher-level cl-sweep id owns the PR; one sweep
must stop and transfer its prior generation rather than overlap them.
Same-thread notifications are serialized. Existing queue,
retry, event-priority, active-steer, and idle-resume behavior applies equally to
Desktop and CLI roots.

Same-owner recovery treats the registration snapshot as a set of concurrent
material conditions, not only the highest-priority condition. An exact caller
acknowledgement settles every condition named by that fenced registration
event (for example, a source conflict and a failing check present together).
The monitor will not immediately wake for a lower-priority member of that same
unchanged baseline. A transient omitted or `UNKNOWN` GitHub observation does
not prove that an acknowledged condition disappeared. Conflict settlement is
released only by authoritative clean/mergeable evidence on the same head;
failed-check settlement is released only after GitHub reports a replacement
state for the same check context. A changed check run, changed head, verified
resolution followed by recurrence, queue transition, newly arriving comment,
closure, or merge remains material. Recovery never suppresses an
unacknowledged or newly changed condition.

## One-shot snapshot

For a bounded read at a handoff gate, without registering a monitor:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/monitor-pr.mjs" snapshot '<pr-url>'
```

It prints one `GH_MONITOR_PR_SNAPSHOT v1` JSON verdict (head SHA, review
decision, mergeability, merge state, head rollup state, queue entry, unresolved
thread count and URLs, failing and pending checks, gates) and exits by tier:
`0` ready or merged, `2` conflict, `3` unresolved threads, `4` failing CI
(including a refused rollup), `5` pending checks or queued, `6` a review or
merge-state gate or closed, `7` query failure. It never starts, stops, or wakes
anything.

## Inspect or stop

Use the state file returned by `start`:

```bash
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/monitor-pr.mjs" status --state-file '<path>'
node "${skill_dir}/scripts/monitor-pr.mjs" stop --state-file '<path>' --wait-seconds 15
```

`status` reports normalized owner metadata, exact process-identity liveness, and
`verifiedStopped`. `stop` verifies PID, process start token, and command digest
before signaling, then waits for both process exit and durable `stopped` state;
it refuses a reused PID or legacy live state without exact process identity.
It exits nonzero if verification times out. Do not stop a monitor unless the user
asks or a deliberate ownership transfer replaces it.

When checking a monitor after a chat resume, verify delivery health as well as
process health. A `status` result with `processAlive: true`,
`processIdentityMatches: true`, and `verifiedStopped: false` proves the monitor
process is still owned, but delivery also needs the managed App Server socket.
Run:

```bash
codex app-server daemon version
skill_dir='<absolute path to this gh-monitor-pr skill directory>'
node "${skill_dir}/scripts/setup-app-server.mjs" \
  probe --surface cli --thread-id "$CODEX_THREAD_ID"
```

If the daemon socket is missing, use the CLI setup path to recreate it without
replacing the monitor. A probe returning `threadStatus: notLoaded` is acceptable
after a normal resume; notifications can resume idle or not-loaded threads. A
probe failure, missing socket after setup, or monitor status with a dead or
mismatched process needs remediation before relying on future wakeups.

## Reclaim the shared daemon

Daemon cleanup belongs to the owning root or user after monitoring and any
wakeup handling finish; it does not belong to the detached monitor. A long-lived
daemon can retain substantial thread and tool state, so do not leave it running
indefinitely when it has no users.

Before stopping the daemon:

1. Require every monitor owned by the workflow to have exited or been stopped,
   and verify each returned state file reports `verifiedStopped: true` with the
   `status` or `verify-stopped` command.
2. Require every App Server worker owned by the workflow to be terminal and any
   monitor/worker delivery receipts reconciled. Do not infer this from an absent
   proxy process.
3. Confirm no other Desktop, CLI root, monitor, sweep, or detached worker is
   using the managed daemon. When ownership is uncertain, leave it running and
   report why cleanup was deferred.
4. Only after those checks, the owning root or user may reclaim all daemon memory
   with:

   ```bash
   codex app-server daemon stop
   ```

Use `codex app-server daemon start` on demand for the next CLI monitor. Never
delete App Server sockets, PID files, SQLite state, or rollout files as a cleanup
shortcut. Never stop or restart the daemon from the turn it is currently
serving; defer cleanup until that turn has ended or use an explicitly
user-authorized external owner that can prove the same no-user conditions.

## Public client process interface

Other plugins load this skill by name (`$gh-monitor-pr` in Codex or
`/closedloop-core:gh-monitor-pr` in Claude Code). They may invoke
`scripts/monitor-pr.mjs` or `scripts/client-process-api.mjs` from this loaded
skill's own folder. They never import core files or duplicate the transport.

`client-process-api.mjs` exposes `CLOSEDLOOP_APP_SERVER_CLIENT v1` over private
stdin/stdout JSONL pipes. The `contract` one-shot operation checks compatibility;
`daemon` and `decodeFrames` use the same core implementation. In `serve` mode,
`connect`, `initialize`, `request`, `notify`, `readThreadState`, and `sendInput`
preserve the native client contract, including notification and connection
events. `delegate` supports an injected caller-owned client through reverse
callbacks without copying thread-state or delivery algorithms. Inputs stay on
private pipes, never command arguments or diagnostic logs. Closing stdin or
terminating the caller closes the owned connection; it never stops the shared
daemon.

The vibe adapter resolves this named skill through Codex's enabled plugin
registry and `skills/list` actual installed path, or Claude Code's enabled
scoped plugin registry. It does not infer a path from a marketplace source,
cache version, or another plugin directory. Missing or incompatible core stops
the workflow with an update requirement rather than falling back to a copy.
