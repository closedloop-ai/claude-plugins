# Vibe: Claude Code harness notes

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: claude-launcher -->
- Claude Code: invoke as `/vibe:vibe`; plugin agents are available as
  `vibe:<name>`. Launch every worker through `scripts/dist/claude-worker.mjs`,
  never through the native Agent tool: a plugin agent dispatched natively gets
  only the built-in tools its file lists, with no tracker or graph MCP
  tools, so a natively dispatched ticket worker comes back `BLOCKED` and a
  verify worker cannot reach the graph. The only
  native dispatch is the bootstrap in section 1. Send the launcher one JSON
  object on stdin: `{"worktree", "agentName", "mode", "requestId", "input"
  (or "continuation"), "capabilities"}` plus the record and sessionless fields
  below when they apply. When the session brief or orchestrator explicitly
  requires tests outside a pull-request turn, pass `"testsRequired": true`
  for the persistent change writer; the launcher never infers it from raw text.
  In Codex, carry the same explicit requirement in the root-controlled turn
  envelope. Handoff inventory still admits authored tests only in its
  pull-request phase; this envelope grant does not change that path gate.
  Handoff paths come from the target repository's committed root-level
  `vibe-handoff-paths.json`. Inventory rejects nested declarations and every
  session edit to a file with that name, and fails closed when the target has
  no root declaration.
  Leave `agentRoot` out: the launcher binds its own installed plugin root,
  or a resumed writer's recorded root, so a guessed or
  remembered path can never point it at the wrong place (a supplied
  `<root>/agents` is read as `<root>`; another release's root is refused as
  `STALE_PLUGIN_ROOT`). `capabilities` lists every graph read and every
  tracker read the parent can see (`{name, service: "graph" | "tracker",
  operation, access: "read"}`), plus only the writes the record action
  allows; a role the bound provider names reads for is refused
  (`MISSING_CAPABILITIES`) without them. With no provider bound there are
  none to pass. Before any
  work the launcher checks the Claude sign-in and that every granted
  connection loaded in the worker. Its refusals:
  - `CLAUDE_SIGN_IN_NEEDED`: send the person its `personAction` once, word
    for word, then wait for them to say they're done and launch the same
    request again. Any other sign of an expired Claude sign-in (a setup
    worker's diagnosis, a preflight `claude-login` failure) gets the same
    words, from the `claude-auth-login` row of `references/preflight.md`,
    rather than any other sign-in step the worker suggested. Never tell them
    to run `claude /login`: in the Terminal it opens a full Claude session
    that prints permission rules and asks about project connections.
  - `MCP_TOOLS_MISSING`: a granted connection did not load; dispatch
    `vibe-setup-worker` to restore it, then relaunch. Ask the person nothing
    unless setup returns `NEEDS_PERSON`.
  - `CLAUDE_CLI_MISSING`, `AGENT_ROOT_INVALID`, `STALE_PLUGIN_ROOT`: internal;
    fix the call (leave `agentRoot` out) or dispatch setup.
  - `PROTECTED_PATH_HOOK_UNAVAILABLE`: internal; dispatch `vibe-setup-worker`
    to check the installed Claude Code version and writer hook, follow the
    `claude-protected-hook-version` row in `references/preflight.md`, then
    relaunch the same request. Ask the person nothing.
  Use the canonical own-plugin scoped definition and exact capabilities
  discovered/verified in the parent. It uses supported launch-time binding, not an invented per-call
  Agent override. Briefs/capability metadata are JSON on stdin. The implementation
  writer's actual Claude session ID is persisted and explicitly resumed.
  On an existing session preserve its original recorded binding and actual
  writer ID while that definition matches. For a missing definition or proven
  upgraded digest, follow quality-loop.md's recorded definition migration
  through the current installed `writer-state.mjs migrate` command. Never
  replace via ordinary registration, copy definitions or bypass a refusal.
  The returned writer carries the same session artifacts and request queue;
  no technical question goes to the person running the session.
  Before a session exists, requirements and setup run in the validated remembered
  checkout with `sessionless: {kind: "startup"}`; never fabricate a session.
  Requirements use mode `request` with only graph/live read capabilities. Setup
  ticket creation or progress uses mode `record`, the corresponding `recordAction`
  (`create` or `progress`), `exclusiveRecordTurn: true` and only that action's
  exact parent-discovered writes. All setup operations remain non-implementation.
  An engineer PR takeover's adversarial and guardrails reviewers run with
  `sessionless: {kind: "takeover", evidence: {prUrl, headSha}}` in mode
  `pull-request` ([pr-takeover](../../pr-takeover/SKILL.md), section 2), and its
  one repair writer, `vibe-change-worker`, with `sourceBranch` added (section 4);
  no other role has that route.
<!-- end: claude-launcher -->
