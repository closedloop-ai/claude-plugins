# Vibe: Claude Code harness notes

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: claude-launcher -->
- Claude Code: invoke as `/vibe-generic:vibe`; plugin agents are available as
  `vibe:<name>`. Launch every worker through `scripts/dist/claude-worker.mjs`,
  never through the native Agent tool: a plugin agent dispatched natively gets
  only the built-in tools its file lists, with no tracker or graph MCP
  tools, so a natively dispatched ticket worker comes back `BLOCKED` and a
  verify worker cannot reach the graph. The only
  native dispatch is the bootstrap in section 1. Send the launcher one JSON
  object on stdin: `{"worktree", "agentName", "mode", "requestId", "input"
  (or "continuation"), "capabilities"}` plus the record and sessionless fields
  below when they apply. `input` starts an id; its active resumes use
  `continuation`. Optional `timeoutMs` (model time, and each tool call on its own) defaults to and caps at 1800000. When the session brief or orchestrator explicitly
  requires tests outside a pull-request turn, pass `"testsRequired": true`
  for the persistent change writer; the launcher never infers it from raw text.
  In Codex, carry the same explicit requirement in the root-controlled turn
  envelope. Handoff inventory still admits authored tests only in its
  pull-request phase; this envelope grant does not change that path gate.
  Record actions use `mode: "record"`, `recordAction`, and
  `exclusiveRecordTurn: true`; launcher `recordModes` owns allowed actions.
  The exact shape is `{"mode":"record","recordAction":"<action>","exclusiveRecordTurn":true}`.
  Environment-worker actions are `create`, `redeploy`, `flags`, `desktop`,
  `handover`, `pull-request`. Ticket-worker actions are `create`, `plan`,
  `handoff`, `assign`, `cancel`. The launcher's provider binding owns the
  write operations allowed under each action.
  Handoff paths come from the target repository's committed root-level
  `vibe-handoff-paths.json`. Inventory rejects nested declarations and every
  session edit to a file with that name, and fails closed when the target has
  no root declaration.
  Leave `agentRoot` out: the launcher binds its installed or recorded root and
  refuses another release as `STALE_PLUGIN_ROOT`. `capabilities` carries every
  visible graph/tracker read plus only the action's writes; provider roles
  refuse missing reads as `MISSING_CAPABILITIES`, and generic sessions pass none.
  Launcher preflight refusals:
  - `CLAUDE_SIGN_IN_NEEDED`: send the person its `personAction` once, word
    for word, then wait for them to say they're done and launch the same
    request again. Reuse the `claude-auth-login` preflight words for every
    expired-sign-in diagnosis. Never tell them to run `claude /login`.
  - `MCP_TOOLS_MISSING`: a granted connection did not load; dispatch
    `vibe-setup-worker` to restore it, then relaunch. Ask the person nothing
    unless setup returns `NEEDS_PERSON`.
  - `CLAUDE_CLI_MISSING`, `AGENT_ROOT_INVALID`, `STALE_PLUGIN_ROOT`: internal;
    fix the call (leave `agentRoot` out) or dispatch setup.
  - `PROTECTED_PATH_HOOK_UNAVAILABLE`: setup checks the Claude version and hook
    through the named preflight row, then relaunches.
  Use the canonical definition and parent-verified capabilities on stdin. Keep
  the recorded binding, writer ID and persisted Claude session. A missing or
  proven upgraded definition migrates through `writer-state.mjs migrate`, never
  ordinary registration or copied definitions. Startup requirements/setup use
  the remembered checkout with `sessionless: {kind: "startup"}` and exact reads
  or record-action writes; they never fabricate or implement a session.
  An engineer PR takeover's adversarial and guardrails reviewers run with
  `sessionless: {kind: "takeover", evidence: {prUrl, headSha}}` in mode
  `pull-request` ([pr-takeover](../../pr-takeover/SKILL.md), section 2), and its
  one repair writer, `vibe-change-worker`, with `sourceBranch` added (section 4);
  no other role has that route.
<!-- end: claude-launcher -->
