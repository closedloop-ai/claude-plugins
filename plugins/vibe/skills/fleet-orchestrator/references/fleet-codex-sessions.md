# fleet-orchestrator: Codex sessions

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: codex-sessions-rules -->
`scripts/fleet.sh` drives a session on this machine (`local`) or on `REMOTE_HOST` (`remote`, which copies the scripts and the prompt file there first) through the managed Codex App Server.

```sh
scripts/fleet.sh <orchDir> local|remote session turn  <name> --prompt-file <file> [--cwd <worktree>] [--ticket <slug>] [--model <m>] [--effort <e>] [--sandbox <mode>]
scripts/fleet.sh <orchDir> local|remote session steer <name> --prompt-file <file>
scripts/fleet.sh <orchDir> local|remote session last  <name> [--count <n>]
scripts/fleet.sh <orchDir> local|remote session end   <name> --reason stopped|merged
scripts/fleet.sh <orchDir> local|remote session interrupt <name> --reason <why-reload-cannot-wait>
scripts/fleet.sh <orchDir> local|remote session reload <name> [--retry]
```

- `turn` starts/resumes one thread bound to its original worktree. New sessions require `$vibe`, a model and effort (defaults: `CODEX_MODEL`, `CODEX_EFFORT`). They join "Fleet workers" as `<name> · <ticket>` with `threadSource: "chatgpt_hidden"`; older servers still show them. A `MODEL(...)` watcher line requires the configured model.
- `steer` requires a running turn; `last` prints status and recent agent messages.
- On `SKILL-STALE <writer> <loaded> -> <installed>`, queue that writer's reload at its next milestone. Send `steer --prompt-file <file>` containing exactly `VIBE_SKILL_RELOAD v1` (one final newline allowed). No other instruction fits this envelope. Ordinary stale steers remain refused. An idle writer's next `turn` starts reload in place and retains its brief until loading finishes.
- `reload` fences the canonical worktree in existing machine slot locks through evidence completion. Jobs register before checking that fence; admitted jobs block reload. Heavy admission waits at most 60 seconds; E2E keeps its wait budget. Receipt scans resume; `--retry` preserves nonce/text. Retained work stays durable until confirmed delivery. Thread, worktree, branch, session record and board row survive.
- Use `interrupt` only when reload cannot wait. It records the reason, sends `turn/interrupt`, and confirms the turn stopped; unconfirmed stops remain visible failures. Resume with `turn`; never archive or replace the writer for reload.
- `end` records stopped/merged and archives only an idle thread; `turn` reopens it. Recovery skips ended sessions.
- On `PENDING-REMOTE`, run `fleet.sh <orchDir> remote session recover-marker <name>`; it checks remote state before publishing or clearing prepared ownership.
- Run high effort, never maximum; vibe chooses sub-agent models. No Codex computer use: use the code host CLI and `request-visual.mjs` ([template](./templates.md#visual-request)) for Claude visual checks.
<!-- end: codex-sessions-rules -->
