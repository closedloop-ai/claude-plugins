# fleet-orchestrator: Codex sessions

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: codex-sessions-rules -->
`scripts/fleet.sh` drives a session on this machine (`local`) or on `REMOTE_HOST` (`remote`, which copies the scripts and the prompt file there first) through the managed Codex App Server.

```sh
scripts/fleet.sh <orchDir> local|remote session turn  <name> --prompt-file <file> [--cwd <worktree>] [--ticket <slug>] [--model <m>] [--effort <e>] [--sandbox <mode>]
scripts/fleet.sh <orchDir> local|remote session steer <name> --prompt-file <file>
scripts/fleet.sh <orchDir> local|remote session last  <name> [--count <n>]
scripts/fleet.sh <orchDir> local|remote session end   <name> --reason stopped|merged
```

- `turn` binds a new thread to `--cwd` (refusing another later), resumes it afterwards and starts a turn. `--model` and `--effort` default to `CODEX_MODEL` and `CODEX_EFFORT`; a new session refuses to start without a model or an effort, or with a prompt not starting with `$vibe`. Its thread is named `<name> · <ticket>` (just `<name>` without `--ticket`), moved into the Codex app's "Fleet workers" sidebar section, and started with `threadSource: "chatgpt_hidden"`. Today that marker does not keep workers out of the app, because `thread/list` does not return it; workers drop out once a server returns it. The CLI ignores it. Start every Codex writer this way; restart a thread the watcher marks `MODEL(...)` on the configured model.
- `steer` adds to the active turn and fails when none is running; `last` prints the monitor's status line and the last agent messages.
- `end` once a writer's PR is merged or you stop the writer: it records that in the session's state file, then archives the thread so it leaves the operator's chat list. It refuses a thread with a running turn; never end a live writer. A later `turn` unarchives the thread first, and the recovery supervisor skips an ended session.
- Run Codex at high effort, never the maximum (it burns the limit for little gain), and never name a sub-agent model in a prompt; vibe's policy picks them.
- No computer use in Codex (browser, in-app browser, desktop app UI, screenshots): it is the fastest drain. Code host work goes through its CLI.
- Visual work is a request file a Codex session writes only through `scripts/request-visual.mjs` ([template](./templates.md#visual-request)); a Claude worker does it and you steer the findings back as text.
<!-- end: codex-sessions-rules -->
