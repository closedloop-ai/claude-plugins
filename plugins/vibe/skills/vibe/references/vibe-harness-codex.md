# Vibe: Codex harness notes

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: codex-invoke-and-workers -->
- Codex: invoke as `$vibe`. Workers are this plugin's agents in `agents/`
  (`../../agents/<name>.md` from this file). Codex cannot load them as
  registered agents, so spawn a subagent with the file's body as its
  instructions plus the inputs below, and set the spawn's `model` and
  `reasoning_effort` to what `node scripts/worker-model.mjs codex <name>`
  prints: explorers (requirements, backend, primitive and Storybook advice,
  the handoff summary) run on `gpt-5.6-terra`, every writer, reviewer and
  verifier on `gpt-6-sol`, all at `high`. Never pass `xhigh` unless the person
  asked for it. Spawn `vibe-change-worker` only ONCE per
  session with a read-only hold brief, record its returned actual native ID
  (the agent path `spawn_agent` returns, such as `/root/vibe_writer`, is that
  ID), register/claim its queued request, then follow up/resume that same context.
  Never make a new source writer per request/unit. Repo agents live in `<repo>/.claude/agents/`.
  A new native helper also starts with a read-only hold brief; obtain its real
  ID, acquire the grant, then resume that SAME helper for the operation.
  Before any native helper's session/ticket mutation, acquire its exact canonical
  role/action through `writer-state.mjs acquire-record` as `quality-loop.md`
  specifies. `register` and `acquire-record` bind the installed plugin root
  that runs them when `agentRoot` is left out, and refuse another release's
  root, so leave it out unless a recorded binding says otherwise. Dispatch only after acquisition. Release with `release-record`
  only after observed completion or confirmed owned termination of that actual
  native turn, never because the coordinator script exited. When
  `release-record` for the writer's own grant fails with `ENOENT` because a
  plugin install removed its recorded root, recover at once through
  quality-loop.md's turn stranded by a plugin upgrade: `migrate` with
  `retainedRecord`, internally, never a question or a message to engineering.
  Startup and confirmed discard use the same bounded stable contexts below.
<!-- end: codex-invoke-and-workers -->

<!-- block: codex-hooks-and-compaction -->
- Codex loads this plugin's `hooks/hooks.json` (the shell, kill and merge
  guards, the away checklist and the compaction resume) but runs it only once
  it is reviewed and trusted in Codex's `/hooks`, and again after it changes.
  So after any context compaction in Codex, before the next action, run
  fleet-orchestrator's `scripts/fleet-home.mjs resume` when you orchestrate a
  fleet and read each `READ` file it prints, then reread the session record
  (`vibe-sessions.mjs show`) and `session-questions.mjs list`; never continue from
  the summary alone.
<!-- end: codex-hooks-and-compaction -->
