# Quality loop: recorded definition migration

Moved unchanged out of `quality-loop.md`, which says when to read it; paths stay relative to the skill folder.

<!-- block: migration-steps -->
1. Read `status` and the bounded binding facts from the private ledger. Wait
   for source and record turns to finish with actual stopped-turn evidence;
   a short-lived CLI PID exiting does not release an owned turn. While the
   recorded definition is present, resolve any writer refusal in the original
   request first. Never migrate around a refusal the recorded writer can still
   settle. Once the recorded definition is missing, that writer can never run
   again, so a `BLOCKED` request of any reason is carried over unchanged as the
   active request and the new writer settles it before any other work (step 5).
   That is the recovery `guardrails.md` promises for a turn stranded by a
   plugin upgrade, not a bypass. Migration rejects `BLOCKED`
   (except a removed definition, below) while the recorded definition is
   present, running leases, matching definitions, unproven upgrades and stale
   identity.
2. Codex: spawn one current canonical `vibe-change-worker` with a read-only
   hold brief and obtain its actual native ID. No source/test/record writes
   until migration succeeds. Claude: the command allocates the new session ID;
   do not spawn or resume the old Claude session under the new definition.
3. Send this JSON on stdin, using the existing runtime and recorded facts:
   `{ "worktree": "<wt>", "runtime": "<codex|claude>",
      "previousWorkerId": "<recorded ID>", "previousDigest": "<recorded digest>",
      "agentRoot": "<current-plugin-root>", "agentName": "vibe-change-worker",
      "capabilities": <exact parent-discovered capabilities> }`.
   For Codex add `"workerId": "<new held native ID>"`; omit it for Claude.
   Leave `capabilities` out to keep the recorded binding's capabilities. When
   given, it is at most 48 ClosedLoop graph reads, ClosedLoop live reads and
   the five record writes (`writer-state.mjs help` lists the bindable
   operations); anything else is refused.
   The command independently reads the current definition from its own plugin
   root and verifies the old definition with its recorded capabilities.
4. The atomic ledger update appends `migrations`: old writer ID, full old
   binding/digest and writer state, new ID and binding/digest, observed old
   digest (null when absent), reason, UUID and time. Earlier migration history,
   pending/completed requests and the active checkpoint/status remain intact.
   The worktree, branch, local plan, decision table and change log carry over;
   private traces remain where they were. Never discard or rewrite this history.
5. Use only the returned current ID with the current binding supplied above.
   Claim the existing active
   request with a checkpoint continuation, or the oldest queued request if
   none is active. When migrate returns `carriedBlock`, the continuation
   names that block (its `resultSummary`) and asks the writer to settle it
   first; `claim` refuses every queued request until the writer continues it.
   Recover its input with the owned `take-input` lease. Brief
   the new writer with the same plan/table paths, checkpoint, change log and
   decisions before new code; migration grants no implementation or handoff
   authority by itself. Codex resumes its held context. Claude's normal owned
   launcher starts the recorded fresh session once, then resumes that ID.
   Validation witnesses tied to the old writer are stale: collect fresh
   source-owned readiness/validation before publication, keeping captured facts.

**A turn stranded by a plugin upgrade.** A release installed while a Codex
writer turn runs can remove the recorded `binding.agentRoot` under it. The
turn stops, but `release-record` for the writer's own record continuation then
fails with `ENOENT` for that root, so the grant stays retained. This is the
same supported migration, not a tooling fix: ROOT recovers it immediately,
internally and without asking the person running the session, and never tells the person to message
engineering about it.

1. Keep the record lease and the observed stopped-turn evidence (completed,
   failed or canceled). Never retry `release-record` under another root;
   owner equality stays exact.
2. Finish the source turn with the writer's status and its own stopped-turn
   evidence. When the writer is `BLOCKED` because its definition or plugin
   root disappeared, finish with `"status": "BLOCKED"` and
   `"blockReason": "recorded-definition-removed"`; the command refuses that
   reason while the recorded definition is present. Every other `BLOCKED` is
   stored with reason `other` and is carried over unchanged (step 1).
3. Run the same `migrate` command with step 3's JSON plus
   `"retainedRecord": { "lease": "<record lease>", "stoppedTurn": {
   "runtime": "codex", "workerId": "<recorded ID>", "requestId": "<request ID>",
   "lease": "<record lease>", "state": "<completed|failed|canceled>" } }`.
   Omit `retainedRecord` when no grant is retained. The command accepts only
   the registered writer's own record continuation for its current or just
   completed request, issued under the exact recorded `binding.agentRoot`
   whose definition is absent, with matching stopped-turn evidence. It then
   releases that grant and migrates in one atomic ledger update; the
   migration entry adds `releasedRecord` (request, action, stopped state,
   never the lease). Another actor's grant, any other root, a present
   definition (use `release-record`), a running lease, missing or mismatched
   evidence and stale identity are refused with nothing changed. A stopped
   helper's grant under a removed root needs no old cache: `release-record`
   with its identical grant frees it, and `migrate` refuses until it is gone.
4. A writer blocked before block reasons existed has no `blockReason`. With
   that retained grant under an absent definition the command records the
   proven reason; without it the request is carried over unchanged (step 1).
5. Continue with step 5 above. All authority is fresh: the current writer and
   helpers acquire new grants from the current plugin root (source `progress`,
   publisher, ticket `handoff` and `assign`), and the writer reruns
   source-owned readiness and validation for the captured transaction. Never
   reuse an old grant, lease or validation witness.

**A writer whose runtime cannot run.** A Codex writer stopped by its usage
limit moves to Claude through this command, never to a worker outside the
session records:

1. Finish its turn `"status": "FAILED"` with `"state": "failed"` evidence.
2. Run `migrate` with step 3's JSON (recorded `"runtime": "codex"`, no
   `workerId`) plus this field:
   `"harnessSwitch": { "to": "claude", "cause": "usage-limit", "evidence": "<error line>" }`
3. Continue at step 5.

The command refuses running turns, retained grants, a `BLOCKED`
writer and a same-runtime switch, and records the switch in `migrations`.

Any other binding/read/identity error remains `BLOCKED` internally. Never
migrate around a refusal the recorded writer can still settle, or to create
parallel authors. If migration fails,
retain the ledger and stop the unused held Codex worker without source writes.
New sessions bind the current release.
<!-- end: migration-steps -->
